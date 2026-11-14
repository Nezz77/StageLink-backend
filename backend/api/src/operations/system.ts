import { Body, Controller, Get, HttpCode, Post, Put, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOkResponse, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import type { SystemSetting, Prisma, SystemAuditAction } from '../../../generated/prisma/client.js';
import { PublicError } from '../auth/errors.js';
import type { AuthService } from '../auth/service.js';
import { parse, schema, uuid } from '../payments/orders.js';
import { ProfileService } from '../profiles/service.js';

const reason = z.string().trim().min(10).max(500);
const revision = z.number().int().min(1).max(2_147_483_647);
const note = z.string().trim().min(1).max(500);
const maintenance = z.discriminatedUnion('enabled', [
  z.object({ revision, enabled: z.literal(true), message: note.optional(), reason }).strict(),
  z.object({ revision, enabled: z.literal(false), reason }).strict(),
]);
const publicStatus = z.object({ maintenance: z.boolean(), message: note.nullable(), revision });
const dateTime = z.iso.datetime({ offset: true });
const announcement = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('publish'), id: uuid, title: z.string().trim().min(1).max(120), body: z.string().trim().min(1).max(1000),
    startsAt: dateTime, endsAt: dateTime.nullable(), reason,
  }).strict().refine(data => data.endsAt === null || Date.parse(data.endsAt) > Date.parse(data.startsAt)),
  z.object({ action: z.literal('unpublish'), id: uuid, reason }).strict(),
]);
const adminAnnouncements = z.object({
  items: z.array(z.object({
    id: uuid, title: z.string(), body: z.string(), startsAt: dateTime,
    endsAt: dateTime.nullable(), publishedAt: dateTime.nullable(),
  })),
  nextCursor: uuid.nullable(),
});
const announcementResult = z.object({ id: uuid, published: z.boolean() });
const cache = z.object({ scope: z.literal('public_announcements'), reason }).strict();
const cacheResult = z.object({ scope: z.literal('public_announcements'), version: z.string() });
const revoke = z.object({ userId: uuid, sessionId: uuid.optional(), reason }).strict();
const revokeResult = z.object({ userId: uuid, revoked: z.number().int().nonnegative() });
const sequence = z.string().regex(/^[1-9]\d{0,18}$/).refine(value => BigInt(value) <= 9_223_372_036_854_775_807n);
const auditPage = z.object({
  items: z.array(z.object({
    id: sequence, actorId: uuid, action: z.enum(['maintenance', 'announcement_publish', 'announcement_unpublish', 'announcement_cache_invalidate', 'sessions_revoke']),
    targetId: uuid.nullable(), reason, details: z.record(z.string(), z.unknown()), createdAt: z.iso.datetime(),
  })),
  nextCursor: sequence.nullable(),
});

function status(row: SystemSetting) {
  return { maintenance: row.maintenance, message: row.maintenanceMessage, revision: row.revision };
}

async function audit(
  tx: Prisma.TransactionClient, actorId: string, action: SystemAuditAction, reason: string,
  details: Prisma.InputJsonObject, targetId?: string,
) {
  await tx.systemAuditEntry.create({ data: { actorId, action, reason, details, targetId } });
}

async function incrementAnnouncementCache(tx: Prisma.TransactionClient) {
  return tx.systemSetting.update({
    where: { id: 1 }, data: { announcementCacheVersion: { increment: 1 } },
    select: { announcementCacheVersion: true },
  });
}

export function makeSystemControllers(auth: AuthService) {
  const db = auth.deps.db;
  const profiles = new ProfileService(auth);

  async function admin(req: Request) {
    const identity = await auth.authenticate(req.get('Authorization'));
    if (identity.session.activeRole !== 'admin') throw new PublicError(403, 'ROLE_FORBIDDEN', 'Administrator access is required.');
    profiles.verified(identity);
    return identity;
  }

  async function adminWrite<T>(
    req: Request, work: (tx: Prisma.TransactionClient, actorId: string) => Promise<T>, targetUserId?: string,
  ) {
    if (req.get('Origin') !== auth.config.WEB_ORIGIN || req.get('Sec-Fetch-Site') === 'cross-site' || !req.is('application/json')) {
      throw new PublicError(403, 'ORIGIN_REJECTED', 'Open StageLink in its own browser tab and try again.');
    }
    const identity = await admin(req);
    profiles.checkCsrf(identity, req.get('X-CSRF-Token'));
    return db.$transaction(async tx => {
      if (targetUserId) {
        for (const id of [...new Set([identity.user.id, targetUserId])].sort()) {
          await tx.$queryRaw`SELECT id FROM auth_users WHERE id=${id}::uuid FOR UPDATE`;
        }
      }
      const actor = await profiles.actor(tx, identity, undefined, true);
      profiles.verified(actor);
      if (actor.session.createdAt.getTime() < Date.now() - 15 * 60_000) {
        throw new PublicError(403, 'RECENT_LOGIN_REQUIRED', 'Sign in again before changing system controls.');
      }
      return work(tx, actor.user.id);
    });
  }

  @ApiTags('System status')
  @Controller('system')
  class PublicSystemController {
    @Get('public-status')
    @ApiOkResponse({ schema: schema(publicStatus) })
    async publicStatus() {
      return status(await db.systemSetting.findUniqueOrThrow({ where: { id: 1 } }));
    }
  }

  @ApiTags('Admin system controls')
  @ApiBearerAuth()
  @Controller('admin')
  class SystemController {
    @Put('system/maintenance')
    @ApiBody({ schema: schema(maintenance) })
    @ApiOkResponse({ schema: schema(publicStatus) })
    maintenance(@Req() req: Request, @Body() raw: unknown) {
      const input = parse(maintenance, raw);
      return adminWrite(req, async (tx, actorId) => {
        await tx.$queryRaw`SELECT id FROM system_settings WHERE id=1 FOR UPDATE`;
        const current = await tx.systemSetting.findUniqueOrThrow({ where: { id: 1 } });
        const message = input.enabled ? input.message ?? null : null;
        if (current.revision !== input.revision) throw new PublicError(409, 'SYSTEM_SETTINGS_CHANGED', 'Reload the system settings before saving.');
        if (current.maintenance === input.enabled && current.maintenanceMessage === message) return status(current);
        const row = await tx.systemSetting.update({
          where: { id: 1 }, data: { maintenance: input.enabled, maintenanceMessage: message, revision: { increment: 1 } },
        });
        await audit(tx, actorId, 'maintenance', input.reason, { enabled: row.maintenance, revision: row.revision });
        return status(row);
      });
    }

    @Get('announcements')
    @ApiQuery({ name: 'after', type: String, required: false })
    @ApiOkResponse({ schema: schema(adminAnnouncements) })
    async announcements(@Req() req: Request, @Query('after') raw?: string) {
      await admin(req);
      const after = raw === undefined ? undefined : parse(uuid, raw);
      const rows = await db.publicAnnouncement.findMany({
        where: after ? { id: { gt: after } } : {}, orderBy: { id: 'asc' }, take: 31,
      });
      const items = rows.slice(0, 30).map(row => ({
        ...row, startsAt: row.startsAt.toISOString(), endsAt: row.endsAt?.toISOString() ?? null,
        publishedAt: row.publishedAt?.toISOString() ?? null,
      }));
      return { items, nextCursor: rows.length > 30 ? items[29]!.id : null };
    }

    @Put('announcements')
    @ApiBody({ schema: schema(announcement) })
    @ApiOkResponse({ schema: schema(announcementResult) })
    announcement(@Req() req: Request, @Body() raw: unknown) {
      const input = parse(announcement, raw);
      return adminWrite(req, async (tx, actorId) => {
        const id = input.id.toLowerCase();
        await tx.$queryRaw`SELECT id FROM system_settings WHERE id=1 FOR UPDATE`;
        const existing = await tx.publicAnnouncement.findUnique({ where: { id } });
        if (input.action === 'publish') {
          const startsAt = new Date(input.startsAt), endsAt = input.endsAt ? new Date(input.endsAt) : null;
          if (existing?.publishedAt && existing.title === input.title && existing.body === input.body &&
            existing.startsAt.getTime() === startsAt.getTime() && (existing.endsAt?.getTime() ?? null) === (endsAt?.getTime() ?? null)) {
            return { id, published: true };
          }
          const data = { title: input.title, body: input.body, startsAt, endsAt, publishedAt: new Date() };
          await tx.publicAnnouncement.upsert({ where: { id }, create: { id, ...data }, update: data });
          await incrementAnnouncementCache(tx);
          await audit(tx, actorId, 'announcement_publish', input.reason, { startsAt: startsAt.toISOString(), endsAt: endsAt?.toISOString() ?? null }, id);
          return { id, published: true };
        }
        if (!existing) throw new PublicError(404, 'ANNOUNCEMENT_NOT_FOUND', 'This announcement is unavailable.');
        if (existing.publishedAt) {
          await tx.publicAnnouncement.update({ where: { id }, data: { publishedAt: null } });
          await incrementAnnouncementCache(tx);
          await audit(tx, actorId, 'announcement_unpublish', input.reason, {}, id);
        }
        return { id, published: false };
      });
    }

    @Post('cache/invalidate')
    @HttpCode(200)
    @ApiBody({ schema: schema(cache) })
    @ApiOkResponse({ schema: schema(cacheResult) })
    invalidate(@Req() req: Request, @Body() raw: unknown) {
      const input = parse(cache, raw);
      return adminWrite(req, async (tx, actorId) => {
        const { announcementCacheVersion } = await incrementAnnouncementCache(tx);
        const result = { scope: input.scope, version: String(announcementCacheVersion) };
        await audit(tx, actorId, 'announcement_cache_invalidate', input.reason, result);
        return result;
      });
    }

    @Post('sessions/revoke')
    @HttpCode(200)
    @ApiBody({ schema: schema(revoke) })
    @ApiOkResponse({ schema: schema(revokeResult) })
    revoke(@Req() req: Request, @Body() raw: unknown) {
      const input = parse(revoke, raw);
      const userId = input.userId.toLowerCase();
      return adminWrite(req, async (tx, actorId) => {
        const account = await tx.authUser.findUnique({ where: { id: userId }, select: { id: true } });
        const sessionId = input.sessionId?.toLowerCase();
        if (!account || (sessionId && !await tx.authSession.findFirst({ where: { id: sessionId, userId }, select: { id: true } }))) {
          throw new PublicError(404, 'SESSION_SCOPE_NOT_FOUND', 'This session scope is unavailable.');
        }
        const now = new Date();
        const { count } = await tx.authSession.updateMany({
          where: { userId, ...(sessionId ? { id: sessionId } : {}), revokedAt: null, expiresAt: { gt: now } },
          data: { revokedAt: now },
        });
        await audit(tx, actorId, 'sessions_revoke', input.reason, { sessionId: sessionId ?? null, revoked: count }, userId);
        return { userId, revoked: count };
      }, userId);
    }

    @Get('audit')
    @ApiQuery({ name: 'before', type: String, required: false })
    @ApiOkResponse({ schema: schema(auditPage) })
    async audit(@Req() req: Request, @Query('before') raw?: string) {
      await admin(req);
      const before = raw === undefined ? undefined : BigInt(parse(sequence, raw));
      const rows = await db.systemAuditEntry.findMany({
        where: before ? { id: { lt: before } } : {}, orderBy: { id: 'desc' }, take: 31,
      });
      const items = rows.slice(0, 30).map(row => ({ ...row, id: String(row.id), createdAt: row.createdAt.toISOString() }));
      return { items, nextCursor: rows.length > 30 ? items[29]!.id : null };
    }
  }

  return [PublicSystemController, SystemController];
}
