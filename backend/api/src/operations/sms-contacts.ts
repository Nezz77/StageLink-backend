import { Body, Controller, Get, HttpCode, Post, Put, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { randomInt, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { seal, unseal, equal } from '../auth/security.js';
import type { AuthService } from '../auth/service.js';
import { PublicError } from '../auth/errors.js';
import { ProfileService } from '../profiles/service.js';
import { parse, schema, uuid } from '../payments/orders.js';
import { smsDeliveryStatus, smsDigest, smsPayload, sriLankaMobile } from '../../../shared/sms.js';
import { auditSmsConsent, invalidateQueuedSms } from '../../../shared/sms-consent.js';
import { databaseNow } from '../../../shared/database-clock.js';
import { payloadContext, sealSmsNumber } from '../../../shared/sms-verification.js';
const revision = z.number().int().min(0).max(2147483646);
const requestBody = z.object({ revision, number: sriLankaMobile }).strict();
const confirmBody = z.object({ challengeId: uuid, code: z.string().regex(/^\d{6}$/) }).strict();
const consentBody = z.object({ revision, bookingConsent: z.boolean(), marketingConsent: z.boolean() }).strict();
const revokeBody = z.object({ revision }).strict();
const optOutBody = z.object({ channel: z.enum(['booking', 'marketing', 'all']) }).strict();
const view = z.object({ revision, enabled: z.boolean(), verified: z.boolean(), last4: z.string().nullable(), verifiedAt: z.iso.datetime().nullable(), bookingConsent: z.boolean(), marketingConsent: z.boolean(), pending: z.object({ id: uuid, last4: z.string(), expiresAt: z.iso.datetime(), status: z.string() }).nullable() });
const history = z.object({ items: z.array(z.object({ id: uuid, status: z.string(), last4: z.string(), createdAt: z.iso.datetime(), confirmedAt: z.iso.datetime().nullable(), lastCode: z.string().nullable() })) });
const reminderHistory = z.object({ items: z.array(z.object({
    id: uuid, bookingId: uuid, startsAt: z.iso.datetime(), dueAt: z.iso.datetime(),
    offsetHours: z.union([z.literal(2), z.literal(24)]), status: smsDeliveryStatus, checkedAt: z.iso.datetime().nullable(),
})) });
const conflict = () => new PublicError(409, 'SMS_REVISION_CONFLICT', 'Reload your SMS contact before changing it.');
export function makeSmsContactsController(auth: AuthService) {
    const db = auth.deps.db, profiles = new ProfileService(auth);
    async function mutation(req: Request) { if (req.get('Origin') !== auth.config.WEB_ORIGIN || req.get('Sec-Fetch-Site') === 'cross-site' || !req.is('application/json'))
        throw new PublicError(403, 'ORIGIN_REJECTED', 'Open StageLink in its own browser tab and try again.'); const actor = await auth.authenticate(req.get('Authorization')); profiles.checkCsrf(actor, req.get('X-CSRF-Token')); return actor; }
    async function present(userId: string) { const contact = await db.smsContact.findUnique({ where: { userId } }), pending = contact?.pendingId ? await db.smsVerification.findFirst({ where: { id: contact.pendingId, userId, expiresAt: { gt: await databaseNow(db) }, codeDigest: { not: null } } }) : null; return view.parse({ revision: contact?.revision ?? 0, enabled: auth.config.SMS_VERIFICATION_ENABLED === 'true', verified: !!contact?.verifiedAt, last4: contact?.last4 ?? null, verifiedAt: contact?.verifiedAt?.toISOString() ?? null, bookingConsent: contact?.bookingConsent ?? false, marketingConsent: contact?.marketingConsent ?? false, pending: pending ? { id: pending.id, last4: pending.last4, expiresAt: pending.expiresAt.toISOString(), status: pending.status } : null }); }
    @ApiTags('SMS contact and consent')
    @ApiBearerAuth()
    @Controller('me')
    class SmsContactsController {
        @Get('sms-contact')
        @ApiOkResponse({ schema: schema(view) })
        async read(
        @Req()
        req: Request) { return present((await auth.authenticate(req.get('Authorization'))).user.id); }
        @Get('sms-verifications')
        @ApiOkResponse({ schema: schema(history) })
        async history(
        @Req()
        req: Request) { const actor = await auth.authenticate(req.get('Authorization')); return { items: (await db.smsVerification.findMany({ where: { userId: actor.user.id }, orderBy: { createdAt: 'desc' }, take: 20 })).map(r => ({ id: r.id, status: r.status, last4: r.last4, createdAt: r.createdAt.toISOString(), confirmedAt: r.confirmedAt?.toISOString() ?? null, lastCode: r.lastCode })) }; }
        @Get('booking-sms-reminders')
        @ApiOkResponse({ schema: schema(reminderHistory) })
        async reminders(@Req() req: Request) {
            const actor = await auth.authenticate(req.get('Authorization'));
            const rows = await db.bookingSmsReminder.findMany({
                where: { recipientId: actor.user.id }, orderBy: [{ dueAt: 'desc' }, { id: 'desc' }], take: 20,
                select: { id: true, bookingId: true, startsAt: true, dueAt: true, offsetHours: true, status: true, checkedAt: true },
            });
            return { items: rows.map(row => ({ ...row, startsAt: row.startsAt.toISOString(), dueAt: row.dueAt.toISOString(),
                checkedAt: row.checkedAt?.toISOString() ?? null })) };
        }
        @Post('sms-contact/verification')
        @HttpCode(200)
        @ApiBody({ schema: schema(requestBody) })
        @ApiOkResponse({ schema: schema(view) })
        async request(
        @Req()
        req: Request,
        @Body()
        raw: unknown) {
            const actor = await mutation(req), input = parse(requestBody, raw);
            profiles.verified(actor);
            if (auth.config.SMS_VERIFICATION_ENABLED !== 'true')
                throw new PublicError(503, 'SMS_DISABLED', 'SMS verification is not available yet.');
            await auth.limits.check('sms-user', actor.user.id, 3, 3600);
            await auth.limits.check('sms-number', input.number, 3, 3600);
            await auth.limits.check('sms-cooldown', actor.user.id, 1, 60);
            await db.$transaction(async (tx) => {
                const current = await profiles.actor(tx, actor);
                profiles.verified(current);
                const prior = await tx.smsContact.findUnique({ where: { userId: current.user.id } });
                if ((prior?.revision ?? 0) !== input.revision)
                    throw conflict();
                const id = randomUUID(), code = String(randomInt(0, 1000000)).padStart(6, '0');
                if (prior?.pendingId) {
                    await tx.smsVerification.updateMany({ where: { id: prior.pendingId, userId: actor.user.id, status: 'queued' }, data: { status: 'cancelled' } });
                    await tx.smsVerification.updateMany({ where: { id: prior.pendingId, userId: actor.user.id }, data: { codeDigest: null, sealedPayload: null } });
                }
                const now = await databaseNow(tx);
                await tx.smsVerification.create({ data: { id, userId: actor.user.id, targetDigest: smsDigest(auth.config, input.number), last4: input.number.slice(-4), codeDigest: smsDigest(auth.config, id + ':' + code), sealedPayload: seal(auth.config.AUTH_MAIL_KEY, { number: input.number, message: `Your StageLink contact verification code is ${code}. It expires in 10 minutes. Do not share it.` }, payloadContext(id)), createdAt: now, expiresAt: new Date(now.getTime() + 600000) } });
                await tx.smsContact.upsert({ where: { userId: actor.user.id }, create: { userId: actor.user.id, pendingId: id }, update: { pendingId: id, revision: { increment: 1 } } });
            });
            return present(actor.user.id);
        }
        @Post('sms-contact/confirm')
        @HttpCode(200)
        @ApiBody({ schema: schema(confirmBody) })
        @ApiOkResponse({ schema: schema(view) })
        async confirm(
        @Req()
        req: Request,
        @Body()
        raw: unknown) {
            const actor = await mutation(req), input = parse(confirmBody, raw);
            await auth.limits.check('sms-confirm', actor.user.id, 20, 3600);
            const ok = await db.$transaction(async (tx) => {
                const current = await profiles.actor(tx, actor);
                profiles.verified(current);
                const contact = await tx.smsContact.findUnique({ where: { userId: actor.user.id } }), row = await tx.smsVerification.findFirst({ where: { id: input.challengeId, userId: actor.user.id } });
                const now = await databaseNow(tx);
                if (!row || contact?.pendingId !== row.id || !row.codeDigest || !row.sealedPayload || row.expiresAt <= now || row.attempts >= 5 || !['sending', 'accepted', 'delivered', 'unknown'].includes(row.status))
                    return false;
                if (!equal(row.codeDigest, smsDigest(auth.config, row.id + ':' + input.code))) {
                    await tx.smsVerification.update({ where: { id: row.id }, data: { attempts: { increment: 1 }, ...(row.attempts === 4 ? { codeDigest: null, sealedPayload: null } : {}) } });
                    return false;
                }
                const payload = smsPayload.parse(unseal(auth.config.AUTH_MAIL_KEY, row.sealedPayload, payloadContext(row.id)));
                await tx.smsContact.update({ where: { userId: actor.user.id }, data: { sealedNumber: sealSmsNumber(auth.config, actor.user.id, payload.number), last4: row.last4, verifiedAt: now, pendingId: null, bookingConsent: false, marketingConsent: false, consentAt: null, revision: { increment: 1 } } });
                await tx.smsConsentEvent.create({ data: { userId: actor.user.id, revision: contact.revision + 1, action: 'verified', createdAt: now, last4: row.last4, targetDigest: row.targetDigest, bookingConsent: false, marketingConsent: false } });
                await tx.smsVerification.update({ where: { id: row.id }, data: { confirmedAt: now, codeDigest: null, sealedPayload: null } });
                return true;
            });
            if (!ok)
                throw new PublicError(400, 'SMS_CODE_INVALID', 'The verification code is invalid or expired. Request a new code.');
            return present(actor.user.id);
        }
        @Put('sms-contact/consent')
        @ApiBody({ schema: schema(consentBody) })
        @ApiOkResponse({ schema: schema(view) })
        async consent(@Req() req: Request, @Body() raw: unknown) {
            const actor = await mutation(req), input = parse(consentBody, raw);
            await db.$transaction(async tx => {
                const current = await profiles.actor(tx, actor);
                const contact = await tx.smsContact.findUnique({ where: { userId: actor.user.id } });
                if (!contact || contact.revision !== input.revision) throw conflict();
                if ((input.bookingConsent || input.marketingConsent) && (!contact.verifiedAt || !current.user.emailVerifiedAt)) {
                    throw new PublicError(403, 'SMS_VERIFICATION_REQUIRED', 'Verify your email and SMS number before opting in.');
                }
                const next = await auditSmsConsent(tx, auth.config, contact, input, 'consent');
                await tx.smsContact.update({ where: { userId: actor.user.id }, data: { bookingConsent: input.bookingConsent, marketingConsent: input.marketingConsent, consentAt: next.now, revision: next.revision } });
                await invalidateQueuedSms(tx, actor.user.id, input, next.revision);
            });
            return present(actor.user.id);
        }
        @Post('sms-contact/opt-out')
        @HttpCode(200)
        @ApiBody({ schema: schema(optOutBody) })
        @ApiOkResponse({ schema: schema(view) })
        async optOut(@Req() req: Request, @Body() raw: unknown) {
            const actor = await mutation(req), input = parse(optOutBody, raw);
            await db.$transaction(async tx => {
                await profiles.actor(tx, actor);
                const contact = await tx.smsContact.findUnique({ where: { userId: actor.user.id } });
                if (!contact) return;
                const choices = {
                    bookingConsent: input.channel === 'marketing' ? contact.bookingConsent : false,
                    marketingConsent: input.channel === 'booking' ? contact.marketingConsent : false,
                };
                let nextRevision = contact.revision;
                if (choices.bookingConsent !== contact.bookingConsent || choices.marketingConsent !== contact.marketingConsent) {
                    const next = await auditSmsConsent(tx, auth.config, contact, choices, 'consent');
                    nextRevision = next.revision;
                    await tx.smsContact.update({ where: { userId: actor.user.id }, data: { ...choices, consentAt: next.now, revision: next.revision } });
                }
                await invalidateQueuedSms(tx, actor.user.id, choices, nextRevision);
            });
            return present(actor.user.id);
        }
        @Post('sms-contact/revoke')
        @HttpCode(200)
        @ApiBody({ schema: schema(revokeBody) })
        @ApiOkResponse({ schema: schema(view) })
        async revoke(@Req() req: Request, @Body() raw: unknown) {
            const actor = await mutation(req), input = parse(revokeBody, raw);
            await db.$transaction(async tx => {
                await profiles.actor(tx, actor);
                const contact = await tx.smsContact.findUnique({ where: { userId: actor.user.id } });
                if (!contact || contact.revision !== input.revision) throw conflict();
                const choices = { bookingConsent: false, marketingConsent: false };
                const next = await auditSmsConsent(tx, auth.config, contact, choices, 'revoked');
                await tx.smsVerification.updateMany({ where: { userId: actor.user.id, status: 'queued' }, data: { status: 'cancelled' } });
                await tx.smsVerification.updateMany({ where: { userId: actor.user.id, OR: [{ codeDigest: { not: null } }, { sealedPayload: { not: null } }] }, data: { codeDigest: null, sealedPayload: null } });
                await tx.smsContact.update({ where: { userId: actor.user.id }, data: { pendingId: null, sealedNumber: null, last4: null, verifiedAt: null, ...choices, consentAt: null, revision: next.revision } });
                await invalidateQueuedSms(tx, actor.user.id, choices, next.revision);
            });
            return present(actor.user.id);
        }
    }
    return SmsContactsController;
}
