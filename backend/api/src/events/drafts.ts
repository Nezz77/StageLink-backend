import { Body, Controller, Delete, Get, Param, Put, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOkResponse, ApiParam, ApiTags, type SchemaObject } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import type { Prisma, PrivateDraft } from '../../../generated/prisma/client.js';
import type { AuthService } from '../auth/service.js';
import { PublicError } from '../auth/errors.js';
import { ProfileService } from '../profiles/service.js';

const keySchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}$/);
const id = z.string().uuid();
const revision = z.number().int().min(1).max(2_147_483_647);
const draftFields = z.object({
  title: z.string().max(120).optional(),
  description: z.string().max(2000).optional(),
  city: z.string().max(100).optional(),
  eventDate: z.iso.date().optional(),
  budgetMinor: z.number().int().min(1).max(2_147_483_647).optional(),
  requirements: z.array(z.object({
    category: z.enum(['artist', 'equipment', 'venue']),
    description: z.string().max(300),
    quantity: z.number().int().min(1).max(1000),
  }).strict()).max(25).optional(),
}).strict();
const payload = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('event_brief'), fields: draftFields }).strict(),
  z.object({ kind: z.literal('message'), text: z.string().max(4000) }).strict(),
]);
const token = z.object({ id, revision }).strict();
const save = z.object({ expected: token.nullable(), payload }).strict();
const draft = z.object({ id, key: keySchema, revision, payload, updatedAt: z.iso.datetime() });
const list = z.object({ items: z.array(draft) });
const deleted = z.object({ deleted: z.literal(true) });
const schema = (value: z.ZodType) => z.toJSONSchema(value, { target: 'openapi-3.0' }) as SchemaObject;
const draftLimit = 50;

function parse<T>(type: z.ZodType<T>, value: unknown): T {
  const result = type.safeParse(value);
  if (!result.success) throw new PublicError(400, 'INVALID_DRAFT', 'Check the draft key, revision, or fields.');
  return result.data;
}

function present(record: PrivateDraft) {
  return { id: record.id, key: record.key, revision: record.revision, payload: payload.parse(record.payload), updatedAt: record.updatedAt.toISOString() };
}

function expectRevision(record: PrivateDraft | null, expected: z.infer<typeof token> | null) {
  if (expected === null ? record !== null : record?.id !== expected.id || record.revision !== expected.revision) {
    throw new PublicError(409, 'DRAFT_REVISION_CONFLICT', 'Reload the draft before saving or discarding it.');
  }
}

export const draftReference = token.extend({ key: keySchema });

export async function consumeDraft(
  tx: Prisma.TransactionClient,
  ownerId: string,
  reference: z.infer<typeof draftReference>,
  expectedKind: z.infer<typeof payload>['kind'],
) {
  const where = { ownerId_key: { ownerId, key: reference.key } };
  const record = await tx.privateDraft.findUnique({ where });
  expectRevision(record, reference);
  if (!record || payload.parse(record.payload).kind !== expectedKind) {
    throw new PublicError(409, 'DRAFT_KIND_MISMATCH', 'Select a draft for this form.');
  }
  await tx.privateDraft.delete({ where });
}

export function makeDraftsController(auth: AuthService) {
  const db = auth.deps.db;
  const profiles = new ProfileService(auth);
  const actor = (req: Request) => auth.authenticate(req.get('Authorization'));

  async function write<T>(req: Request, work: (tx: Prisma.TransactionClient, ownerId: string) => Promise<T>) {
    if (req.get('Origin') !== auth.config.WEB_ORIGIN || req.get('Sec-Fetch-Site') === 'cross-site' || !req.is('application/json')) {
      throw new PublicError(403, 'ORIGIN_REJECTED', 'Open StageLink in its own browser tab and try again.');
    }
    const identity = await actor(req);
    profiles.checkCsrf(identity, req.get('X-CSRF-Token'));
    return db.$transaction(async tx => {
      const current = await profiles.actor(tx, identity);
      return work(tx, current.user.id);
    });
  }

  @ApiTags('Private drafts')
  @ApiBearerAuth()
  @Controller('me/drafts')
  class DraftsController {
    @Get()
    @ApiOkResponse({ schema: schema(list) })
    async list(@Req() req: Request) {
      const { user } = await actor(req);
      const records = await db.privateDraft.findMany({
        where: { ownerId: user.id }, orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }], take: draftLimit,
      });
      return { items: records.map(present) };
    }

    @Put(':key')
    @ApiParam({ name: 'key', type: String })
    @ApiBody({ schema: schema(save) })
    @ApiOkResponse({ schema: schema(draft) })
    save(@Req() req: Request, @Param('key') rawKey: string, @Body() body: unknown) {
      const key = parse(keySchema, rawKey);
      const input = parse(save, body);
      return write(req, async (tx, ownerId) => {
        const where = { ownerId_key: { ownerId, key } };
        const record = await tx.privateDraft.findUnique({ where });
        expectRevision(record, input.expected);
        if (record) {
          return present(await tx.privateDraft.update({
            where, data: { payload: input.payload, revision: { increment: 1 }, updatedAt: new Date() },
          }));
        }
        if (await tx.privateDraft.count({ where: { ownerId } }) >= draftLimit) {
          throw new PublicError(409, 'DRAFT_LIMIT', 'Discard an existing draft before saving another.');
        }
        return present(await tx.privateDraft.create({ data: { ownerId, key, payload: input.payload } }));
      });
    }

    @Delete(':key')
    @ApiParam({ name: 'key', type: String })
    @ApiBody({ schema: schema(token) })
    @ApiOkResponse({ schema: schema(deleted) })
    remove(@Req() req: Request, @Param('key') rawKey: string, @Body() body: unknown) {
      const key = parse(keySchema, rawKey);
      const expected = parse(token, body);
      return write(req, async (tx, ownerId) => {
        const where = { ownerId_key: { ownerId, key } };
        const record = await tx.privateDraft.findUnique({ where });
        if (record) {
          expectRevision(record, expected);
          await tx.privateDraft.delete({ where });
        }
        return { deleted: true };
      });
    }
  }
  return DraftsController;
}
