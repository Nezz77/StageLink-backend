import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOkResponse, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import type { EquipmentSpecSource, Prisma } from '../../../generated/prisma/client.js';
import { PublicError } from '../auth/errors.js';
import type { AuthService } from '../auth/service.js';
import { rentalSpecs } from '../catalog/equipment-specs.js';
import { schema } from '../payments/orders.js';
import { ProfileService } from '../profiles/service.js';
import { equipmentKey, equipmentReferenceBundle, equipmentReferenceBundleDigest } from '../../../shared/equipment-reference-bundle.js';

const label = (max: number) => z.string().trim().min(1).max(max).refine(value => !value.includes('\0'));
const modelName = label(120);
const factualSpecs = rentalSpecs.omit({ packageInclusions: true });
const supportedFacts = factualSpecs.refine(specs => {
  const values = Object.values(specs);
  return values.length > 0 && values.every(value => value && !value.includes('\0'));
});
const referenceUrl = z.url({ protocol: /^https$/ }).max(2048).refine(value => {
  try {
    const url = new URL(value);
    return !url.username && !url.password;
  } catch { return false; }
});
const sourceInput = z.object({
  manufacturer: modelName, model: modelName, specs: supportedFacts,
  url: referenceUrl, title: label(200), locator: label(160).optional(),
}).strict();
const retirement = z.object({ reason: label(500) }).strict();
const citation = z.object({
  id: z.uuid(), url: referenceUrl, title: z.string(), locator: z.string().nullable(), approvedAt: z.iso.datetime(),
});
const adminSource = citation.extend({
  manufacturer: z.string(), model: z.string(), specs: factualSpecs,
  approvedBy: z.uuid(), retiredAt: z.iso.datetime().nullable(),
  retiredBy: z.uuid().nullable(), retirementReason: z.string().nullable(),
});
const bundledModel = z.enum(equipmentReferenceBundle.entries.map(entry => entry.model));
const bundleCommand = z.object({
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  models: z.array(bundledModel).min(1).max(equipmentReferenceBundle.entries.length)
    .refine(models => new Set(models).size === models.length).optional(),
}).strict();
const bundlePreview = z.object({
  version: z.string(), reviewedOn: z.string(), digest: z.string(),
  entries: z.array(sourceInput.extend({ notes: z.string(), state: z.enum(['new', 'approved', 'conflict', 'retired']) })),
});
const bundleResult = z.object({ version: z.string(), digest: z.string(), created: z.number(), unchanged: z.number(), items: z.array(adminSource) });
export const equipmentLookup = z.object({
  requestKey: z.uuid(), manufacturer: modelName.optional(), model: modelName,
}).strict();
export const equipmentSuggestion = z.object({
  match: z.enum(['matched', 'unknown', 'ambiguous', 'withdrawn']),
  manufacturer: z.string().nullable(), model: z.string(), specs: factualSpecs, source: citation.nullable(),
});

function sameReference(row: EquipmentSpecSource, input: z.infer<typeof sourceInput>) {
  const saved = factualSpecs.safeParse(row.specs);
  return saved.success && row.url === input.url && row.title === input.title && row.locator === (input.locator ?? null) &&
    Object.keys(saved.data).length === Object.keys(input.specs).length &&
    Object.entries(input.specs).every(([key, value]) => saved.data[key as keyof typeof saved.data] === value);
}

async function lockReferenceCatalog(tx: Prisma.TransactionClient) {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(176012, 15)::text`;
}

async function referenceBundlePreview(db: Prisma.TransactionClient) {
  const entries = [];
  for (const candidate of equipmentReferenceBundle.entries) {
    const { notes, ...raw } = candidate;
    const input = sourceInput.parse(raw);
    const row = await db.equipmentSpecSource.findFirst({
      where: { manufacturerKey: equipmentKey(input.manufacturer), modelKey: equipmentKey(input.model) },
      orderBy: { retiredAt: { sort: 'desc', nulls: 'first' } },
    });
    const state = !row ? 'new' : row.retiredAt ? 'retired' : sameReference(row, input) ? 'approved' : 'conflict';
    entries.push({ ...input, notes, state });
  }
  return bundlePreview.parse({ version: equipmentReferenceBundle.version, reviewedOn: equipmentReferenceBundle.reviewedOn,
    digest: equipmentReferenceBundleDigest, entries });
}

function parse<T>(type: z.ZodType<T>, data: unknown) {
  const result = type.safeParse(data);
  if (!result.success) throw new PublicError(400, 'INVALID_EQUIPMENT_REFERENCE', 'Check the model, measurements and source details.');
  return result.data;
}

function cite({ id, url, title, locator, approvedAt }: EquipmentSpecSource) {
  return { id, url, title, locator, approvedAt: approvedAt.toISOString() };
}

function present(row: EquipmentSpecSource) {
  const { manufacturer, model, approvedBy, retiredAt, retiredBy, retirementReason } = row;
  return {
    ...cite(row), manufacturer, model, specs: factualSpecs.parse(row.specs),
    approvedBy, retiredAt: retiredAt?.toISOString() ?? null, retiredBy, retirementReason,
  };
}

export async function sourcedEquipmentSuggestion(
  tx: Prisma.TransactionClient, input: z.infer<typeof equipmentLookup>,
): Promise<z.infer<typeof equipmentSuggestion>> {
  const rows = await tx.equipmentSpecSource.findMany({
    where: {
      modelKey: equipmentKey(input.model), retiredAt: null,
      ...(input.manufacturer ? { manufacturerKey: equipmentKey(input.manufacturer) } : {}),
    },
    orderBy: { id: 'asc' }, take: 2,
  });
  if (rows.length !== 1) {
    return {
      match: rows.length ? 'ambiguous' : 'unknown', manufacturer: input.manufacturer ?? null,
      model: input.model, specs: {}, source: null,
    };
  }
  const source = rows[0]!;
  return {
    match: 'matched', manufacturer: source.manufacturer, model: source.model,
    specs: factualSpecs.parse(source.specs), source: cite(source),
  };
}

export function makeEquipmentSourcesController(auth: AuthService) {
  const db = auth.deps.db;
  const profiles = new ProfileService(auth);

  async function admin(req: Request) {
    const actor = await auth.authenticate(req.get('Authorization'));
    if (actor.session.activeRole !== 'admin' || !actor.user.roles.includes('admin')) {
      throw new PublicError(403, 'ROLE_FORBIDDEN', 'Administrator access is required.');
    }
    profiles.verified(actor);
    return actor;
  }

  async function mutation<T>(req: Request, work: (tx: Prisma.TransactionClient, actorId: string) => Promise<T>) {
    if (req.get('Origin') !== auth.config.WEB_ORIGIN || req.get('Sec-Fetch-Site') === 'cross-site' || !req.is('application/json')) {
      throw new PublicError(403, 'ORIGIN_REJECTED', 'Open StageLink in its own browser tab and try again.');
    }
    const actor = await admin(req);
    profiles.checkCsrf(actor, req.get('X-CSRF-Token'));
    return db.$transaction(async tx => {
      const current = await profiles.actor(tx, actor, undefined, true);
      profiles.verified(current);
      return work(tx, current.user.id);
    });
  }

  @ApiTags('Equipment specification sources')
  @ApiBearerAuth()
  @Controller('admin/equipment-spec-sources')
  class EquipmentSourcesController {
    @Get('reference-bundle')
    @ApiOkResponse({ schema: schema(bundlePreview) })
    async previewBundle(@Req() req: Request) {
      await admin(req);
      return referenceBundlePreview(db);
    }

    @Post('reference-bundle/approve')
    @HttpCode(200)
    @ApiBody({ schema: schema(bundleCommand) })
    @ApiOkResponse({ schema: schema(bundleResult) })
    approveBundle(@Req() req: Request, @Body() raw: unknown) {
      const command = parse(bundleCommand, raw);
      return mutation(req, async (tx, approvedBy) => {
        if (command.digest !== equipmentReferenceBundleDigest) {
          throw new PublicError(409, 'REFERENCE_BUNDLE_CHANGED', 'Reload and review the current equipment reference bundle before approving.');
        }
        // Serialize imports and manual source approval/retirement across different administrators.
        await lockReferenceCatalog(tx);
        const preview = await referenceBundlePreview(tx);
        const selected = preview.entries.filter(entry => !command.models || command.models.includes(entry.model));
        if (selected.some(entry => entry.state === 'conflict' || entry.state === 'retired')) {
          throw new PublicError(409, 'REFERENCE_BUNDLE_CONFLICT', 'An equipment reference differs or was retired. Review those models individually; no bundle changes were saved.');
        }
        const items = [];
        let created = 0;
        for (const entry of selected) {
          const { notes: _notes, state, ...input } = entry;
          const keys = { manufacturerKey: equipmentKey(input.manufacturer), modelKey: equipmentKey(input.model) };
          if (state === 'new') {
            items.push(present(await tx.equipmentSpecSource.create({ data: { ...input, ...keys, approvedBy } })));
            created++;
          } else {
            items.push(present(await tx.equipmentSpecSource.findFirstOrThrow({ where: { ...keys, retiredAt: null } })));
          }
        }
        return bundleResult.parse({ version: preview.version, digest: preview.digest, created, unchanged: items.length - created, items });
      });
    }

    @Get()
    @ApiQuery({ name: 'cursor', type: String, required: false })
    @ApiOkResponse({ schema: schema(z.object({ items: z.array(adminSource), nextCursor: z.uuid().nullable() })) })
    async list(@Req() req: Request, @Query('cursor') raw?: string) {
      await admin(req);
      const cursor = raw === undefined ? null : parse(z.uuid(), raw);
      const rows = await db.equipmentSpecSource.findMany({
        where: cursor ? { id: { gt: cursor } } : {},
        orderBy: { id: 'asc' }, take: 25,
      });
      return { items: rows.slice(0, 24).map(present), nextCursor: rows.length === 25 ? rows[23]!.id : null };
    }

    @Post()
    @HttpCode(200)
    @ApiBody({ schema: schema(sourceInput) })
    @ApiOkResponse({ schema: schema(adminSource) })
    approve(@Req() req: Request, @Body() raw: unknown) {
      const input = parse(sourceInput, raw);
      return mutation(req, async (tx, approvedBy) => {
        await lockReferenceCatalog(tx);
        const [created] = await tx.equipmentSpecSource.createManyAndReturn({
          data: {
            ...input, manufacturerKey: equipmentKey(input.manufacturer), modelKey: equipmentKey(input.model), approvedBy,
          },
          skipDuplicates: true,
        });
        if (!created) throw new PublicError(409, 'SOURCE_ALREADY_APPROVED', 'Retire the existing source before approving another for this model.');
        return present(created);
      });
    }

    @Post(':id/retire')
    @HttpCode(200)
    @ApiParam({ name: 'id', format: 'uuid' })
    @ApiBody({ schema: schema(retirement) })
    @ApiOkResponse({ schema: schema(adminSource) })
    retire(@Req() req: Request, @Param('id') rawId: string, @Body() raw: unknown) {
      const id = parse(z.uuid(), rawId);
      const { reason } = parse(retirement, raw);
      return mutation(req, async (tx, retiredBy) => {
        await lockReferenceCatalog(tx);
        await tx.equipmentSpecSource.updateMany({
          where: { id, retiredAt: null }, data: { retiredAt: new Date(), retiredBy, retirementReason: reason },
        });
        const row = await tx.equipmentSpecSource.findUnique({ where: { id } });
        if (!row) throw new PublicError(404, 'EQUIPMENT_SOURCE_NOT_FOUND', 'This equipment reference is unavailable.');
        return present(row);
      });
    }
  }

  return EquipmentSourcesController;
}
