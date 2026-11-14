import { Controller, Get, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import { Prisma } from '../../../generated/prisma/client.js';
import { PublicError } from '../auth/errors.js';
import type { AuthService } from '../auth/service.js';
import { schema } from '../payments/orders.js';
import { ProfileService } from '../profiles/service.js';

const dayMs = 86_400_000;
const date = z.iso.date().refine(value => value >= '2000-01-01');
const currency = z.literal('LKR');
const environment = z.enum(['sandbox', 'live']);
const query = z.object({
  from: date.optional(), to: date.optional(), currency: currency.optional(), environment: environment.optional(),
}).strict();
const amount = z.string().regex(/^\d+$/);
const counts = z.object({
  requested: z.number().int().nonnegative(), agreed: z.number().int().nonnegative(),
  cancelled: z.number().int().nonnegative(), verifiedCompleted: z.number().int().nonnegative(),
});
const financial = z.object({
  serviceCapturedMinor: amount, depositCapturedMinor: amount, captureReviewMinor: amount,
  refundReservedMinor: amount, payoutReservedMinor: amount, feeReservedMinor: amount,
});
const activity = z.object({ bookings: counts, money: financial.nullable(), newUsers: z.number().int().nonnegative().nullable() });
const report = activity.extend({
  from: date, to: date, currency, environment,
  days: z.array(activity.extend({ date })),
  settled: z.object({ refundedMinor: z.null(), paidOutMinor: z.null(), feeRevenueMinor: z.null() }),
});

type BookingMetric = keyof z.infer<typeof counts>;
type MoneyMetric = keyof z.infer<typeof financial>;
type Fact = { day: string; metric: BookingMetric | MoneyMetric | 'newUsers'; total: string };
type Period = ReturnType<typeof analyticsPeriod>;

export function analyticsPeriod(raw: unknown, now = new Date()) {
  const result = query.safeParse(raw);
  if (!result.success) throw new PublicError(400, 'INVALID_ANALYTICS_FILTER', 'Choose UTC dates, LKR and a supported payment environment.');
  const to = new Date(result.data.to ?? new Date(now.getTime() + dayMs).toISOString().slice(0, 10));
  const from = result.data.from ? new Date(result.data.from) : new Date(to.getTime() - 30 * dayMs);
  const days = (to.getTime() - from.getTime()) / dayMs;
  if (days <= 0 || days > 366) throw new PublicError(400, 'INVALID_ANALYTICS_PERIOD', 'Choose an increasing date range of up to 366 days.');
  return { from, to, days, currency: 'LKR' as const, environment: result.data.environment ?? 'sandbox' };
}

async function bookingFacts(tx: Prisma.TransactionClient, period: Period, providerId?: string) {
  const provider = providerId ? Prisma.sql`AND b.provider_id = ${providerId}::uuid` : Prisma.empty;
  const userGrowth = providerId ? Prisma.empty : Prisma.sql`
    UNION ALL SELECT created_at, 'newUsers' FROM auth_users WHERE created_at >= ${period.from} AND created_at < ${period.to}`;
  return tx.$queryRaw<Fact[]>`
    WITH events(at, metric) AS (
      SELECT b.created_at, 'requested' FROM bookings b WHERE b.created_at >= ${period.from} AND b.created_at < ${period.to} ${provider}
      UNION ALL
      SELECT b.agreed_at, 'agreed' FROM bookings b WHERE b.agreed_at >= ${period.from} AND b.agreed_at < ${period.to} ${provider}
      UNION ALL
      SELECT b.cancelled_at, 'cancelled' FROM bookings b WHERE b.cancelled_at >= ${period.from} AND b.cancelled_at < ${period.to} ${provider}
      UNION ALL
      SELECT c.verified_at, 'verifiedCompleted' FROM booking_completions c JOIN bookings b ON b.id = c.booking_id
      WHERE c.verified_at >= ${period.from} AND c.verified_at < ${period.to} ${provider}
      ${userGrowth}
    )
    SELECT to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, metric, count(*)::text AS total
    FROM events GROUP BY 1, 2`;
}

async function financialFacts(tx: Prisma.TransactionClient, period: Period, providerId?: string) {
  if (period.environment !== 'sandbox') return [];
  const provider = providerId ? Prisma.sql`AND b.provider_id = ${providerId}::uuid` : Prisma.empty;
  return tx.$queryRaw<Fact[]>`
    WITH journal AS (
      SELECT id, source, posted_at, purpose FROM journal_transactions
      WHERE posted_at >= ${period.from} AND posted_at < ${period.to} AND currency = ${period.currency}
    ),
    captures AS (
      SELECT j.*, o.booking_id, o.id AS order_id
      FROM journal j
      JOIN payhere_events e ON e.journal_id = j.id
      JOIN payhere_attempts a ON a.id = e.attempt_id
      JOIN payment_orders o ON o.id = a.order_id
      WHERE j.source = 'payhere.sandbox.capture' AND e.status_code = '2'
      UNION ALL
      SELECT j.*, o.booking_id, o.id AS order_id
      FROM journal j
      JOIN stripe_attempts a ON a.journal_id = j.id
      JOIN payment_orders o ON o.id = a.order_id
      WHERE j.source = 'stripe.test.capture'
    ),
    events(at, booking_id, metric, minor) AS (
      SELECT c.posted_at, c.booking_id,
        CASE WHEN a.scope = 'sandbox:review:' || c.order_id THEN 'captureReviewMinor'
             WHEN c.purpose = 'deposit' THEN 'depositCapturedMinor'
             ELSE 'serviceCapturedMinor' END,
        e.amount_minor
      FROM captures c
      JOIN journal_entries e ON e.transaction_id = c.id AND e.amount_minor > 0
      JOIN financial_accounts a ON a.id = e.account_id AND a.kind = 'available'
        AND a.scope IN ('sandbox:review:' || c.order_id, 'sandbox:booking:' || c.booking_id)
      UNION ALL
      SELECT j.posted_at, p.booking_id, split.metric, split.minor
      FROM journal j JOIN payout_orders p ON p.reservation_id = j.id
      CROSS JOIN LATERAL (VALUES ('payoutReservedMinor', p.net_minor), ('feeReservedMinor', p.platform_fee_minor)) AS split(metric, minor)
      WHERE j.source = 'payout.sandbox.reserve'
      UNION ALL
      SELECT j.posted_at, o.booking_id, 'refundReservedMinor', r.amount_minor
      FROM journal j JOIN refund_items r ON r.reservation_id = j.id
      JOIN payment_orders o ON o.id = r.order_id
      WHERE j.source = 'refund.sandbox.reserve'
      UNION ALL
      SELECT j.posted_at, d.booking_id, split.metric, split.minor
      FROM journal j JOIN damage_claims d ON d.reservation_id = j.id
      CROSS JOIN LATERAL (VALUES ('refundReservedMinor', d.refund_minor), ('payoutReservedMinor', d.deduction_minor)) AS split(metric, minor)
      WHERE j.source = 'deposit.sandbox.reserve'
      UNION ALL
      SELECT j.posted_at, d.booking_id, split.metric, split.minor
      FROM journal j JOIN arbitration_decisions a ON a.reservation_id = j.id
      JOIN booking_disputes d ON d.id = a.dispute_id
      CROSS JOIN LATERAL (VALUES ('refundReservedMinor', a.refund_minor), ('payoutReservedMinor', a.payout_minor),
        ('feeReservedMinor', a.fee_minor)) AS split(metric, minor)
      WHERE j.source = 'arbitration.sandbox.reserve'
    )
    SELECT to_char(e.at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, e.metric, sum(e.minor)::text AS total
    FROM events e JOIN bookings b ON b.id = e.booking_id
    WHERE e.minor > 0 ${provider}
    GROUP BY 1, 2`;
}

function emptyActivity() {
  return {
    bookings: { requested: 0, agreed: 0, cancelled: 0, verifiedCompleted: 0 },
    money: {
      serviceCapturedMinor: 0n, depositCapturedMinor: 0n, captureReviewMinor: 0n,
      refundReservedMinor: 0n, payoutReservedMinor: 0n, feeReservedMinor: 0n,
    },
    newUsers: 0,
  };
}

type Activity = ReturnType<typeof emptyActivity>;

function addFact(activity: Activity, { metric, total }: Fact) {
  if (metric === 'newUsers') activity.newUsers += Number(total);
  else if (Object.hasOwn(activity.bookings, metric)) activity.bookings[metric as BookingMetric] += Number(total);
  else activity.money[metric as MoneyMetric] += BigInt(total);
}

export async function readAnalytics(tx: Prisma.TransactionClient, period: Period, providerId?: string) {
  const [bookings, money] = await Promise.all([bookingFacts(tx, period, providerId), financialFacts(tx, period, providerId)]);
  const total = emptyActivity();
  const days = new Map(Array.from({ length: period.days }, (_, index) =>
    [new Date(period.from.getTime() + index * dayMs).toISOString().slice(0, 10), emptyActivity()]));
  for (const fact of [...bookings, ...money]) {
    addFact(total, fact);
    addFact(days.get(fact.day)!, fact);
  }
  function present(activity: Activity) {
    return {
      bookings: activity.bookings,
      money: period.environment === 'sandbox'
        ? Object.fromEntries(Object.entries(activity.money).map(([key, value]) => [key, value.toString()])) : null,
      newUsers: providerId ? null : activity.newUsers,
    };
  }
  return {
    from: period.from.toISOString().slice(0, 10), to: period.to.toISOString().slice(0, 10),
    currency: period.currency, environment: period.environment, ...present(total),
    days: [...days].map(([date, activity]) => ({ date, ...present(activity) })),
    settled: { refundedMinor: null, paidOutMinor: null, feeRevenueMinor: null },
  };
}

function AnalyticsFilters() {
  return (target: object, key: string, descriptor: PropertyDescriptor) => {
    for (const name of ['from', 'to'] as const) ApiQuery({ name, required: false, type: String })(target, key, descriptor);
    ApiQuery({ name: 'currency', required: false, enum: ['LKR'] })(target, key, descriptor);
    ApiQuery({ name: 'environment', required: false, enum: environment.options })(target, key, descriptor);
  };
}

export function makeAnalyticsController(auth: AuthService) {
  const db = auth.deps.db;
  const profiles = new ProfileService(auth);

  @ApiTags('Analytics')
  @ApiBearerAuth()
  @Controller()
  class AnalyticsController {
    @Get('admin/analytics')
    @AnalyticsFilters()
    @ApiOkResponse({ schema: schema(report) })
    async admin(@Req() req: Request, @Query() raw: unknown) {
      const actor = await auth.authenticate(req.get('Authorization'));
      if (actor.session.activeRole !== 'admin') throw new PublicError(403, 'ROLE_FORBIDDEN', 'Administrator access is required.');
      profiles.verified(actor);
      const period = analyticsPeriod(raw);
      return db.$transaction(tx => readAnalytics(tx, period), { isolationLevel: 'RepeatableRead' });
    }

    @Get('me/analytics')
    @AnalyticsFilters()
    @ApiOkResponse({ schema: schema(report) })
    async provider(@Req() req: Request, @Query() raw: unknown) {
      const actor = await auth.authenticate(req.get('Authorization'));
      profiles.providerRole(actor);
      const period = analyticsPeriod(raw);
      return db.$transaction(tx => readAnalytics(tx, period, actor.user.id), { isolationLevel: 'RepeatableRead' });
    }
  }
  return AnalyticsController;
}
