import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOkResponse, ApiParam, ApiQuery, ApiTags, type SchemaObject } from '@nestjs/swagger';
import { createHash } from 'node:crypto';
import type { Request } from 'express';
import { z } from 'zod';
import type { Booking, BookingAgreement, BookingQuotation, Prisma } from '../../../generated/prisma/client.js';
import type { AuthService } from '../auth/service.js';
import { PublicError } from '../auth/errors.js';
import { ProfileService } from '../profiles/service.js';
import { depositPolicy } from '../catalog/deposit-policy.js';
import { member, recheckReservation } from './requests.js';
import { snapshot } from './selection.js';

const uuid = z.string().uuid();
const revision = z.number().int().min(1).max(2_147_483_647);
const timestamp = z.iso.datetime();
const lines = z.array(z.object({
  description: z.string().trim().min(1).max(160),
  quantity: z.number().int().min(1).max(100_000),
  unitPriceMinor: z.number().int().min(0).max(100_000_000),
}).strict()).min(1).max(30);
const offer = z.object({ revision, lines, terms: z.string().trim().min(1).max(4000) }).strict();
const outcome = z.enum(['accepted', 'declined']);
const decision = z.object({ revision, decision: outcome }).strict();
const quotation = offer.omit({ revision: true }).extend({
  id: uuid, bookingId: uuid, version: revision, authorId: uuid, totalMinor: revision, currency: z.literal('LKR'),
  createdAt: timestamp, decidedAt: timestamp.nullable(), decidedBy: uuid.nullable(), decision: outcome.nullable(),
  status: z.enum(['pending', 'superseded', 'accepted', 'declined', 'expired']),
});
const agreement = z.object({
  id: uuid, bookingId: uuid, quotationId: uuid, digest: z.string().regex(/^[a-f0-9]{64}$/),
  algorithm: z.literal('SHA-256'), createdAt: timestamp,
});
const artifact = agreement.extend({ artifact: z.string() });
const result = z.object({ quotation, bookingRevision: revision, agreement: agreement.nullable() });
const list = z.object({ items: z.array(quotation), bookingRevision: revision, nextVersion: revision.nullable() });
const schema = (value: z.ZodType) => z.toJSONSchema(value, { target: 'openapi-3.0' }) as SchemaObject;
const pageSize = 30;

function parse<T>(type: z.ZodType<T>, value: unknown): T {
  const result = type.safeParse(value);
  if (!result.success) throw new PublicError(400, 'INVALID_QUOTATION', 'Check the quotation lines, terms or booking revision.');
  return result.data;
}

function requireOpen(booking: Booking, expected: number, now: Date) {
  if (booking.revision !== expected) throw new PublicError(409, 'BOOKING_CHANGED', 'Reload the booking before negotiating.');
  if (booking.providerDecision !== 'accepted' || booking.agreedAt || booking.holdExpiresAt <= now) {
    throw new PublicError(409, 'NEGOTIATION_CLOSED', 'The booking needs a live, accepted hold for negotiation.');
  }
}

function presentQuote(record: BookingQuotation, latest: number, booking: Booking, now: Date) {
  return {
    id: record.id, bookingId: record.bookingId, version: record.version, authorId: record.authorId,
    lines: lines.parse(record.lines), terms: record.terms, totalMinor: record.totalMinor, currency: 'LKR',
    createdAt: record.createdAt.toISOString(), decidedAt: record.decidedAt?.toISOString() ?? null,
    decidedBy: record.decidedBy, decision: record.decision,
    status: record.decision ?? (record.version < latest ? 'superseded' : booking.holdExpiresAt <= now ? 'expired' : 'pending'),
  };
}

function presentAgreement(record: BookingAgreement) {
  const { id, bookingId, quotationId, digest, createdAt } = record;
  return { id, bookingId, quotationId, digest, algorithm: 'SHA-256', createdAt: createdAt.toISOString() };
}

export function makeQuotationsController(auth: AuthService) {
  const db = auth.deps.db;
  const profiles = new ProfileService(auth);
  const identity = (req: Request) => auth.authenticate(req.get('Authorization'));

  async function write<T>(req: Request, bookingId: string, work: (tx: Prisma.TransactionClient, booking: Booking, actorId: string) => Promise<T>) {
    if (req.get('Origin') !== auth.config.WEB_ORIGIN || req.get('Sec-Fetch-Site') === 'cross-site' || !req.is('application/json')) {
      throw new PublicError(403, 'ORIGIN_REJECTED', 'Open StageLink in its own browser tab and try again.');
    }
    const actor = await identity(req);
    profiles.checkCsrf(actor, req.get('X-CSRF-Token'));
    const existing = await member(db, bookingId, actor.user.id);
    return db.$transaction(async tx => {
      for (const id of [existing.customerId, existing.providerId].sort()) {
        await tx.$queryRaw`SELECT id FROM auth_users WHERE id=${id}::uuid FOR UPDATE`;
      }
      const current = await profiles.actor(tx, actor);
      profiles.verified(current);
      if (current.user.id === existing.providerId) profiles.providerRole(current, existing.targetKind === 'gig' ? 'artist' : 'renter');
      else if (!current.user.roles.includes('customer')) throw new PublicError(403, 'ROLE_FORBIDDEN', 'A customer membership is required.');
      return work(tx, await member(tx, bookingId, current.user.id), current.user.id);
    });
  }

  @ApiTags('Booking negotiations')
  @ApiBearerAuth()
  @Controller()
  class QuotationsController {
    @Post('bookings/:id/quotations')
    @HttpCode(200)
    @ApiParam({ name: 'id', format: 'uuid' })
    @ApiBody({ schema: schema(offer) })
    @ApiOkResponse({ schema: schema(result) })
    create(@Req() req: Request, @Param('id') id: string, @Body() raw: unknown) {
      const input = parse(offer, raw);
      const totalMinor = input.lines.reduce((sum, line) => sum + line.quantity * line.unitPriceMinor, 0);
      if (totalMinor < 1 || totalMinor > 2_147_483_647) throw new PublicError(400, 'QUOTATION_TOTAL_INVALID', 'Enter a positive quotation total within the LKR limit.');
      return write(req, parse(uuid, id), async (tx, booking, actorId) => {
        const now = new Date();
        requireOpen(booking, input.revision, now);
        const latest = await tx.bookingQuotation.findFirst({ where: { bookingId: booking.id }, orderBy: { version: 'desc' } });
        if (!latest && actorId !== booking.providerId) throw new PublicError(403, 'PROVIDER_OFFER_REQUIRED', 'The provider must send the first quotation.');
        const version = (latest?.version ?? 0) + 1;
        const created = await tx.bookingQuotation.create({
          data: { bookingId: booking.id, version, authorId: actorId, lines: input.lines, terms: input.terms, totalMinor },
        });
        const updated = await tx.booking.update({ where: { id: booking.id }, data: { revision: { increment: 1 } } });
        return { quotation: presentQuote(created, version, updated, now), bookingRevision: updated.revision, agreement: null };
      });
    }

    @Get('bookings/:id/quotations')
    @ApiParam({ name: 'id', format: 'uuid' })
    @ApiQuery({ name: 'beforeVersion', required: false, type: Number })
    @ApiOkResponse({ schema: schema(list) })
    async history(@Req() req: Request, @Param('id') id: string, @Query('beforeVersion') before?: string) {
      const { user } = await identity(req);
      const bookingId = parse(uuid, id);
      const cursor = before === undefined ? undefined : parse(z.string().regex(/^[1-9][0-9]{0,9}$/).transform(Number).pipe(revision), before);
      return db.$transaction(async tx => {
        const booking = await member(tx, bookingId, user.id);
        const latest = await tx.bookingQuotation.aggregate({ where: { bookingId }, _max: { version: true } });
        const records = await tx.bookingQuotation.findMany({
          where: { bookingId, ...(cursor ? { version: { lt: cursor } } : {}) }, orderBy: { version: 'desc' }, take: pageSize + 1,
        });
        const now = new Date();
        const items = records.slice(0, pageSize).map(row => presentQuote(row, latest._max.version ?? 0, booking, now));
        return { items, bookingRevision: booking.revision, nextVersion: records.length > pageSize ? items[pageSize - 1]!.version : null };
      }, { isolationLevel: 'RepeatableRead' });
    }

    @Post('quotations/:id/decisions')
    @HttpCode(200)
    @ApiParam({ name: 'id', format: 'uuid' })
    @ApiBody({ schema: schema(decision) })
    @ApiOkResponse({ schema: schema(result) })
    async decide(@Req() req: Request, @Param('id') id: string, @Body() raw: unknown) {
      const quotationId = parse(uuid, id);
      const input = parse(decision, raw);
      const { user } = await identity(req);
      const original = await db.bookingQuotation.findFirst({
        where: { id: quotationId, booking: { OR: [{ customerId: user.id }, { providerId: user.id }] } },
        select: { bookingId: true },
      });
      if (!original) throw new PublicError(404, 'QUOTATION_NOT_FOUND', 'This quotation is unavailable.');
      return write(req, original.bookingId, async (tx, booking, actorId) => {
        const now = new Date();
        requireOpen(booking, input.revision, now);
        const latest = await tx.bookingQuotation.findFirst({ where: { bookingId: booking.id }, orderBy: { version: 'desc' } });
        if (!latest || latest.id !== quotationId || latest.decision) throw new PublicError(409, 'QUOTATION_CHANGED', 'Choose the latest pending quotation.');
        if (latest.authorId === actorId) throw new PublicError(403, 'SELF_DECISION', 'The other party must decide this quotation.');
        const accepted = input.decision === 'accepted';
        if (accepted) await recheckReservation(tx, booking, now);
        const decided = await tx.bookingQuotation.update({
          where: { id: quotationId }, data: { decidedAt: now, decidedBy: actorId, decision: input.decision },
        });
        const updated = await tx.booking.update({
          where: { id: booking.id }, data: { revision: { increment: 1 }, ...(accepted ? { agreedAt: now } : {}) },
        });
        let evidence = null;
        if (accepted) {
          const policy = depositPolicy.parse(snapshot.parse(booking.snapshot).depositPolicy);
          const depositMinor = policy.mode === 'none' ? 0 : policy.mode === 'fixed' ? policy.amountMinor
            : Number((BigInt(latest.totalMinor) * BigInt(policy.basisPoints) + 5000n) / 10000n);
          const content = JSON.stringify({
            version: 1, bookingId: booking.id, quotationId, quotationVersion: latest.version,
            customerId: booking.customerId, providerId: booking.providerId, offeredBy: latest.authorId, acceptedBy: actorId,
            startsAt: booking.startsAt.toISOString(), endsAt: booking.endsAt.toISOString(), acceptedAt: now.toISOString(),
            listingVersion: booking.targetVersion, listing: snapshot.parse(booking.snapshot),
            currency: 'LKR', lines: lines.parse(latest.lines), terms: latest.terms, totalMinor: latest.totalMinor,
            serviceAdvanceMinor: Math.round(latest.totalMinor / 2), depositMinor,
          });
          evidence = presentAgreement(await tx.bookingAgreement.create({
            data: { bookingId: booking.id, quotationId, artifact: content, digest: createHash('sha256').update(content).digest('hex'), createdAt: now },
          }));
        }
        return { quotation: presentQuote(decided, latest.version, updated, now), bookingRevision: updated.revision, agreement: evidence };
      });
    }

    @Get('bookings/:id/agreement')
    @ApiParam({ name: 'id', format: 'uuid' })
    @ApiOkResponse({ schema: schema(agreement) })
    async agreement(@Req() req: Request, @Param('id') id: string) {
      const { user } = await identity(req);
      const booking = await member(db, parse(uuid, id), user.id);
      const record = await db.bookingAgreement.findUnique({ where: { bookingId: booking.id } });
      if (!record) throw new PublicError(404, 'AGREEMENT_NOT_FOUND', 'This agreement is unavailable.');
      return presentAgreement(record);
    }

    @Get('agreements/:id/artifact')
    @ApiParam({ name: 'id', format: 'uuid' })
    @ApiOkResponse({ schema: schema(artifact) })
    async artifact(@Req() req: Request, @Param('id') id: string) {
      const { user } = await identity(req);
      const record = await db.bookingAgreement.findFirst({
        where: { id: parse(uuid, id), booking: { OR: [{ customerId: user.id }, { providerId: user.id }] } },
      });
      if (!record) throw new PublicError(404, 'AGREEMENT_NOT_FOUND', 'This agreement is unavailable.');
      return { ...presentAgreement(record), artifact: record.artifact };
    }
  }
  return QuotationsController;
}
