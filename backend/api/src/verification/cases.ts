import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOkResponse, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import type { Prisma } from '../../../generated/prisma/client.js';
import { PublicError } from '../auth/errors.js';
import type { AuthService } from '../auth/service.js';
import { parse, schema, uuid } from '../payments/orders.js';
import { ProfileService } from '../profiles/service.js';

const kind = z.enum(['artist', 'renter']);
const reason = z.string().trim().min(10).max(2000);
const status = z.enum(['pending', 'approved', 'rejected']);
const decision = z.object({ status: status.exclude(['pending']), reason, documentsReviewed: z.literal(true) }).strict();
const submission = z.object({
  kind, requestKey: uuid, subject: z.string().trim().min(3).max(140), body: z.string().trim().min(20).max(2000),
  assetIds: z.array(uuid).min(2).max(5).refine(ids => new Set(ids.map(id => id.toLowerCase())).size === ids.length),
}).strict();
const timestamp = z.iso.datetime();
const view = z.object({
  id: uuid, providerId: uuid, kind, version: z.number().int().positive(), status, subject: z.string(), body: z.string(),
  createdAt: timestamp, decidedAt: timestamp.nullable(), reason: reason.nullable(),
  documents: z.array(z.object({ assetId: uuid, filename: z.string(), mime: z.string() })),
});
const page = z.object({ items: z.array(view), nextCursor: uuid.nullable() });
const include = {
  documents: { orderBy: { position: 'asc' }, select: { assetId: true, asset: { select: { filename: true, mime: true } } } },
} satisfies Prisma.VerificationCaseInclude;
type Case = Prisma.VerificationCaseGetPayload<{ include: typeof include }>;
const pageSize = 30;

function present(row: Case) {
  const { requestKey: _key, decidedBy: _decider, documents, ...details } = row;
  return {
    ...details, createdAt: row.createdAt.toISOString(), decidedAt: row.decidedAt?.toISOString() ?? null,
    documents: documents.map(({ assetId, asset }) => ({ assetId, ...asset })),
  };
}

export function makeVerificationController(auth: AuthService) {
  const db = auth.deps.db;
  const profiles = new ProfileService(auth);
  const identity = (req: Request) => auth.authenticate(req.get('Authorization'));

  async function mutation(req: Request) {
    if (req.get('Origin') !== auth.config.WEB_ORIGIN || req.get('Sec-Fetch-Site') === 'cross-site' || !req.is('application/json')) {
      throw new PublicError(403, 'ORIGIN_REJECTED', 'Open StageLink in its own browser tab and try again.');
    }
    const actor = await identity(req);
    profiles.checkCsrf(actor, req.get('X-CSRF-Token'));
    return actor;
  }

  async function list(req: Request, raw: string | undefined, admin: boolean, requestedStatus?: string) {
    const actor = await identity(req);
    const cursor = raw === undefined ? undefined : parse(uuid, raw);
    const where = admin ? { status: parse(status, requestedStatus ?? 'pending') } : { providerId: actor.user.id };
    return db.$transaction(async tx => {
      const current = await profiles.actor(tx, actor, undefined, admin);
      if (admin) profiles.verified(current);
      else profiles.providerRole(current);
      const rows = await tx.verificationCase.findMany({
        where: { ...where, ...(cursor ? { id: { gt: cursor } } : {}) },
        include, orderBy: { id: 'asc' }, take: pageSize + 1,
      });
      return { items: rows.slice(0, pageSize).map(present), nextCursor: rows.length > pageSize ? rows[pageSize - 1]!.id : null };
    });
  }

  @ApiTags('Provider verification')
  @ApiBearerAuth()
  @Controller()
  class VerificationController {
    @Post('verification-cases')
    @HttpCode(200)
    @ApiBody({ schema: schema(submission) })
    @ApiOkResponse({ schema: schema(view) })
    async submit(@Req() req: Request, @Body() raw: unknown) {
      const actor = await mutation(req);
      const input = parse(submission, raw);
      const assetIds = input.assetIds.map(id => id.toLowerCase());
      return db.$transaction(async tx => {
        const current = await profiles.actor(tx, actor);
        profiles.verified(current);
        profiles.providerRole(current, input.kind);
        const providerId = current.user.id;
        const prior = await tx.verificationCase.findUnique({
          where: { providerId_requestKey: { providerId, requestKey: input.requestKey } }, include,
        });
        if (prior) {
          if (prior.kind !== input.kind || prior.subject !== input.subject || prior.body !== input.body ||
            prior.documents.length !== assetIds.length || prior.documents.some(({ assetId }, index) => assetId !== assetIds[index])) {
            throw new PublicError(409, 'REQUEST_KEY_REUSED', 'Use a new request key for a different verification submission.');
          }
          return present(prior);
        }
        const latest = await tx.verificationCase.findFirst({
          where: { providerId, kind: input.kind }, orderBy: { version: 'desc' },
        });
        if (latest && latest.status !== 'rejected') {
          throw new PublicError(409, 'VERIFICATION_ALREADY_SUBMITTED', 'This provider membership already has an active or approved case.');
        }
        for (const assetId of [...assetIds].sort()) {
          await tx.$queryRaw`SELECT id FROM assets WHERE id=${assetId}::uuid FOR UPDATE`;
          const asset = await tx.asset.findFirst({
            where: { id: assetId, ownerId: providerId, purpose: 'verification', status: 'ready' }, select: { mime: true, variants: true },
          });
          const display = (asset?.variants as { display?: { mime?: string } } | undefined)?.display;
          const eligible = asset?.mime === 'application/pdf'
            ? display?.mime === 'application/pdf'
            : asset?.mime.startsWith('image/') && display?.mime === 'image/webp';
          if (!eligible) {
            throw new PublicError(409, 'VERIFICATION_EVIDENCE_UNAVAILABLE', 'Choose validated private verification images or PDFs.');
          }
        }
        return present(await tx.verificationCase.create({
          data: {
            providerId, kind: input.kind, requestKey: input.requestKey, subject: input.subject, body: input.body,
            version: (latest?.version ?? 0) + 1, documents: { create: assetIds.map((assetId, position) => ({ assetId, position })) },
          }, include,
        }));
      });
    }

    @Get('me/verification')
    @ApiQuery({ name: 'cursor', type: String, required: false })
    @ApiOkResponse({ schema: schema(page) })
    mine(@Req() req: Request, @Query('cursor') cursor?: string) {
      return list(req, cursor, false);
    }

    @Get('admin/verification-cases')
    @ApiQuery({ name: 'cursor', type: String, required: false })
    @ApiQuery({ name: 'status', enum: status.options, required: false })
    @ApiOkResponse({ schema: schema(page) })
    queue(@Req() req: Request, @Query('cursor') cursor?: string, @Query('status') requestedStatus?: string) {
      return list(req, cursor, true, requestedStatus);
    }

    @Post('admin/verification-cases/:id/decisions')
    @HttpCode(200)
    @ApiParam({ name: 'id', format: 'uuid' })
    @ApiBody({ schema: schema(decision) })
    @ApiOkResponse({ schema: schema(view) })
    async decide(@Req() req: Request, @Param('id') rawId: string, @Body() raw: unknown) {
      const actor = await mutation(req);
      const id = parse(uuid, rawId);
      const input = parse(decision, raw);
      if (actor.session.activeRole !== 'admin') throw new PublicError(403, 'ROLE_FORBIDDEN', 'Administrator access is required.');
      return db.$transaction(async tx => {
        const original = await tx.verificationCase.findUnique({ where: { id }, select: { providerId: true } });
        // Match payout authorization lock order before changing the provider's verification status.
        const userIds = [...new Set([actor.user.id, original?.providerId ?? actor.user.id])].sort();
        for (const userId of userIds) {
          await tx.$queryRaw`SELECT id FROM auth_users WHERE id=${userId}::uuid FOR UPDATE`;
        }
        const current = await profiles.actor(tx, actor, undefined, true);
        profiles.verified(current);
        if (!original) throw new PublicError(404, 'VERIFICATION_CASE_NOT_FOUND', 'This verification case is unavailable.');
        if (current.session.createdAt.getTime() < Date.now() - 15 * 60_000) {
          throw new PublicError(403, 'RECENT_LOGIN_REQUIRED', 'Sign in again before reviewing verification evidence.');
        }
        await tx.$queryRaw`SELECT id FROM verification_cases WHERE id=${id}::uuid FOR UPDATE`;
        const row = await tx.verificationCase.findUnique({ where: { id }, include });
        if (!row) throw new PublicError(404, 'VERIFICATION_CASE_NOT_FOUND', 'This verification case is unavailable.');
        if (row.providerId === current.user.id) throw new PublicError(403, 'SELF_REVIEW_FORBIDDEN', 'Another administrator must review this case.');
        if (row.status === input.status && row.reason === input.reason && row.decidedBy === current.user.id) return present(row);
        if (row.status !== 'pending') throw new PublicError(409, 'VERIFICATION_CASE_DECIDED', 'A decision is already recorded.');
        return present(await tx.verificationCase.update({
          where: { id }, data: { status: input.status, reason: input.reason, decidedBy: current.user.id, decidedAt: new Date() }, include,
        }));
      });
    }
  }
  return VerificationController;
}
