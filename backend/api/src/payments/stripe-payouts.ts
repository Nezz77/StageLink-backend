import { Body, Controller, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOkResponse, ApiParam, ApiTags } from '@nestjs/swagger';
import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { z } from 'zod';
import type { Prisma, StripePayoutTransfer } from '../../../generated/prisma/client.js';
import { openAccount, postedBalance, postJournal } from '../../../shared/payments/journal.js';
import { readStripeTestAccounts } from '../../../shared/payments/stripe-capabilities.js';
import { processStripePayoutTransfer, verifyStripeTransferCapture } from '../../../shared/payments/stripe-transfers.js';
import { PublicError } from '../auth/errors.js';
import type { AuthService, Identity } from '../auth/service.js';
import { lockBooking, paymentBlocked } from '../bookings/lifecycle.js';
import { ProfileService } from '../profiles/service.js';
import { parse, schema, uuid } from './orders.js';
import { assertPayoutProvider, payoutReservationAccount } from './payout-eligibility.js';

const command = z.object({ reconcileOnly: z.boolean().optional() }).strict();
const view = z.object({
  id: uuid, payoutId: uuid, destinationLinkId: uuid, amountMinor: z.number().int().positive(), currency: z.literal('LKR'),
  reversedMinor: z.number().int().nonnegative(),
  state: z.enum(['processing', 'uncertain', 'transferred', 'review_required']),
  providerTransferId: z.string().nullable(), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
});

const payoutInclude = {
  stripeTransfer: { include: { destination: true } },
  booking: { select: { customerId: true, providerId: true, targetKind: true } },
} satisfies Prisma.PayoutOrderInclude;

function present(row: StripePayoutTransfer) {
  const { id, payoutId, destinationLinkId, amountMinor, reversedMinor, status, providerTransferId, createdAt, updatedAt } = row;
  return {
    id, payoutId, destinationLinkId, amountMinor, reversedMinor, currency: 'LKR' as const, providerTransferId,
    state: row.leaseUntil && row.leaseUntil > new Date() ? 'processing' : status,
    createdAt: createdAt.toISOString(), updatedAt: updatedAt.toISOString(),
  };
}

function notEligible() {
  return new PublicError(409, 'STRIPE_TRANSFER_NOT_ELIGIBLE', 'Check the payout reservation, destination and Stripe test evidence.');
}

async function loadPayout(tx: Prisma.TransactionClient, id: string) {
  const row = await tx.payoutOrder.findUnique({ where: { id }, include: payoutInclude });
  if (!row) throw new PublicError(404, 'PAYOUT_NOT_FOUND', 'This payout reservation is unavailable.');
  return row;
}

type Payout = Awaited<ReturnType<typeof loadPayout>>;

function requireOperator(actor: Identity, payout: Payout) {
  if ([payout.booking.customerId, payout.providerId].includes(actor.user.id)) {
    throw new PublicError(403, 'SELF_REVIEW_FORBIDDEN', 'Another administrator must execute this transfer.');
  }
  if (Date.now() - actor.session.createdAt.getTime() >= 15 * 60_000) {
    throw new PublicError(403, 'RECENT_LOGIN_REQUIRED', 'Sign in again before managing the transfer.');
  }
}

async function submissionEvidence(tx: Prisma.TransactionClient, payout: Payout) {
  if (payout.netMinor <= 0 || payout.providerId !== payout.booking.providerId) return null;
  const [completion, hold, blocked, link, orders] = await Promise.all([
    tx.bookingCompletion.findUnique({ where: { bookingId: payout.bookingId } }),
    tx.bookingPayoutHold.findFirst({ where: { bookingId: payout.bookingId }, orderBy: { revision: 'desc' } }),
    paymentBlocked(tx, payout.bookingId),
    tx.stripePayoutDestinationLink.findFirst({
      where: { providerId: payout.providerId, destinationRevision: payout.destinationRevision, endedAt: null },
    }),
    tx.paymentOrder.findMany({
      where: { bookingId: payout.bookingId, purpose: { in: ['advance', 'balance'] } }, orderBy: { purpose: 'asc' },
      include: {
        payhereAttempt: { select: { id: true } },
        stripeAttempt: { include: { journal: { select: { postedAt: true, source: true, reference: true } } } },
      },
    }),
  ]);
  if (!completion?.verifiedAt || hold?.held || blocked || !link ||
    completion.advanceMinor + completion.balanceMinor !== payout.grossMinor ||
    completion.platformFeeMinor !== payout.platformFeeMinor ||
    payout.netMinor !== payout.grossMinor - payout.platformFeeMinor) return null;

  const amounts = { advance: completion.advanceMinor, balance: completion.balanceMinor, deposit: 0 };
  if (orders.length !== (amounts.balance > 0 ? 2 : 1)) return null;
  const captures = [];
  for (const order of orders) {
    const attempt = order.stripeAttempt;
    if (order.status !== 'paid' || order.currency !== 'LKR' || order.amountMinor !== amounts[order.purpose] ||
      order.payhereAttempt || !attempt?.sessionId || !attempt.journal?.postedAt ||
      attempt.journal.reference !== attempt.sessionId || attempt.journal.source !== 'stripe.test.capture') return null;
    captures.push({ id: attempt.id, sessionId: attempt.sessionId, amountMinor: order.amountMinor, expiresAt: attempt.expiresAt });
  }
  return { link, captures };
}

async function validProvider(tx: Prisma.TransactionClient, payout: Payout) {
  try {
    await assertPayoutProvider(tx, payout.booking, payout.destinationRevision);
    return true;
  } catch (error) {
    if (error instanceof PublicError && ['DESTINATION_NOT_APPROVED', 'PAYOUT_PROVIDER_VERIFICATION_REQUIRED'].includes(error.code)) return false;
    throw error;
  }
}

export function makeStripePayoutTransfersController(auth: AuthService) {
  const db = auth.deps.db;
  const config = auth.config;
  const profiles = new ProfileService(auth);

  async function admin(req: Request) {
    const actor = await auth.authenticate(req.get('Authorization'));
    if (actor.session.activeRole !== 'admin') throw new PublicError(403, 'ROLE_FORBIDDEN', 'Administrator access is required.');
    profiles.verified(actor);
    return actor;
  }

  @ApiTags('Stripe test payout transfers')
  @ApiBearerAuth()
  @Controller('admin/payouts/:id/stripe-transfer')
  class StripePayoutTransfersController {
    @Get()
    @ApiParam({ name: 'id', format: 'uuid' })
    @ApiOkResponse({ schema: schema(z.object({ transfer: view.nullable() })) })
    async read(@Req() req: Request, @Param('id') rawId: string) {
      await admin(req);
      const payout = await loadPayout(db, parse(uuid, rawId));
      return { transfer: payout.stripeTransfer ? present(payout.stripeTransfer) : null };
    }

    @Post()
    @HttpCode(200)
    @ApiParam({ name: 'id', format: 'uuid' })
    @ApiBody({ schema: schema(command) })
    @ApiOkResponse({ schema: schema(view) })
    async execute(@Req() req: Request, @Param('id') rawId: string, @Body() body: unknown) {
      if (req.get('Origin') !== config.WEB_ORIGIN || req.get('Sec-Fetch-Site') === 'cross-site' || !req.is('application/json')) {
        throw new PublicError(403, 'ORIGIN_REJECTED', 'Open StageLink in its own browser tab and try again.');
      }
      const actor = await admin(req);
      profiles.checkCsrf(actor, req.get('X-CSRF-Token'));
      const { reconcileOnly } = parse(command, body);
      const id = parse(uuid, rawId);
      const source = await loadPayout(db, id);
      requireOperator(actor, source);
      const prior = source.stripeTransfer;
      if (prior && ((!reconcileOnly && prior.status !== 'uncertain') || (prior.leaseUntil && prior.leaseUntil > new Date()))) {
        return present(prior);
      }
      if (!prior && reconcileOnly) throw new PublicError(409, 'STRIPE_TRANSFER_NOT_STARTED', 'Start the transfer before reconciling it.');
      const key = config.STRIPE_TEST_SECRET_KEY;
      const enabled = config.STRIPE_TEST_PAYOUT_TRANSFERS === 'true';
      if (!key || (!enabled && !prior)) {
        throw new PublicError(503, 'STRIPE_TRANSFERS_DISABLED', 'Stripe test transfer submission is unavailable.');
      }

      const candidate = enabled && !reconcileOnly && (!prior || prior.status === 'uncertain') ? await submissionEvidence(db, source) : null;
      const destination = prior?.destination ?? candidate?.link;
      if (!destination) throw notEligible();
      await auth.limits.check('stripe-payout-transfer-admin', actor.user.id, 10, 60);
      await auth.limits.check('stripe-payout-transfer-shared', 'shared', 20, 60);
      const remote = await readStripeTestAccounts(key, candidate?.link.id === destination.id ? destination.stripeAccountId : undefined);
      if (!remote || remote.platform.id !== destination.platformAccountId) throw notEligible();
      const stripeDestination = remote.destination;
      const funds = remote.funds.available.find(row => row.currency === 'lkr');
      const gatewayReady = candidate?.link.id === destination.id && stripeDestination?.controller?.is_controller === true &&
        stripeDestination.country === destination.accountCountry && stripeDestination.capabilities?.transfers === 'active' &&
        (funds?.source_types?.card ?? 0) >= source.netMinor;
      const canSubmit = Boolean(gatewayReady && candidate &&
        (await Promise.all(candidate.captures.map(capture => verifyStripeTransferCapture(key, capture)))).every(Boolean));

      const claim = await db.$transaction(async tx => {
        for (const userId of [...new Set([actor.user.id, source.providerId])].sort()) {
          await tx.$queryRaw`SELECT id FROM auth_users WHERE id=${userId}::uuid FOR UPDATE`;
        }
        const operator = await profiles.actor(tx, actor, undefined, true);
        profiles.verified(operator);
        await lockBooking(tx, source.bookingId);
        const payout = await loadPayout(tx, id);
        requireOperator(operator, payout);
        const existing = payout.stripeTransfer;
        const now = new Date();
        if (existing && ((!reconcileOnly && existing.status !== 'uncertain') || (existing.leaseUntil && existing.leaseUntil > now))) {
          return { response: present(existing) };
        }
        if (existing && existing.destinationLinkId !== destination.id) throw notEligible();

        const current = canSubmit ? await submissionEvidence(tx, payout) : null;
        const same = current && candidate && current.link.id === destination.id &&
          JSON.stringify(current.captures) === JSON.stringify(candidate.captures);
        const account = same && await validProvider(tx, payout) ? await payoutReservationAccount(tx, payout) : null;
        const reserved = account && await postedBalance(tx, account) >= BigInt(payout.netMinor) ? account : null;
        const allowSubmission = Boolean(reserved && (!existing || reserved === existing.reservedAccountId));
        if (!existing && !reserved) throw notEligible();

        const lease = { leaseId: randomUUID(), leaseUntil: new Date(now.getTime() + 30_000), updatedAt: now };
        const record = existing
          ? await tx.stripePayoutTransfer.update({ where: { id: existing.id }, data: lease })
          : await tx.stripePayoutTransfer.create({ data: {
            payoutId: id, destinationLinkId: destination.id, actorId: operator.user.id,
            reservedAccountId: reserved!, amountMinor: payout.netMinor, ...lease,
          } });
        return { record, leaseId: lease.leaseId, submission: allowSubmission ? existing ? 'retry' as const : 'first' as const : false as const };
      });
      if (claim.response) return claim.response;

      const result = await processStripePayoutTransfer(key, {
        ...claim.record, stripeAccountId: destination.stripeAccountId,
      }, claim.submission);
      return db.$transaction(async tx => {
        await lockBooking(tx, source.bookingId);
        const current = await tx.stripePayoutTransfer.findUniqueOrThrow({ where: { id: claim.record.id } });
        if (current.leaseId !== claim.leaseId) return present(current);

        const confirmed = result && result.reversedMinor >= current.reversedMinor &&
          (current.status !== 'review_required' || result.reversedMinor > 0) ? result : null;
        const reversedMinor = confirmed?.reversedMinor ?? current.reversedMinor;
        const returned = reversedMinor - current.reversedMinor;
        let journalId = current.journalId;
        if (confirmed && (!journalId || returned > 0)) {
          const fund = { currency: 'LKR', purpose: 'service' } as const;
          const clearing = await openAccount(tx, { ...fund, scope: 'gateway:stripe:test', kind: 'clearing' });
          if (!journalId) {
            const amount = BigInt(current.amountMinor);
            journalId = await postJournal(tx, { ...fund, source: 'stripe.test.payout.transfer', reference: confirmed.id }, [
              { accountId: current.reservedAccountId, amountMinor: -amount }, { accountId: clearing.id, amountMinor: amount },
            ]);
          }
          if (returned > 0) {
            const amount = BigInt(returned);
            await postJournal(tx, {
              ...fund, source: 'stripe.test.payout.transfer_reversal', reference: current.id + ':' + reversedMinor,
            }, [
              { accountId: clearing.id, amountMinor: -amount }, { accountId: current.reservedAccountId, amountMinor: amount },
            ]);
          }
        }
        const status = confirmed ? reversedMinor > 0 ? 'review_required' : 'transferred' : current.status;
        return present(await tx.stripePayoutTransfer.update({
          where: { id: current.id }, data: {
            status, journalId, reversedMinor, providerTransferId: confirmed?.id ?? current.providerTransferId,
            leaseId: null, leaseUntil: null, updatedAt: new Date(),
          },
        }));
      });
    }
  }
  return StripePayoutTransfersController;
}
