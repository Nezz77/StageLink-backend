import { Body, Controller, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOkResponse, ApiParam, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import type { Prisma, StripeArbitrationFeeSettlement } from '../../../generated/prisma/client.js';
import { notifyUsers } from '../../../shared/notifications.js';
import { openAccount, postJournal } from '../../../shared/payments/journal.js';
import { inspectStripeTransferCapture } from '../../../shared/payments/stripe-transfers.js';
import { PublicError } from '../auth/errors.js';
import type { AuthService, Identity } from '../auth/service.js';
import { lockBooking } from '../bookings/lifecycle.js';
import { ProfileService } from '../profiles/service.js';
import { parse, schema, uuid } from './orders.js';
import { approvedStripeArbitration, payoutBlocked } from './payout-eligibility.js';
import { findReservedFunds } from './refund-reservations.js';

const empty = z.object({}).strict();
const view = z.object({
  arbitrationId: uuid, amountMinor: z.number().int().positive(), actorId: uuid, journalId: uuid,
  reversalJournalId: uuid.nullable(), reviewActorId: uuid.nullable(), state: z.enum(['settled', 'review_required']),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
});
const result = z.object({ evidence: z.enum(['verified', 'unavailable', 'review_required']), settlement: view.nullable() });
const fund = { currency: 'LKR', purpose: 'service' } as const;

function present(row: StripeArbitrationFeeSettlement) {
  return { ...row, state: row.reversalJournalId ? 'review_required' : 'settled',
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
}

function notEligible() {
  return new PublicError(409, 'STRIPE_ARBITRATION_FEE_NOT_ELIGIBLE', 'Review the arbitration fee allocation, customer refunds and payment controls.');
}

export function makeStripeArbitrationFeesController(auth: AuthService) {
  const db = auth.deps.db;
  const profiles = new ProfileService(auth);

  async function admin(req: Request) {
    const actor = await auth.authenticate(req.get('Authorization'));
    if (actor.session.activeRole !== 'admin') throw new PublicError(403, 'ROLE_FORBIDDEN', 'Administrator access is required.');
    profiles.verified(actor);
    return actor;
  }

  async function review(tx: Prisma.TransactionClient, actor: Identity, arbitrationId: string) {
    const original = await tx.arbitrationDecision.findUnique({
      where: { id: arbitrationId },
      select: { dispute: { select: { bookingId: true, booking: { select: { providerId: true } } } } },
    });
    if (!original) throw new PublicError(404, 'ARBITRATION_NOT_FOUND', 'This arbitration decision is unavailable.');
    for (const id of [...new Set([actor.user.id, original.dispute.booking.providerId])].sort()) {
      await tx.$queryRaw`SELECT id FROM auth_users WHERE id=${id}::uuid FOR UPDATE`;
    }
    const operator = await profiles.actor(tx, actor, undefined, true);
    profiles.verified(operator);
    if (operator.session.createdAt.getTime() < Date.now() - 15 * 60_000) {
      throw new PublicError(403, 'RECENT_LOGIN_REQUIRED', 'Sign in again before settling the arbitration fee.');
    }
    await lockBooking(tx, original.dispute.bookingId);
    const booking = await tx.booking.findUniqueOrThrow({ where: { id: original.dispute.bookingId } });
    if ([booking.customerId, booking.providerId].includes(operator.user.id)) {
      throw new PublicError(403, 'SELF_REVIEW_FORBIDDEN', 'Another administrator must settle this arbitration fee.');
    }
    const award = await approvedStripeArbitration(tx, arbitrationId, booking.id);
    if (!award || award.decision.payoutMinor !== 0 || award.decision.feeMinor <= 0) throw notEligible();
    const current = await tx.stripeArbitrationFeeSettlement.findUnique({ where: { arbitrationId } });
    if (!current && await payoutBlocked(tx, booking.id, arbitrationId)) throw notEligible();
    return { award, current, booking, actorId: operator.user.id };
  }

  @ApiTags('Stripe test arbitration fee settlement')
  @ApiBearerAuth()
  @Controller('admin/arbitrations/:id/stripe-fee')
  class StripeArbitrationFeesController {
    @Get()
    @ApiParam({ name: 'id', format: 'uuid' })
    @ApiOkResponse({ schema: schema(z.object({ settlement: view.nullable() })) })
    async read(@Req() req: Request, @Param('id') id: string) {
      await admin(req);
      const arbitrationId = parse(uuid, id);
      if (!await db.arbitrationDecision.count({ where: { id: arbitrationId } })) {
        throw new PublicError(404, 'ARBITRATION_NOT_FOUND', 'This arbitration decision is unavailable.');
      }
      const row = await db.stripeArbitrationFeeSettlement.findUnique({ where: { arbitrationId } });
      return { settlement: row ? present(row) : null };
    }

    @Post()
    @HttpCode(200)
    @ApiParam({ name: 'id', format: 'uuid' })
    @ApiBody({ schema: schema(empty) })
    @ApiOkResponse({ schema: schema(result) })
    async settle(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
      if (req.get('Origin') !== auth.config.WEB_ORIGIN || req.get('Sec-Fetch-Site') === 'cross-site' || !req.is('application/json')) {
        throw new PublicError(403, 'ORIGIN_REJECTED', 'Open StageLink in its own browser tab and try again.');
      }
      const actor = await admin(req);
      profiles.checkCsrf(actor, req.get('X-CSRF-Token'));
      parse(empty, body);
      const arbitrationId = parse(uuid, id);
      const source = await db.$transaction(tx => review(tx, actor, arbitrationId));
      if (source.current?.reversalJournalId) return { evidence: 'review_required', settlement: present(source.current) };
      const key = auth.config.STRIPE_TEST_SECRET_KEY;
      if (!key || (auth.config.STRIPE_TEST_PAYOUT_TRANSFERS !== 'true' && !source.current)) {
        throw new PublicError(503, 'STRIPE_TRANSFERS_DISABLED', 'Stripe test fee settlement is unavailable.');
      }
      await auth.limits.check('stripe-arbitration-fee-admin', actor.user.id, 10, 60);
      await auth.limits.check('stripe-arbitration-fee-shared', 'shared', 20, 60);
      const observations = await Promise.all(source.award.captures.map(capture => inspectStripeTransferCapture(key, capture)));
      const evidence = observations.includes('review_required') ? 'review_required'
        : observations.every(value => value === 'verified') ? 'verified' : 'unavailable';
      const settlement = await db.$transaction(async tx => {
        const { award, booking, actorId, current } = await review(tx, actor, arbitrationId);
        if (award.decision.feeMinor !== source.award.decision.feeMinor ||
          JSON.stringify(award.captures) !== JSON.stringify(source.award.captures)) throw notEligible();
        if (current?.reversalJournalId) return current;
        if (evidence === 'review_required' && current) {
          const journal = await tx.journalTransaction.findUniqueOrThrow({ where: { id: current.journalId }, include: { entries: true } });
          const reversalJournalId = await postJournal(tx, { ...fund, source: 'stripe.test.arbitration.fee.reversal', reference: arbitrationId },
            journal.entries.map(entry => ({ accountId: entry.accountId, amountMinor: -entry.amountMinor })));
          await notifyUsers(tx, [booking.customerId, booking.providerId], 'arbitration', booking.id, 'stripe-fee-reversal:' + arbitrationId);
          return tx.stripeArbitrationFeeSettlement.update({
            where: { arbitrationId }, data: { reversalJournalId, reviewActorId: actorId, updatedAt: new Date() },
          });
        }
        if (evidence !== 'verified' || current) return current;
        const reserved = await findReservedFunds(tx, award.decision.reservationId, {
          ...fund, source: 'arbitration.sandbox.reserve', reference: award.decision.disputeId,
          scope: 'sandbox:arbitration:' + arbitrationId + ':fee',
        }, award.decision.feeMinor);
        if (!reserved) throw notEligible();
        const revenue = await openAccount(tx, { ...fund, scope: 'platform:stripe:test:fees', kind: 'available' });
        const amount = BigInt(award.decision.feeMinor);
        const journalId = await postJournal(tx, { ...fund, source: 'stripe.test.arbitration.fee.settle', reference: arbitrationId }, [
          { accountId: reserved.accountId, amountMinor: -amount }, { accountId: revenue.id, amountMinor: amount },
        ]);
        await notifyUsers(tx, [booking.customerId, booking.providerId], 'arbitration', booking.id, 'stripe-fee:' + arbitrationId);
        return tx.stripeArbitrationFeeSettlement.create({ data: { arbitrationId, actorId, amountMinor: award.decision.feeMinor, journalId } });
      });
      return { evidence, settlement: settlement ? present(settlement) : null };
    }
  }
  return StripeArbitrationFeesController;
}
