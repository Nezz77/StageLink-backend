import { Body, Controller, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOkResponse, ApiParam, ApiTags, type SchemaObject } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import type { PaymentOrder, Prisma } from '../../../generated/prisma/client.js';
import type { AuthService, Identity } from '../auth/service.js';
import { PublicError } from '../auth/errors.js';
import { agreementAmounts, lockBooking, paidAdvance } from '../bookings/lifecycle.js';
import { member } from '../bookings/requests.js';
import { ProfileService } from '../profiles/service.js';

export const uuid = z.string().uuid();
const purpose = z.enum(['advance', 'balance', 'deposit']);
const create = z.object({ purpose }).strict();
const minor = z.number().int().min(0).max(2_147_483_647);
const order = z.object({
  id: uuid, bookingId: uuid, purpose, amountMinor: minor.positive(), currency: z.literal('LKR'),
  status: z.enum(['open', 'pending', 'failed', 'cancelled', 'paid', 'review']), createdAt: z.iso.datetime(),
});
const page = z.object({ items: z.array(order) });
export const schema = (value: z.ZodType) => z.toJSONSchema(value, { target: 'openapi-3.0' }) as SchemaObject;

export function parse<T>(type: z.ZodType<T>, value: unknown): T {
  const parsed = type.safeParse(value);
  if (!parsed.success) throw new PublicError(400, 'INVALID_PAYMENT_INPUT', 'Check the payment details.');
  return parsed.data;
}

export function presentOrder(record: PaymentOrder) {
  return { ...record, createdAt: record.createdAt.toISOString() };
}

export async function readOrder(db: Prisma.TransactionClient, id: string, userId: string) {
  const record = await db.paymentOrder.findFirst({
    where: { id, booking: { OR: [{ customerId: userId }, { providerId: userId }] } },
    include: { booking: true },
  });
  if (!record) throw new PublicError(404, 'PAYMENT_ORDER_NOT_FOUND', 'This payment order is unavailable.');
  return record;
}

export function paymentAccess(auth: AuthService) {
  const profiles = new ProfileService(auth);
  const identity = (req: Request) => auth.authenticate(req.get('Authorization'));
  return {
    identity,
    async write<T>(req: Request, work: (tx: Prisma.TransactionClient, actor: Identity) => Promise<T>) {
      if (req.get('Origin') !== auth.config.WEB_ORIGIN || req.get('Sec-Fetch-Site') === 'cross-site' || !req.is('application/json')) {
        throw new PublicError(403, 'ORIGIN_REJECTED', 'Open StageLink in its own browser tab and try again.');
      }
      const actor = await identity(req);
      profiles.checkCsrf(actor, req.get('X-CSRF-Token'));
      return auth.deps.db.$transaction(async tx => {
        const current = await profiles.actor(tx, actor);
        if (!current.user.roles.includes('customer')) throw new PublicError(403, 'ROLE_FORBIDDEN', 'A customer membership is required.');
        profiles.verified(current);
        return work(tx, current);
      });
    },
  };
}

export function makePaymentOrdersController(auth: AuthService) {
  const db = auth.deps.db;
  const access = paymentAccess(auth);

  @ApiTags('Payment orders')
  @ApiBearerAuth()
  @Controller()
  class PaymentOrdersController {
    @Post('bookings/:id/payment-orders')
    @HttpCode(200)
    @ApiParam({ name: 'id', format: 'uuid' })
    @ApiBody({ schema: schema(create) })
    @ApiOkResponse({ schema: schema(order) })
    create(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
      const bookingId = parse(uuid, id);
      const { purpose } = parse(create, body);
      return access.write(req, async (tx, actor) => {
        const booking = await member(tx, bookingId, actor.user.id);
        if (booking.customerId !== actor.user.id) throw new PublicError(403, 'PAYMENT_CUSTOMER_REQUIRED', 'Only the booking customer can create a payment order.');
        await lockBooking(tx, booking.id);
        const where = { bookingId_purpose: { bookingId, purpose } };
        const existing = await tx.paymentOrder.findUnique({ where });
        if (existing) return presentOrder(existing);
        let amountMinor: number;
        if (purpose === 'balance') {
          const report = await tx.bookingCompletion.findUnique({ where: { bookingId } });
          if (!report || !await paidAdvance(tx, bookingId)) {
            throw new PublicError(409, 'BALANCE_NOT_DUE', 'Balance collection requires reported completion and a paid advance.');
          }
          amountMinor = report.balanceMinor;
        } else {
          if (!booking.agreedAt || booking.startsAt <= new Date()) {
            throw new PublicError(409, 'PAYMENT_NOT_ELIGIBLE', 'An upcoming booking agreement is required.');
          }
          const terms = await agreementAmounts(tx, bookingId);
          amountMinor = purpose === 'advance' ? terms.serviceAdvanceMinor : terms.depositMinor;
        }
        if (amountMinor === 0) throw new PublicError(409, 'PAYMENT_NOT_DUE', 'No payment is due for this purpose.');
        return presentOrder(await tx.paymentOrder.create({ data: { bookingId, purpose, amountMinor, currency: 'LKR' } }));
      });
    }

    @Get('bookings/:id/payment-orders')
    @ApiParam({ name: 'id', format: 'uuid' })
    @ApiOkResponse({ schema: schema(page) })
    async list(@Req() req: Request, @Param('id') id: string) {
      const { user } = await access.identity(req);
      const booking = await member(db, parse(uuid, id), user.id);
      const records = await db.paymentOrder.findMany({ where: { bookingId: booking.id }, orderBy: { purpose: 'asc' } });
      return { items: records.map(presentOrder) };
    }

    @Get('payment-orders/:id')
    @ApiParam({ name: 'id', format: 'uuid' })
    @ApiOkResponse({ schema: schema(order) })
    async get(@Req() req: Request, @Param('id') id: string) {
      const { user } = await access.identity(req);
      const { booking: _booking, ...record } = await readOrder(db, parse(uuid, id), user.id);
      return presentOrder(record);
    }
  }
  return PaymentOrdersController;
}
