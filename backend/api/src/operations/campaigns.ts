import { Body, Controller, Get, HttpCode, Param, Post, Put, Query, Req, UseInterceptors } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiNoContentResponse, ApiOkResponse, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import { NoFilesInterceptor } from '@nestjs/platform-express';
import type { Request } from 'express';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Prisma, PromotionalCampaign } from '../../../generated/prisma/client.js';
import { databaseNow } from '../../../shared/database-clock.js';
import { readPromotionalUnsubscribeToken, revokePromotionalConsent } from '../../../shared/promotional-unsubscribe.js';
import { PublicError } from '../auth/errors.js';
import type { AuthService } from '../auth/service.js';
import { parse, schema, uuid } from '../payments/orders.js';
import { ProfileService } from '../profiles/service.js';

const revision = z.number().int().min(0).max(2_147_483_646);
const preferences = z.object({ revision: revision.max(2_147_483_647), emailOptIn: z.boolean() });
const consent = z.object({ revision, emailOptIn: z.boolean() }).strict();
const campaignInput = z.object({
  id: uuid,
  subject: z.string().trim().min(1).max(140).regex(/^[^\r\n]+$/),
  body: z.string().trim().min(1).max(4000),
  recipientLimit: z.number().int().min(1).max(100),
}).strict();
const fingerprint = z.string().regex(/^[0-9a-f]{64}$/);
const schedule = z.object({ scheduledFor: z.iso.datetime({ offset: true }), audienceFingerprint: fingerprint }).strict();
const cancel = z.object({ reason: z.string().trim().min(10).max(500) }).strict();
const empty = z.object({}).strict();
const oneClick = z.object({ 'List-Unsubscribe': z.literal('One-Click') }).strict();
const count = z.number().int().nonnegative();
const state = z.enum(['draft', 'scheduled', 'cancelled']);
const deliveryCounts = z.object({ queued: count, sending: count, accepted: count, failed: count, unknown: count, skipped: count });
const campaign = campaignInput.extend({
  state, scheduledFor: z.iso.datetime().nullable(), createdAt: z.iso.datetime(),
  cancelledAt: z.iso.datetime().nullable(), cancellationReason: z.string().nullable(),
  recipientCount: count, deliveryCounts,
});
const preview = z.object({ recipientCount: count, recipientLimit: count, audienceFingerprint: fingerprint });

type AudienceMember = { user_id: string; revision: number };

export function audienceFingerprint(campaignId: string, recipients: AudienceMember[]) {
  return createHash('sha256').update(JSON.stringify([campaignId, recipients.map(row => [row.user_id, row.revision])])).digest('hex');
}

async function eligible(tx: Prisma.TransactionClient, limit: number) {
  return tx.$queryRaw<AudienceMember[]>`
    SELECT p.user_id, p.revision
    FROM marketing_email_preferences p
    JOIN auth_users u ON u.id = p.user_id
    WHERE p.consent_email = u.email
      AND u.email_verified_at IS NOT NULL AND u.disabled_at IS NULL
      AND u.roles && ARRAY['customer', 'artist', 'renter']::"AuthRole"[]
    ORDER BY p.user_id LIMIT ${limit}`;
}

async function summarizeDelivery(tx: Prisma.TransactionClient, ids: string[]) {
  const counts = new Map<string, z.infer<typeof deliveryCounts>>();
  for (const id of ids) counts.set(id, { queued: 0, sending: 0, accepted: 0, failed: 0, unknown: 0, skipped: 0 });
  if (!ids.length) return counts;
  const groups = await tx.promotionalCampaignRecipient.groupBy({
    by: ['campaignId', 'deliveryStatus'], where: { campaignId: { in: ids } }, _count: { _all: true },
  });
  for (const group of groups) counts.get(group.campaignId)![group.deliveryStatus] = group._count._all;
  return counts;
}

function present(campaign: PromotionalCampaign, counts: z.infer<typeof deliveryCounts>) {
  const { id, subject, body, recipientLimit, state, scheduledFor, createdAt, cancelledAt, cancellationReason } = campaign;
  return {
    id, subject, body, recipientLimit, state, createdAt: createdAt.toISOString(), scheduledFor: scheduledFor?.toISOString() ?? null,
    cancelledAt: cancelledAt?.toISOString() ?? null, cancellationReason,
    recipientCount: Object.values(counts).reduce((total, value) => total + value, 0), deliveryCounts: counts,
  };
}

export function makeCampaignControllers(auth: AuthService) {
  const db = auth.deps.db;
  const profiles = new ProfileService(auth);
  const identity = (req: Request) => auth.authenticate(req.get('Authorization'));

  async function mutation<T>(req: Request, admin: boolean, work: (tx: Prisma.TransactionClient, actor: Awaited<ReturnType<typeof identity>>) => Promise<T>) {
    if (req.get('Origin') !== auth.config.WEB_ORIGIN || req.get('Sec-Fetch-Site') === 'cross-site' || !req.is('application/json')) {
      throw new PublicError(403, 'ORIGIN_REJECTED', 'Open StageLink in its own browser tab and try again.');
    }
    const signedIn = await identity(req);
    profiles.checkCsrf(signedIn, req.get('X-CSRF-Token'));
    return db.$transaction(async tx => {
      const actor = await profiles.actor(tx, signedIn, undefined, admin);
      if (admin) profiles.verified(actor);
      return work(tx, actor);
    });
  }

  async function adminRead(req: Request) {
    const signedIn = await identity(req);
    if (signedIn.session.activeRole !== 'admin') throw new PublicError(403, 'ROLE_FORBIDDEN', 'Administrator access is required.');
    profiles.verified(signedIn);
  }

  async function getCampaign(tx: Prisma.TransactionClient, id: string) {
    const row = await tx.promotionalCampaign.findUnique({
      where: { id },
    });
    if (!row) throw new PublicError(404, 'CAMPAIGN_NOT_FOUND', 'This campaign is unavailable.');
    return row;
  }

  async function presentOne(tx: Prisma.TransactionClient, row: PromotionalCampaign) {
    return present(row, (await summarizeDelivery(tx, [row.id])).get(row.id)!);
  }

  async function lockCampaign(tx: Prisma.TransactionClient, id: string) {
    await tx.$queryRaw`SELECT id FROM promotional_campaigns WHERE id=${id}::uuid FOR UPDATE`;
    return getCampaign(tx, id);
  }

  @ApiTags('Promotional consent')
  @ApiBearerAuth()
  @Controller('me/marketing-preferences')
  class ConsentController {
    @Get()
    @ApiOkResponse({ schema: schema(preferences) })
    async get(@Req() req: Request) {
      const { user } = await identity(req);
      const row = await db.marketingEmailPreference.findUnique({ where: { userId: user.id } });
      return { revision: row?.revision ?? 0, emailOptIn: row?.consentEmail === user.email && Boolean(user.emailVerifiedAt) };
    }

    @Put()
    @ApiBody({ schema: schema(consent) })
    @ApiOkResponse({ schema: schema(preferences) })
    update(@Req() req: Request, @Body() raw: unknown) {
      const input = parse(consent, raw);
      return mutation(req, false, async (tx, { user }) => {
        if (input.emailOptIn && (!user.emailVerifiedAt || !user.roles.some(role => role !== 'admin'))) {
          throw new PublicError(403, 'MARKETING_CONSENT_UNAVAILABLE', 'Use a verified member account to opt in.');
        }
        const where = { userId: user.id };
        const existing = await tx.marketingEmailPreference.findUnique({ where });
        if ((existing?.revision ?? 0) !== input.revision) {
          throw new PublicError(409, 'MARKETING_PREFERENCES_CHANGED', 'Reload your marketing preferences before saving.');
        }
        const consentEmail = input.emailOptIn ? user.email : null;
        if ((existing?.consentEmail ?? null) === consentEmail) return { revision: input.revision, emailOptIn: input.emailOptIn };
        const data = { consentEmail, revision: input.revision + 1, updatedAt: new Date() };
        await tx.marketingEmailPreference.upsert({ where, create: { ...where, ...data }, update: data });
        return { revision: data.revision, emailOptIn: input.emailOptIn };
      });
    }
  }

  @ApiTags('Promotional campaigns')
  @ApiBearerAuth()
  @Controller('admin/campaigns')
  class CampaignController {
    @Post()
    @HttpCode(200)
    @ApiBody({ schema: schema(campaignInput) })
    @ApiOkResponse({ schema: schema(campaign) })
    create(@Req() req: Request, @Body() raw: unknown) {
      const input = parse(campaignInput, raw);
      const id = input.id.toLowerCase();
      return mutation(req, true, async (tx, actor) => {
        await tx.promotionalCampaign.createMany({ data: [{ ...input, id, createdBy: actor.user.id }], skipDuplicates: true });
        const row = await getCampaign(tx, id);
        if (row.createdBy !== actor.user.id || row.subject !== input.subject || row.body !== input.body ||
          row.recipientLimit !== input.recipientLimit) throw new PublicError(409, 'CAMPAIGN_ID_REUSED', 'Use a new ID for another campaign.');
        return presentOne(tx, row);
      });
    }

    @Get()
    @ApiQuery({ name: 'after', type: String, required: false })
    @ApiOkResponse({ schema: schema(z.object({ items: z.array(campaign), nextCursor: uuid.nullable() })) })
    async list(@Req() req: Request, @Query('after') raw?: string) {
      await adminRead(req);
      const after = raw === undefined ? undefined : parse(uuid, raw);
      const rows = await db.promotionalCampaign.findMany({
        where: after ? { id: { gt: after } } : {}, orderBy: { id: 'asc' }, take: 31,
      });
      const page = rows.slice(0, 30);
      const counts = await summarizeDelivery(db, page.map(row => row.id));
      const items = page.map(row => present(row, counts.get(row.id)!));
      return { items, nextCursor: rows.length > 30 ? items[29]!.id : null };
    }

    @Get(':id')
    @ApiParam({ name: 'id', format: 'uuid' })
    @ApiOkResponse({ schema: schema(campaign) })
    async read(@Req() req: Request, @Param('id') rawId: string) {
      await adminRead(req);
      const row = await getCampaign(db, parse(uuid, rawId).toLowerCase());
      return presentOne(db, row);
    }

    @Post(':id/preview')
    @HttpCode(200)
    @ApiParam({ name: 'id', format: 'uuid' })
    @ApiBody({ schema: schema(empty) })
    @ApiOkResponse({ schema: schema(preview) })
    preview(@Req() req: Request, @Param('id') rawId: string, @Body() raw: unknown) {
      parse(empty, raw);
      const id = parse(uuid, rawId).toLowerCase();
      return mutation(req, true, async tx => {
        const row = await getCampaign(tx, id);
        const recipients = await eligible(tx, row.recipientLimit);
        return { recipientLimit: row.recipientLimit, recipientCount: recipients.length, audienceFingerprint: audienceFingerprint(id, recipients) };
      });
    }

    @Post(':id/schedule')
    @HttpCode(200)
    @ApiParam({ name: 'id', format: 'uuid' })
    @ApiBody({ schema: schema(schedule) })
    @ApiOkResponse({ schema: schema(campaign) })
    schedule(@Req() req: Request, @Param('id') rawId: string, @Body() raw: unknown) {
      const id = parse(uuid, rawId).toLowerCase();
      const input = parse(schedule, raw);
      const scheduledFor = new Date(input.scheduledFor);
      return mutation(req, true, async (tx, actor) => {
        const row = await lockCampaign(tx, id);
        if (row.state === 'scheduled' && row.scheduledFor?.getTime() === scheduledFor.getTime()) {
          const recipients = await tx.promotionalCampaignRecipient.findMany({
            where: { campaignId: id }, orderBy: { userId: 'asc' }, select: { userId: true, consentRevision: true },
          });
          if (input.audienceFingerprint === audienceFingerprint(id, recipients.map(row => ({ user_id: row.userId, revision: row.consentRevision })))) {
            return presentOne(tx, row);
          }
        }
        if (row.state !== 'draft') throw new PublicError(409, 'CAMPAIGN_NOT_DRAFT', 'This campaign already has a scheduling decision.');
        const now = (await databaseNow(tx)).getTime();
        if (scheduledFor.getTime() <= now || scheduledFor.getTime() > now + 30 * 86_400_000) {
          throw new PublicError(400, 'INVALID_CAMPAIGN_SCHEDULE', 'Choose a future time within the next 30 days.');
        }
        const recipients = await eligible(tx, row.recipientLimit);
        if (input.audienceFingerprint !== audienceFingerprint(id, recipients)) {
          throw new PublicError(409, 'CAMPAIGN_AUDIENCE_CHANGED', 'Preview the current eligible audience again.');
        }
        if (!recipients.length) throw new PublicError(409, 'CAMPAIGN_NO_RECIPIENTS', 'No verified members have opted in.');
        await tx.promotionalCampaignRecipient.createMany({
          data: recipients.map(recipient => ({ campaignId: id, userId: recipient.user_id, consentRevision: recipient.revision })),
        });
        const updated = await tx.promotionalCampaign.update({
          where: { id }, data: { state: 'scheduled', scheduledFor, scheduledBy: actor.user.id },
        });
        return presentOne(tx, updated);
      });
    }

    @Post(':id/cancel')
    @HttpCode(200)
    @ApiParam({ name: 'id', format: 'uuid' })
    @ApiBody({ schema: schema(cancel) })
    @ApiOkResponse({ schema: schema(campaign) })
    cancel(@Req() req: Request, @Param('id') rawId: string, @Body() raw: unknown) {
      const id = parse(uuid, rawId).toLowerCase();
      const { reason } = parse(cancel, raw);
      return mutation(req, true, async (tx, actor) => {
        const row = await lockCampaign(tx, id);
        if (row.state === 'cancelled') return presentOne(tx, row);
        const cancelledAt = await databaseNow(tx);
        const updated = await tx.promotionalCampaign.update({
          where: { id }, data: { state: 'cancelled', cancelledAt, cancelledBy: actor.user.id, cancellationReason: reason },
        });
        await tx.promotionalCampaignRecipient.updateMany({
          where: { campaignId: id, deliveryStatus: 'queued' },
          data: { deliveryStatus: 'skipped', resolvedAt: cancelledAt, deliveryCode: 'CAMPAIGN_CANCELLED' },
        });
        return presentOne(tx, updated);
      });
    }
  }
  @ApiTags('Promotional consent')
  @Controller('marketing/unsubscribe')
  class UnsubscribeController {
    @Post()
    @HttpCode(204)
    @UseInterceptors(NoFilesInterceptor({ limits: { fieldNameSize: 32, fieldSize: 32, fields: 1, parts: 2 } }))
    @ApiConsumes('application/x-www-form-urlencoded', 'multipart/form-data')
    @ApiQuery({ name: 'token', type: String })
    @ApiBody({ schema: schema(oneClick) })
    @ApiNoContentResponse({ description: 'Promotional consent revoked or already inactive.' })
    async unsubscribe(@Req() req: Request, @Query('token') rawToken: unknown, @Body() body: unknown) {
      if ((!req.is('application/x-www-form-urlencoded') && !req.is('multipart/form-data')) ||
        !oneClick.safeParse(body).success) {
        throw new PublicError(400, 'INVALID_UNSUBSCRIBE_REQUEST', 'Invalid unsubscribe request.');
      }
      const recipient = readPromotionalUnsubscribeToken(auth.config.AUTH_MAIL_KEY, rawToken);
      if (!recipient) throw new PublicError(400, 'INVALID_UNSUBSCRIBE_REQUEST', 'Invalid unsubscribe request.');
      await revokePromotionalConsent(db, recipient);
    }
  }
  return [ConsentController, CampaignController, UnsubscribeController];
}
