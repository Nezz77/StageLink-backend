import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOkResponse, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Prisma, SmsCampaign } from '../../../generated/prisma/client.js';
import { promotionalSmsBody, promotionalSmsMessage } from '../../../shared/promotional-sms.js';
import { PublicError } from '../auth/errors.js';
import type { AuthService } from '../auth/service.js';
import { parse, schema, uuid } from '../payments/orders.js';
import { ProfileService } from '../profiles/service.js';
const input = z.object({ id: uuid, body: promotionalSmsBody, recipientLimit: z.number().int().min(1).max(100) }).strict();
const fingerprint = z.string().regex(/^[0-9a-f]{64}$/);
const schedule = z.object({ scheduledFor: z.iso.datetime({ offset: true }), audienceFingerprint: fingerprint }).strict();
const cancel = z.object({ reason: z.string().trim().min(10).max(500) }).strict();
const empty = z.object({}).strict();
const count = z.number().int().nonnegative();
const countsSchema = z.object({ queued: count, sending: count, accepted: count, delivered: count, failed: count, unknown: count, skipped: count });
const campaignSchema = input.extend({
    state: z.enum(['draft', 'scheduled', 'cancelled']), message: z.string().max(160),
    createdAt: z.iso.datetime(), scheduledFor: z.iso.datetime().nullable(), cancelledAt: z.iso.datetime().nullable(),
    cancellationReason: z.string().nullable(), recipientCount: count, deliveryCounts: countsSchema, enabled: z.boolean(),
});
type Audience = {
    userId: string;
    revision: number;
};
const audienceHash = (id: string, audience: Audience[]) => createHash('sha256').update(JSON.stringify(['sms-campaign-v1', id, audience])).digest('hex');
const emptyCounts = (): z.infer<typeof countsSchema> => ({ queued: 0, sending: 0, accepted: 0, delivered: 0, failed: 0, unknown: 0, skipped: 0 });
async function eligible(tx: Prisma.TransactionClient, limit: number) {
    return tx.$queryRaw<Audience[]> `
    SELECT c.user_id AS "userId", c.revision FROM sms_contacts c JOIN auth_users u ON u.id=c.user_id
    WHERE c.marketing_consent AND c.verified_at IS NOT NULL AND c.sealed_number IS NOT NULL
      AND u.disabled_at IS NULL AND u.email_verified_at IS NOT NULL
      AND u.roles && ARRAY['customer','artist','renter']::"AuthRole"[]
    ORDER BY c.user_id LIMIT ${limit}`;
}
export function makeSmsCampaignController(auth: AuthService) {
    const db = auth.deps.db;
    const profiles = new ProfileService(auth);
    async function admin(req: Request) {
        const actor = await auth.authenticate(req.get('Authorization'));
        if (actor.session.activeRole !== 'admin')
            throw new PublicError(403, 'ROLE_FORBIDDEN', 'Administrator access is required.');
        profiles.verified(actor);
        return actor;
    }
    async function mutation<T>(req: Request, work: (tx: Prisma.TransactionClient, actor: Awaited<ReturnType<typeof admin>>) => Promise<T>) {
        if (req.get('Origin') !== auth.config.WEB_ORIGIN || req.get('Sec-Fetch-Site') === 'cross-site' || !req.is('application/json')) {
            throw new PublicError(403, 'ORIGIN_REJECTED', 'Open StageLink in its own browser tab and try again.');
        }
        const signedIn = await admin(req);
        profiles.checkCsrf(signedIn, req.get('X-CSRF-Token'));
        return db.$transaction(async (tx) => {
            const actor = await profiles.actor(tx, signedIn, undefined, true);
            profiles.verified(actor);
            return work(tx, actor);
        });
    }
    async function get(tx: Prisma.TransactionClient, id: string, lock = false) {
        if (lock)
            await tx.$queryRaw `SELECT id FROM sms_campaigns WHERE id=${id}::uuid FOR UPDATE`;
        const row = await tx.smsCampaign.findUnique({ where: { id } });
        if (!row)
            throw new PublicError(404, 'SMS_CAMPAIGN_NOT_FOUND', 'This SMS campaign is unavailable.');
        return row;
    }
    async function present(tx: Prisma.TransactionClient, row: SmsCampaign) {
        const deliveryCounts = emptyCounts();
        const groups = await tx.smsCampaignRecipient.groupBy({ by: ['status'], where: { campaignId: row.id }, _count: true });
        for (const group of groups)
            deliveryCounts[group.status] = group._count;
        const { id, body, recipientLimit, state, cancellationReason } = row;
        return { id, body, recipientLimit, state, cancellationReason,
            message: promotionalSmsMessage(body), enabled: auth.config.PROMOTIONAL_SMS_DELIVERY === 'true',
            createdAt: row.createdAt.toISOString(), scheduledFor: row.scheduledFor?.toISOString() ?? null,
            cancelledAt: row.cancelledAt?.toISOString() ?? null,
            recipientCount: Object.values(deliveryCounts).reduce((a, b) => a + b, 0), deliveryCounts };
    }
    @ApiTags('Promotional SMS')
    @ApiBearerAuth()
    @Controller('admin/sms-campaigns')
    class SmsCampaignController {
        @Post()
        @HttpCode(200)
        @ApiBody({ schema: schema(input) })
        @ApiOkResponse({ schema: schema(campaignSchema) })
        create(
        @Req()
        req: Request, 
        @Body()
        raw: unknown) {
            const data = parse(input, raw);
            data.id = data.id.toLowerCase();
            return mutation(req, async (tx, actor) => {
                await tx.smsCampaign.createMany({ data: [{ ...data, createdBy: actor.user.id }], skipDuplicates: true });
                const row = await get(tx, data.id);
                if (row.createdBy !== actor.user.id || row.body !== data.body || row.recipientLimit !== data.recipientLimit) {
                    throw new PublicError(409, 'SMS_CAMPAIGN_ID_REUSED', 'Use a new ID for another SMS campaign.');
                }
                return present(tx, row);
            });
        }
        @Get()
        @ApiQuery({ name: 'after', type: String, required: false })
        @ApiOkResponse({ schema: schema(z.object({ items: z.array(campaignSchema), nextCursor: uuid.nullable() })) })
        async list(
        @Req()
        req: Request, 
        @Query('after')
        raw?: string) {
            await admin(req);
            const after = raw === undefined ? undefined : parse(uuid, raw);
            return db.$transaction(async (tx) => {
                const rows = await tx.smsCampaign.findMany({ where: after ? { id: { gt: after } } : {}, orderBy: { id: 'asc' }, take: 31 });
                const items = await Promise.all(rows.slice(0, 30).map(row => present(tx, row)));
                return { items, nextCursor: rows.length > 30 ? items[29]!.id : null };
            }, { isolationLevel: 'RepeatableRead' });
        }
        @Get(':id')
        @ApiParam({ name: 'id', format: 'uuid' })
        @ApiOkResponse({ schema: schema(campaignSchema) })
        async read(
        @Req()
        req: Request, 
        @Param('id')
        raw: string) {
            await admin(req);
            return db.$transaction(async (tx) => present(tx, await get(tx, parse(uuid, raw))), { isolationLevel: 'RepeatableRead' });
        }
        @Post(':id/preview')
        @HttpCode(200)
        @ApiParam({ name: 'id', format: 'uuid' })
        @ApiBody({ schema: schema(empty) })
        @ApiOkResponse({ schema: schema(z.object({ recipientCount: count, recipientLimit: count, audienceFingerprint: fingerprint })) })
        preview(
        @Req()
        req: Request, 
        @Param('id')
        rawId: string, 
        @Body()
        raw: unknown) {
            parse(empty, raw);
            const id = parse(uuid, rawId).toLowerCase();
            return mutation(req, async (tx) => {
                const row = await get(tx, id);
                const audience = await eligible(tx, row.recipientLimit);
                return { recipientCount: audience.length, recipientLimit: row.recipientLimit, audienceFingerprint: audienceHash(id, audience) };
            });
        }
        @Post(':id/schedule')
        @HttpCode(200)
        @ApiParam({ name: 'id', format: 'uuid' })
        @ApiBody({ schema: schema(schedule) })
        @ApiOkResponse({ schema: schema(campaignSchema) })
        schedule(
        @Req()
        req: Request, 
        @Param('id')
        rawId: string, 
        @Body()
        raw: unknown) {
            const id = parse(uuid, rawId).toLowerCase(), data = parse(schedule, raw), scheduledFor = new Date(data.scheduledFor);
            return mutation(req, async (tx, actor) => {
                const row = await get(tx, id, true);
                if (row.state === 'scheduled' && row.scheduledFor?.getTime() === scheduledFor.getTime()) {
                    const saved = await tx.smsCampaignRecipient.findMany({ where: { campaignId: id }, orderBy: { userId: 'asc' } });
                    if (data.audienceFingerprint === audienceHash(id, saved.map(r => ({ userId: r.userId, revision: r.contactRevision }))))
                        return present(tx, row);
                }
                if (row.state !== 'draft')
                    throw new PublicError(409, 'SMS_CAMPAIGN_NOT_DRAFT', 'This SMS campaign already has a scheduling decision.');
                const [clock] = await tx.$queryRaw<{
                    now: Date;
                }[]> `SELECT clock_timestamp() AS now`;
                if (scheduledFor.getTime() <= clock!.now.getTime() || scheduledFor.getTime() > clock!.now.getTime() + 30 * 86400000) {
                    throw new PublicError(400, 'INVALID_CAMPAIGN_SCHEDULE', 'Choose a future time within the next 30 days.');
                }
                const audience = await eligible(tx, row.recipientLimit);
                if (data.audienceFingerprint !== audienceHash(id, audience))
                    throw new PublicError(409, 'SMS_CAMPAIGN_AUDIENCE_CHANGED', 'Preview the current SMS audience again.');
                if (!audience.length)
                    throw new PublicError(409, 'SMS_CAMPAIGN_NO_RECIPIENTS', 'No verified members have opted in to promotional SMS.');
                await tx.smsCampaignRecipient.createMany({ data: audience.map(r => ({ campaignId: id, userId: r.userId, contactRevision: r.revision })) });
                return present(tx, await tx.smsCampaign.update({ where: { id }, data: { state: 'scheduled', scheduledFor, scheduledBy: actor.user.id } }));
            });
        }
        @Post(':id/cancel')
        @HttpCode(200)
        @ApiParam({ name: 'id', format: 'uuid' })
        @ApiBody({ schema: schema(cancel) })
        @ApiOkResponse({ schema: schema(campaignSchema) })
        cancel(
        @Req()
        req: Request, 
        @Param('id')
        rawId: string, 
        @Body()
        raw: unknown) {
            const id = parse(uuid, rawId), { reason } = parse(cancel, raw);
            return mutation(req, async (tx, actor) => {
                const row = await get(tx, id, true);
                if (row.state === 'cancelled')
                    return present(tx, row);
                const updated = await tx.smsCampaign.update({ where: { id }, data: { state: 'cancelled', cancelledAt: new Date(), cancelledBy: actor.user.id, cancellationReason: reason } });
                await tx.smsCampaignRecipient.updateMany({ where: { campaignId: id, status: 'queued' }, data: { status: 'skipped', lastCode: 'CAMPAIGN_CANCELLED' } });
                return present(tx, updated);
            });
        }
    }
    return SmsCampaignController;
}
