import { Body, Controller, Get, HttpCode, Param, Post, Put, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOkResponse, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import { Prisma, type Booking, type InventoryStatus } from '../../../generated/prisma/client.js';
import { PublicError } from '../auth/errors.js';
import type { AuthService } from '../auth/service.js';
import { parse, schema, uuid } from '../payments/orders.js';
import { ProfileService } from '../profiles/service.js';
import { acknowledgmentPhase, draftPhase, hasDiscrepancy } from './inspection-state.js';
import { agreementAmounts, lockBooking, paidAdvance, paymentBlocked } from './lifecycle.js';
import { member } from './requests.js';

const timestamp = z.iso.datetime();
const revision = z.number().int().positive().max(2_147_483_647);
const change = z.object({ revision: revision.max(2_147_483_646) }).strict();
const phase = z.enum(['dispatch', 'return', 'clearance']);
const stage = z.enum(['dispatch_draft', 'dispatch_ack', 'out', 'return_draft', 'return_ack', 'quarantined', 'clearance_draft', 'cleared', 'abandoned']);
const condition = z.enum(['good', 'worn', 'damaged', 'missing']);
const manifest = z.array(z.string().trim().min(1).max(120)).max(40);
const open = z.object({ accessories: manifest }).strict();
const evidence = z.object({
  units: z.array(z.object({ unitId: uuid, condition, notes: z.string().trim().max(500) }).strict()).max(100),
  accessories: z.array(z.boolean()).max(40),
  photoIds: z.array(uuid).max(4),
  notes: z.string().trim().max(2000),
}).strict();
const draftInput = change.extend({ evidence });
const submitInput = draftInput.extend({ confirmed: z.literal(true) });
const acknowledgeInput = change.extend({ confirmed: z.literal(true) });
const correctInput = change.extend({ reason: z.string().trim().min(10).max(500) });
const report = z.object({
  revision, phase, evidence, submittedBy: uuid, submittedAt: timestamp,
  decidedBy: uuid.nullable(), decidedAt: timestamp.nullable(),
  decision: z.enum(['acknowledged', 'correction']).nullable(), correctionReason: z.string().nullable(),
});
const view = z.object({
  id: uuid, bookingId: uuid, revision, stage, createdAt: timestamp,
  units: z.array(z.object({ id: uuid, serial: z.string(), listingId: uuid })),
  accessories: manifest, draft: evidence.nullable(), reports: z.array(report),
});
const history = z.object({ items: z.array(report), nextRevision: revision.nullable() });
const comparison = z.object({
  dispatch: report, returned: report,
  units: z.array(z.object({ unitId: uuid, dispatch: condition, returned: condition })),
  accessories: z.array(z.object({ name: z.string(), dispatch: z.boolean(), returned: z.boolean() })),
});

const include = {
  units: { orderBy: { unitId: 'asc' }, include: { unit: true } },
  reports: { orderBy: { revision: 'desc' }, take: 3 },
} satisfies Prisma.EquipmentInspectionInclude;
type Inspection = Prisma.EquipmentInspectionGetPayload<{ include: typeof include }>;
type Evidence = z.infer<typeof evidence>;

function presentReport(row: Inspection['reports'][number]) {
  const { inspectionId: _id, ...fields } = row;
  return { ...fields, submittedAt: row.submittedAt.toISOString(), decidedAt: row.decidedAt?.toISOString() ?? null };
}

function present(row: Inspection, showDraft: boolean) {
  return {
    id: row.id, bookingId: row.bookingId, revision: row.revision, stage: row.stage,
    createdAt: row.createdAt.toISOString(), accessories: row.accessories, draft: showDraft ? row.draft : null,
    units: row.units.map(({ unit }) => ({ id: unit.id, serial: unit.serial, listingId: unit.listingId })),
    reports: row.reports.map(presentReport),
  };
}

function invalidStage(): never {
  throw new PublicError(409, 'INSPECTION_STAGE_CHANGED', 'Reload the inspection before continuing.');
}

function normalized(input: Evidence) {
  return {
    ...input, units: input.units.map(unit => ({ ...unit, unitId: unit.unitId.toLowerCase() })),
    photoIds: input.photoIds.map(id => id.toLowerCase()),
  };
}

async function validateEvidence(tx: Prisma.TransactionClient, row: Inspection, body: Evidence, ownerId: string, complete: boolean) {
  const unitIds = new Set(body.units.map(unit => unit.unitId));
  const allowed = new Set(row.units.map(unit => unit.unitId));
  const photoIds = new Set(body.photoIds);
  if (unitIds.size !== body.units.length || body.units.some(unit => !allowed.has(unit.unitId)) ||
    body.accessories.length !== manifest.parse(row.accessories).length || photoIds.size !== body.photoIds.length ||
    (complete && (unitIds.size !== allowed.size || !photoIds.size))) {
    throw new PublicError(400, 'INSPECTION_EVIDENCE_INVALID', 'Check the allocated units, accessory checklist and evidence photos.');
  }
  for (const id of [...photoIds].sort()) {
    await tx.$queryRaw`SELECT id FROM assets WHERE id=${id}::uuid FOR UPDATE`;
    const asset = await tx.asset.findFirst({ where: { id, ownerId, purpose: 'inspection', status: 'ready' }, select: { variants: true } });
    const display = (asset?.variants as { display?: { mime?: string } } | undefined)?.display;
    if (display?.mime !== 'image/webp') {
      throw new PublicError(409, 'INSPECTION_PHOTO_UNAVAILABLE', 'Choose validated inspection photos from your media library.');
    }
  }
}

async function moveUnits(tx: Prisma.TransactionClient, row: Inspection, from: InventoryStatus, to: InventoryStatus, reason: string, booking: Booking) {
  const now = new Date();
  for (const { unit } of row.units) {
    if (unit.status !== from) invalidStage();
    const custodyReference = to === 'out' ? booking.id : null;
    const dueAt = to === 'out' ? booking.endsAt : null;
    await tx.inventoryUnit.update({
      where: { id: unit.id, revision: unit.revision },
      data: {
        revision: { increment: 1 }, status: to, custodyReference, dueAt, updatedAt: now,
        movements: { create: {
          revision: unit.revision + 1, fromStatus: from, toStatus: to, reason,
          custodyReference: booking.id, dueAt: dueAt ?? unit.dueAt,
        } },
      },
    });
  }
  if (to === 'available') {
    await tx.equipmentInspectionUnit.updateMany({ where: { inspectionId: row.id }, data: { releasedAt: now } });
  }
}

export function makeInspectionsController(auth: AuthService) {
  const db = auth.deps.db;
  const profiles = new ProfileService(auth);
  const identity = (req: Request) => auth.authenticate(req.get('Authorization'));

  async function write<T>(
    req: Request, bookingId: string, role: 'provider' | 'customer',
    work: (tx: Prisma.TransactionClient, booking: Booking, actorId: string) => Promise<T>,
  ) {
    if (req.get('Origin') !== auth.config.WEB_ORIGIN || req.get('Sec-Fetch-Site') === 'cross-site' || !req.is('application/json')) {
      throw new PublicError(403, 'ORIGIN_REJECTED', 'Open StageLink in its own browser tab and try again.');
    }
    const actor = await identity(req);
    profiles.checkCsrf(actor, req.get('X-CSRF-Token'));
    const original = await member(db, bookingId, actor.user.id);
    const expectedId = role === 'provider' ? original.providerId : original.customerId;
    if (actor.user.id !== expectedId) throw new PublicError(403, 'INSPECTION_ROLE_REQUIRED', 'The other booking party must perform this step.');
    return db.$transaction(async tx => {
      for (const id of [original.customerId, original.providerId].sort()) {
        await tx.$queryRaw`SELECT id FROM auth_users WHERE id=${id}::uuid FOR UPDATE`;
      }
      const current = await profiles.actor(tx, actor);
      profiles.verified(current);
      if (role === 'provider') profiles.providerRole(current, 'renter');
      else if (!current.user.roles.includes('customer')) throw new PublicError(403, 'ROLE_FORBIDDEN', 'A customer membership is required.');
      await lockBooking(tx, bookingId);
      const booking = await member(tx, bookingId, current.user.id);
      return work(tx, booking, current.user.id);
    });
  }

  async function changeInspection<T>(
    req: Request, id: string, expected: number, role: 'provider' | 'customer',
    work: (tx: Prisma.TransactionClient, booking: Booking, row: Inspection, actorId: string) => Promise<T>,
  ) {
    const actor = await identity(req);
    const found = await db.equipmentInspection.findFirst({
      where: { id: parse(uuid, id), booking: { OR: [{ customerId: actor.user.id }, { providerId: actor.user.id }] } },
      select: { bookingId: true },
    });
    if (!found) throw new PublicError(404, 'INSPECTION_NOT_FOUND', 'This inspection is unavailable.');
    return write(req, found.bookingId, role, async (tx, booking, actorId) => {
      const row = await tx.equipmentInspection.findUniqueOrThrow({ where: { id }, include });
      if (row.revision !== expected || booking.cancelledAt || row.stage === 'abandoned') invalidStage();
      return work(tx, booking, row, actorId);
    });
  }

  async function confirmReport(req: Request, id: string, expected: number, reason?: string) {
    return changeInspection(req, id, expected, 'customer', async (tx, booking, row, actorId) => {
      const currentPhase = acknowledgmentPhase[row.stage];
      const latest = row.reports[0];
      if (!currentPhase || !latest || latest.phase !== currentPhase || latest.decision) invalidStage();
      const now = new Date();
      let next: Inspection['stage'];
      let draft: Evidence | typeof Prisma.DbNull = Prisma.DbNull;
      if (reason) {
        next = currentPhase === 'dispatch' ? 'dispatch_draft' : 'return_draft';
        draft = evidence.parse(latest.evidence);
      } else if (currentPhase === 'dispatch') {
        if (now < booking.startsAt || booking.endsAt <= now || await paymentBlocked(tx, booking.id) || !await paidAdvance(tx, booking.id)) {
          throw new PublicError(409, 'DISPATCH_NOT_ELIGIBLE', 'This booking is unavailable for dispatch.');
        }
        const terms = await agreementAmounts(tx, booking.id);
        if (terms.depositMinor > 0 && !await tx.paymentOrder.count({
          where: { bookingId: booking.id, purpose: 'deposit', amountMinor: terms.depositMinor, status: 'paid' },
        })) throw new PublicError(409, 'DEPOSIT_REQUIRED', 'The agreed deposit is required before dispatch.');
        await moveUnits(tx, row, 'available', 'out', 'Customer acknowledged dispatch condition', booking);
        next = 'out';
      } else {
        const discrepant = hasDiscrepancy(evidence.parse(latest.evidence));
        await moveUnits(tx, row, 'inspection', discrepant ? 'quarantined' : 'available', 'Customer acknowledged return condition', booking);
        next = discrepant ? 'quarantined' : 'cleared';
      }
      await tx.equipmentInspectionReport.update({
        where: { inspectionId_revision: { inspectionId: row.id, revision: latest.revision } },
        data: { decidedAt: now, decidedBy: actorId, decision: reason ? 'correction' : 'acknowledged', correctionReason: reason },
      });
      return present(await tx.equipmentInspection.update({
        where: { id: row.id }, data: { stage: next, draft, revision: { increment: 1 } }, include,
      }), false);
    });
  }

  @ApiTags('Equipment inspections')
  @ApiBearerAuth()
  @Controller()
  class InspectionsController {
    @Post('bookings/:id/inspections')
    @HttpCode(200)
    @ApiParam({ name: 'id', format: 'uuid' })
    @ApiBody({ schema: schema(open) })
    @ApiOkResponse({ schema: schema(view) })
    start(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
      const input = parse(open, body);
      return write(req, parse(uuid, id), 'provider', async (tx, booking) => {
        const existing = await tx.equipmentInspection.findUnique({ where: { bookingId: booking.id }, include });
        if (existing) return present(existing, true);
        const now = new Date();
        if (booking.targetKind !== 'rental' || !booking.agreedAt || now < booking.startsAt || booking.endsAt <= now ||
          await paymentBlocked(tx, booking.id) || !await paidAdvance(tx, booking.id)) {
          throw new PublicError(409, 'INSPECTION_NOT_ELIGIBLE', 'An agreed equipment booking with a paid advance is required.');
        }
        const lines = await tx.bookingReservationLine.findMany({ where: { bookingId: booking.id, resource: 'equipment' }, orderBy: { resourceId: 'asc' } });
        const quantity = lines.reduce((total, line) => total + line.quantity, 0);
        if (quantity < 1 || quantity > 100) {
          throw new PublicError(409, 'INSPECTION_MANIFEST_UNAVAILABLE', 'An equipment manifest of up to 100 serialized units is required.');
        }
        const units: { unitId: string }[] = [];
        for (const line of lines) {
          const available = await tx.inventoryUnit.findMany({
            where: {
              listingId: line.resourceId, ownerId: booking.providerId, status: 'available',
              inspectionUnits: { none: { releasedAt: null } },
            },
            orderBy: { id: 'asc' }, take: line.quantity, select: { id: true },
          });
          if (available.length !== line.quantity) {
            throw new PublicError(409, 'SERIALS_UNAVAILABLE', 'Register or clear enough equipment units before opening the inspection.');
          }
          units.push(...available.map(unit => ({ unitId: unit.id })));
        }
        return present(await tx.equipmentInspection.create({
          data: { bookingId: booking.id, accessories: input.accessories, units: { create: units } }, include,
        }), true);
      });
    }

    @Get('bookings/:id/inspections')
    @ApiParam({ name: 'id', format: 'uuid' })
    @ApiOkResponse({ schema: schema(z.object({ inspection: view.nullable() })) })
    async read(@Req() req: Request, @Param('id') id: string) {
      const { user } = await identity(req);
      const booking = await member(db, parse(uuid, id), user.id);
      const row = await db.equipmentInspection.findUnique({ where: { bookingId: booking.id }, include });
      return { inspection: row && present(row, user.id === booking.providerId) };
    }

    @Get('inspections/:id/reports')
    @ApiParam({ name: 'id', format: 'uuid' })
    @ApiQuery({ name: 'beforeRevision', type: Number, required: false })
    @ApiOkResponse({ schema: schema(history) })
    async history(@Req() req: Request, @Param('id') id: string, @Query('beforeRevision') raw?: string) {
      const { user } = await identity(req);
      const inspectionId = parse(uuid, id);
      const cursor = raw === undefined ? undefined : parse(z.string().regex(/^[1-9]\d{0,9}$/).transform(Number).pipe(revision), raw);
      const found = await db.equipmentInspection.findFirst({
        where: { id: inspectionId, booking: { OR: [{ customerId: user.id }, { providerId: user.id }] } }, select: { id: true },
      });
      if (!found) throw new PublicError(404, 'INSPECTION_NOT_FOUND', 'This inspection is unavailable.');
      const rows = await db.equipmentInspectionReport.findMany({
        where: { inspectionId, ...(cursor ? { revision: { lt: cursor } } : {}) },
        orderBy: { revision: 'desc' }, take: 31,
      });
      const items = rows.slice(0, 30).map(presentReport);
      return { items, nextRevision: rows.length > 30 ? items[29]!.revision : null };
    }

    @Get('inspections/:id/comparison')
    @ApiParam({ name: 'id', format: 'uuid' })
    @ApiOkResponse({ schema: schema(comparison) })
    async comparison(@Req() req: Request, @Param('id') id: string) {
      const { user } = await identity(req);
      const inspectionId = parse(uuid, id);
      return db.$transaction(async tx => {
        const row = await tx.equipmentInspection.findFirst({
          where: { id: inspectionId, booking: { OR: [{ customerId: user.id }, { providerId: user.id }] } },
        });
        if (!row) throw new PublicError(404, 'INSPECTION_NOT_FOUND', 'This inspection is unavailable.');
        const [dispatch, returned] = await Promise.all([
          tx.equipmentInspectionReport.findFirst({
            where: { inspectionId, phase: 'dispatch', decision: 'acknowledged' }, orderBy: { revision: 'desc' },
          }),
          tx.equipmentInspectionReport.findFirst({
            where: { inspectionId, phase: 'return', OR: [{ decision: null }, { decision: 'acknowledged' }] },
            orderBy: { revision: 'desc' },
          }),
        ]);
        if (!dispatch || !returned) throw new PublicError(409, 'COMPARISON_NOT_READY', 'The dispatch and return reports are required.');
        const original = evidence.parse(dispatch.evidence);
        const current = evidence.parse(returned.evidence);
        const conditions = new Map(current.units.map(unit => [unit.unitId, unit.condition]));
        return {
          dispatch: presentReport(dispatch), returned: presentReport(returned),
          units: original.units.map(unit => ({ unitId: unit.unitId, dispatch: unit.condition, returned: conditions.get(unit.unitId)! })),
          accessories: manifest.parse(row.accessories).map((name, index) => ({
            name, dispatch: original.accessories[index]!, returned: current.accessories[index]!,
          })),
        };
      }, { isolationLevel: 'RepeatableRead' });
    }

    @Put('inspections/:id/draft')
    @ApiParam({ name: 'id', format: 'uuid' })
    @ApiBody({ schema: schema(draftInput) })
    @ApiOkResponse({ schema: schema(view) })
    draft(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
      const input = parse(draftInput, body);
      return changeInspection(req, id, input.revision, 'provider', async (tx, _booking, row, actorId) => {
        if (!draftPhase[row.stage]) invalidStage();
        const content = normalized(input.evidence);
        await validateEvidence(tx, row, content, actorId, false);
        return present(await tx.equipmentInspection.update({
          where: { id: row.id }, data: { draft: content, revision: { increment: 1 } }, include,
        }), true);
      });
    }

    @Post('inspections/:id/submit')
    @HttpCode(200)
    @ApiParam({ name: 'id', format: 'uuid' })
    @ApiBody({ schema: schema(submitInput) })
    @ApiOkResponse({ schema: schema(view) })
    submit(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
      const input = parse(submitInput, body);
      return changeInspection(req, id, input.revision, 'provider', async (tx, booking, row, actorId) => {
        const currentPhase = draftPhase[row.stage];
        if (!currentPhase) invalidStage();
        const content = normalized(input.evidence);
        await validateEvidence(tx, row, content, actorId, true);
        if (currentPhase !== 'return' && hasDiscrepancy(content)) {
          throw new PublicError(409, 'INSPECTION_DISCREPANCY', 'Resolve missing or damaged items before dispatch or clearance.');
        }
        if (currentPhase === 'clearance') await moveUnits(tx, row, 'quarantined', 'available', 'Provider documented equipment clearance', booking);
        await tx.equipmentInspectionReport.create({
          data: {
            inspectionId: row.id, phase: currentPhase, evidence: content, submittedBy: actorId, revision: row.revision + 1,
            photos: { create: content.photoIds.map(assetId => ({ assetId })) },
          },
        });
        const next = { dispatch: 'dispatch_ack', return: 'return_ack', clearance: 'cleared' } as const;
        return present(await tx.equipmentInspection.update({
          where: { id: row.id }, data: { stage: next[currentPhase], draft: Prisma.DbNull, revision: { increment: 1 } }, include,
        }), true);
      });
    }

    @Post('inspections/:id/acknowledge')
    @HttpCode(200)
    @ApiParam({ name: 'id', format: 'uuid' })
    @ApiBody({ schema: schema(acknowledgeInput) })
    @ApiOkResponse({ schema: schema(view) })
    acknowledge(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
      return confirmReport(req, id, parse(acknowledgeInput, body).revision);
    }

    @Post('inspections/:id/corrections')
    @HttpCode(200)
    @ApiParam({ name: 'id', format: 'uuid' })
    @ApiBody({ schema: schema(correctInput) })
    @ApiOkResponse({ schema: schema(view) })
    correct(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
      const input = parse(correctInput, body);
      return confirmReport(req, id, input.revision, input.reason);
    }

    @Post('inspections/:id/abandon')
    @HttpCode(200)
    @ApiParam({ name: 'id', format: 'uuid' })
    @ApiBody({ schema: schema(change) })
    @ApiOkResponse({ schema: schema(view) })
    abandon(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
      return changeInspection(req, id, parse(change, body).revision, 'provider', async (tx, booking, row) => {
        const now = new Date();
        if (booking.endsAt > now || (row.stage !== 'dispatch_draft' && row.stage !== 'dispatch_ack')) invalidStage();
        await tx.equipmentInspectionUnit.updateMany({ where: { inspectionId: row.id }, data: { releasedAt: now } });
        return present(await tx.equipmentInspection.update({
          where: { id: row.id }, data: { stage: 'abandoned', draft: Prisma.DbNull, revision: { increment: 1 } }, include,
        }), true);
      });
    }

    @Post('inspections/:id/return')
    @HttpCode(200)
    @ApiParam({ name: 'id', format: 'uuid' })
    @ApiBody({ schema: schema(change) })
    @ApiOkResponse({ schema: schema(view) })
    returnEquipment(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
      return changeInspection(req, id, parse(change, body).revision, 'provider', async (tx, booking, row) => {
        if (row.stage !== 'out') invalidStage();
        await moveUnits(tx, row, 'out', 'inspection', 'Provider opened the return inspection', booking);
        return present(await tx.equipmentInspection.update({
          where: { id: row.id }, data: { stage: 'return_draft', revision: { increment: 1 } }, include,
        }), true);
      });
    }

    @Post('inspections/:id/clearance')
    @HttpCode(200)
    @ApiParam({ name: 'id', format: 'uuid' })
    @ApiBody({ schema: schema(change) })
    @ApiOkResponse({ schema: schema(view) })
    openClearance(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
      return changeInspection(req, id, parse(change, body).revision, 'provider', async (tx, _booking, row) => {
        if (row.stage !== 'quarantined') invalidStage();
        return present(await tx.equipmentInspection.update({
          where: { id: row.id }, data: { stage: 'clearance_draft', revision: { increment: 1 } }, include,
        }), true);
      });
    }
  }
  return InspectionsController;
}
