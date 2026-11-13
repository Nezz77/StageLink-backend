import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOkResponse, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import type { Booking, BookingCheckIn, BookingCompletion, OvertimeProposal, Prisma } from '../../../generated/prisma/client.js';
import { PublicError } from '../auth/errors.js';
import type { AuthService } from '../auth/service.js';
import { ProfileService } from '../profiles/service.js';
import { parse, schema, uuid } from '../payments/orders.js';
import { agreementAmounts, completionAmounts, lockBooking, maxMinor, paidAdvance } from './lifecycle.js';
import { member } from './requests.js';

const timestamp = z.iso.datetime();
const revision = z.number().int().min(1).max(maxMinor);
const minor = z.number().int().min(0).max(maxMinor);
const confirm = z.object({ confirmed: z.literal(true) }).strict();
const verification = z.object({ reason: z.string().trim().min(1).max(500) }).strict();
const proposed = z.object({
  requestKey: uuid, minutes: z.number().int().min(1).max(1440), amountMinor: minor.min(100).max(100_000_000),
}).strict();
const outcome = z.enum(['accepted', 'declined']);
const decide = z.object({ decision: outcome }).strict();
const checkIn = z.object({ bookingId: uuid, recordedBy: uuid, recordedAt: timestamp, method: z.literal('manual') });
const completion = z.object({
  bookingId: uuid, reportedBy: uuid, reportedAt: timestamp, verifiedAt: timestamp.nullable(),
  originalMinor: minor, advanceMinor: minor, overtimeMinor: minor, overtimeMinutes: minor, balanceMinor: minor,
  platformFeeMinor: minor, currency: z.literal('LKR'),
});
const overtime = proposed.omit({ requestKey: true }).extend({
  id: uuid, bookingId: uuid, version: revision, proposedBy: uuid, createdAt: timestamp,
  status: z.enum(['pending', 'accepted', 'declined']), decidedBy: uuid.nullable(), decidedAt: timestamp.nullable(),
  currency: z.literal('LKR'),
});
const history = z.object({ items: z.array(overtime), nextVersion: revision.nullable() });
const journey = z.object({
  bookingId: uuid, startsAt: timestamp, endsAt: timestamp, agreed: z.boolean(), advancePaid: z.boolean(),
  checkIn: checkIn.nullable(), completion: completion.nullable(), overtimePending: z.boolean(),
});
const pageSize = 30;

function presentCheckIn(row: BookingCheckIn) {
  return { ...row, recordedAt: row.recordedAt.toISOString(), method: 'manual' as const };
}

function presentCompletion(row: BookingCompletion) {
  const { verifiedBy: _verifier, verificationReason: _reason, ...details } = row;
  return { ...details, reportedAt: row.reportedAt.toISOString(), verifiedAt: row.verifiedAt?.toISOString() ?? null, currency: 'LKR' as const };
}

function presentOvertime(row: OvertimeProposal) {
  const { requestKey: _key, decision, ...details } = row;
  return {
    ...details, createdAt: row.createdAt.toISOString(), decidedAt: row.decidedAt?.toISOString() ?? null,
    status: decision ?? 'pending', currency: 'LKR' as const,
  };
}

function providerOnly(booking: Booking, actorId: string) {
  if (actorId !== booking.providerId) throw new PublicError(403, 'PROVIDER_REQUIRED', 'The booking provider must record this step.');
}

async function requireAdvance(tx: Prisma.TransactionClient, booking: Booking) {
  if (!booking.agreedAt || !await paidAdvance(tx, booking.id)) {
    throw new PublicError(409, 'ADVANCE_REQUIRED', 'An agreed booking and paid advance are required.');
  }
}

function overtimeClosed(): never {
  throw new PublicError(409, 'OVERTIME_CLOSED', 'Overtime is available for checked-in gigs before completion is reported.');
}

export function makeCompletionController(auth: AuthService) {
  const db = auth.deps.db;
  const profiles = new ProfileService(auth);
  const identity = (req: Request) => auth.authenticate(req.get('Authorization'));

  async function write<T>(req: Request, bookingId: string, work: (tx: Prisma.TransactionClient, booking: Booking, actorId: string) => Promise<T>, admin = false) {
    if (req.get('Origin') !== auth.config.WEB_ORIGIN || req.get('Sec-Fetch-Site') === 'cross-site' || !req.is('application/json')) {
      throw new PublicError(403, 'ORIGIN_REJECTED', 'Open StageLink in its own browser tab and try again.');
    }
    const actor = await identity(req);
    profiles.checkCsrf(actor, req.get('X-CSRF-Token'));
    return db.$transaction(async tx => {
      const current = await profiles.actor(tx, actor, undefined, admin);
      profiles.verified(current);
      const actorId = current.user.id;
      if (!admin) await member(tx, bookingId, actorId);
      await lockBooking(tx, bookingId);
      const booking = await tx.booking.findUnique({ where: { id: bookingId } });
      if (!booking) throw new PublicError(404, 'BOOKING_NOT_FOUND', 'This booking is unavailable.');
      if (admin) {
        if (actorId === booking.providerId || actorId === booking.customerId) {
          throw new PublicError(403, 'SELF_REVIEW_FORBIDDEN', 'Another administrator must verify this completion.');
        }
        if (current.session.createdAt.getTime() < Date.now() - 15 * 60_000) {
          throw new PublicError(403, 'RECENT_LOGIN_REQUIRED', 'Sign in again before verifying completion.');
        }
      } else if (actorId === booking.providerId) {
        profiles.providerRole(current, booking.targetKind === 'gig' ? 'artist' : 'renter');
      } else if (!current.user.roles.includes('customer')) {
        throw new PublicError(403, 'ROLE_FORBIDDEN', 'A customer membership is required.');
      }
      return work(tx, booking, actorId);
    });
  }

  @ApiTags('Booking completion')
  @ApiBearerAuth()
  @Controller()
  class CompletionController {
    @Get('bookings/:id/journey')
    @ApiParam({ name: 'id', format: 'uuid' })
    @ApiOkResponse({ schema: schema(journey) })
    async journey(@Req() req: Request, @Param('id') id: string) {
      const { user } = await identity(req);
      return db.$transaction(async tx => {
        const booking = await member(tx, parse(uuid, id), user.id);
        const [arrival, report, advancePaid, pending] = await Promise.all([
          tx.bookingCheckIn.findUnique({ where: { bookingId: booking.id } }),
          tx.bookingCompletion.findUnique({ where: { bookingId: booking.id } }),
          paidAdvance(tx, booking.id),
          tx.overtimeProposal.findFirst({ where: { bookingId: booking.id, decision: null }, select: { id: true } }),
        ]);
        return {
          bookingId: booking.id, startsAt: booking.startsAt.toISOString(), endsAt: booking.endsAt.toISOString(),
          agreed: Boolean(booking.agreedAt), advancePaid, checkIn: arrival && presentCheckIn(arrival),
          completion: report && presentCompletion(report), overtimePending: Boolean(pending),
        };
      }, { isolationLevel: 'RepeatableRead' });
    }

    @Post('bookings/:id/check-ins')
    @HttpCode(200)
    @ApiParam({ name: 'id', format: 'uuid' })
    @ApiBody({ schema: schema(confirm) })
    @ApiOkResponse({ schema: schema(checkIn) })
    recordCheckIn(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
      parse(confirm, body);
      return write(req, parse(uuid, id), async (tx, booking, actorId) => {
        providerOnly(booking, actorId);
        const existing = await tx.bookingCheckIn.findUnique({ where: { bookingId: booking.id } });
        if (existing) return presentCheckIn(existing);
        const now = new Date();
        if (now < booking.startsAt || now >= booking.endsAt) {
          throw new PublicError(409, 'CHECK_IN_WINDOW_CLOSED', 'Check-in is available during the scheduled booking.');
        }
        await requireAdvance(tx, booking);
        return presentCheckIn(await tx.bookingCheckIn.create({
          data: { bookingId: booking.id, recordedBy: actorId, recordedAt: now },
        }));
      });
    }

    @Post('bookings/:id/overtime')
    @HttpCode(200)
    @ApiParam({ name: 'id', format: 'uuid' })
    @ApiBody({ schema: schema(proposed) })
    @ApiOkResponse({ schema: schema(overtime) })
    propose(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
      const input = parse(proposed, body);
      return write(req, parse(uuid, id), async (tx, booking, actorId) => {
        const existing = await tx.overtimeProposal.findUnique({
          where: { bookingId_requestKey: { bookingId: booking.id, requestKey: input.requestKey } },
        });
        if (existing) {
          if (existing.proposedBy !== actorId || existing.minutes !== input.minutes || existing.amountMinor !== input.amountMinor) {
            throw new PublicError(409, 'REQUEST_KEY_REUSED', 'Use a new request key for a different proposal.');
          }
          return presentOvertime(existing);
        }
        const now = new Date();
        const arrival = await tx.bookingCheckIn.findUnique({ where: { bookingId: booking.id } });
        const report = await tx.bookingCompletion.findUnique({ where: { bookingId: booking.id } });
        if (booking.targetKind !== 'gig' || now < booking.startsAt || !arrival || report) overtimeClosed();
        await requireAdvance(tx, booking);
        const latest = await tx.overtimeProposal.findFirst({ where: { bookingId: booking.id }, orderBy: { version: 'desc' } });
        if (latest && !latest.decision) throw new PublicError(409, 'OVERTIME_PENDING', 'Resolve the pending overtime proposal first.');
        const approved = await tx.overtimeProposal.aggregate({
          where: { bookingId: booking.id, decision: 'accepted' }, _sum: { amountMinor: true, minutes: true },
        });
        if ((approved._sum.minutes ?? 0) + input.minutes > 1440) {
          throw new PublicError(409, 'OVERTIME_DURATION_LIMIT', 'Approved overtime is limited to 24 hours per booking.');
        }
        completionAmounts(await agreementAmounts(tx, booking.id), (approved._sum.amountMinor ?? 0) + input.amountMinor);
        return presentOvertime(await tx.overtimeProposal.create({
          data: { ...input, bookingId: booking.id, proposedBy: actorId, createdAt: now, version: (latest?.version ?? 0) + 1 },
        }));
      });
    }

    @Get('bookings/:id/overtime')
    @ApiParam({ name: 'id', format: 'uuid' })
    @ApiQuery({ name: 'beforeVersion', type: Number, required: false })
    @ApiOkResponse({ schema: schema(history) })
    async overtimeHistory(@Req() req: Request, @Param('id') id: string, @Query('beforeVersion') before?: string) {
      const { user } = await identity(req);
      const booking = await member(db, parse(uuid, id), user.id);
      const cursor = before === undefined ? undefined : parse(z.string().regex(/^[1-9]\d{0,9}$/).transform(Number).pipe(revision), before);
      const rows = await db.overtimeProposal.findMany({
        where: { bookingId: booking.id, ...(cursor ? { version: { lt: cursor } } : {}) },
        orderBy: { version: 'desc' }, take: pageSize + 1,
      });
      const items = rows.slice(0, pageSize).map(presentOvertime);
      return { items, nextVersion: rows.length > pageSize ? items[pageSize - 1]!.version : null };
    }

    @Post('overtime/:id/decisions')
    @HttpCode(200)
    @ApiParam({ name: 'id', format: 'uuid' })
    @ApiBody({ schema: schema(decide) })
    @ApiOkResponse({ schema: schema(overtime) })
    async decide(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
      const proposalId = parse(uuid, id);
      const input = parse(decide, body);
      const { user } = await identity(req);
      const original = await db.overtimeProposal.findFirst({
        where: { id: proposalId, booking: { OR: [{ customerId: user.id }, { providerId: user.id }] } },
        select: { bookingId: true },
      });
      if (!original) throw new PublicError(404, 'OVERTIME_NOT_FOUND', 'This overtime proposal is unavailable.');
      return write(req, original.bookingId, async (tx, booking, actorId) => {
        const row = await tx.overtimeProposal.findUniqueOrThrow({ where: { id: proposalId } });
        if (row.proposedBy === actorId) throw new PublicError(403, 'SELF_DECISION', 'The other party must decide this proposal.');
        if (row.decidedBy === actorId && row.decision === input.decision) return presentOvertime(row);
        if (row.decision) throw new PublicError(409, 'OVERTIME_DECIDED', 'This overtime proposal already has a decision.');
        if (input.decision === 'accepted') await requireAdvance(tx, booking);
        return presentOvertime(await tx.overtimeProposal.update({
          where: { id: row.id }, data: { decision: input.decision, decidedBy: actorId, decidedAt: new Date() },
        }));
      });
    }

    @Post('bookings/:id/completion')
    @HttpCode(200)
    @ApiParam({ name: 'id', format: 'uuid' })
    @ApiBody({ schema: schema(confirm) })
    @ApiOkResponse({ schema: schema(completion) })
    report(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
      parse(confirm, body);
      return write(req, parse(uuid, id), async (tx, booking, actorId) => {
        providerOnly(booking, actorId);
        const existing = await tx.bookingCompletion.findUnique({ where: { bookingId: booking.id } });
        if (existing) return presentCompletion(existing);
        const now = new Date();
        const arrival = await tx.bookingCheckIn.findUnique({ where: { bookingId: booking.id } });
        if (!arrival || now < booking.endsAt) {
          throw new PublicError(409, 'COMPLETION_NOT_ELIGIBLE', 'A check-in and the end of the scheduled booking are required.');
        }
        await requireAdvance(tx, booking);
        const pending = await tx.overtimeProposal.findFirst({ where: { bookingId: booking.id, decision: null } });
        if (pending) throw new PublicError(409, 'OVERTIME_PENDING', 'Resolve the pending overtime proposal first.');
        const approved = await tx.overtimeProposal.aggregate({
          where: { bookingId: booking.id, decision: 'accepted' }, _sum: { amountMinor: true, minutes: true },
        });
        const overtimeMinutes = approved._sum.minutes ?? 0;
        if (now.getTime() < booking.endsAt.getTime() + overtimeMinutes * 60_000) {
          throw new PublicError(409, 'COMPLETION_NOT_ELIGIBLE', 'Wait until the approved overtime has ended.');
        }
        const totals = completionAmounts(await agreementAmounts(tx, booking.id), approved._sum.amountMinor ?? 0);
        return presentCompletion(await tx.bookingCompletion.create({
          data: { ...totals, overtimeMinutes, bookingId: booking.id, reportedBy: actorId, reportedAt: now },
        }));
      });
    }

    @Post('admin/bookings/:id/completion-verification')
    @HttpCode(200)
    @ApiParam({ name: 'id', format: 'uuid' })
    @ApiBody({ schema: schema(verification) })
    @ApiOkResponse({ schema: schema(completion) })
    verify(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
      const { reason } = parse(verification, body);
      return write(req, parse(uuid, id), async (tx, booking, actorId) => {
        const report = await tx.bookingCompletion.findUnique({ where: { bookingId: booking.id } });
        if (!report) throw new PublicError(409, 'COMPLETION_NOT_REPORTED', 'The provider must report completion first.');
        if (report.verifiedAt) return presentCompletion(report);
        return presentCompletion(await tx.bookingCompletion.update({
          where: { bookingId: booking.id },
          data: { verifiedAt: new Date(), verifiedBy: actorId, verificationReason: reason },
        }));
      }, true);
    }
  }
  return CompletionController;
}
