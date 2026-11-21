import { z } from 'zod';
import type { PrismaClient } from '../generated/prisma/client.js';
import { seal, unseal } from '../api/src/auth/security.js';
import { databaseNow } from './database-clock.js';
import type { Config } from './config.js';
import { TextLk, reserveSmsSubmission, smsPayload, type SmsResult } from './sms.js';
export const payloadContext = (id: string) => 'stagelink-sms-payload-v1:' + id;
export const contactContext = (userId: string) => 'stagelink-sms-contact-v1:' + userId;
export async function processSmsVerifications(db: PrismaClient, config: Config, transport: Pick<TextLk, 'send' | 'read'> = new TextLk(config)) {
    await db.$executeRaw `UPDATE sms_verifications SET status='unknown',last_code='SEND_INTERRUPTED' WHERE status='sending' AND sending_at<clock_timestamp()-interval '30 seconds'`;
    await db.$executeRaw `UPDATE sms_verifications SET code_digest=NULL,sealed_payload=NULL,status=CASE WHEN status='queued' THEN 'cancelled' ELSE status END WHERE expires_at<=clock_timestamp() AND (code_digest IS NOT NULL OR sealed_payload IS NOT NULL)`;
    if (config.SMS_VERIFICATION_ENABLED !== 'true')
        return;
    const candidate = await db.smsVerification.findFirst({ where: { status: 'queued', expiresAt: { gt: await databaseNow(db) } }, orderBy: { createdAt: 'asc' } });
    if (candidate) {
        const claimed = await db.$transaction(async (tx) => {
            await tx.$queryRaw `SELECT id FROM auth_users WHERE id=${candidate.userId}::uuid FOR UPDATE`;
            const row = await tx.smsVerification.findUniqueOrThrow({ where: { id: candidate.id } }), contact = await tx.smsContact.findUnique({ where: { userId: row.userId } }), user = await tx.authUser.findUniqueOrThrow({ where: { id: row.userId } });
            if (row.status !== 'queued')
                return null;
            if (!row.sealedPayload || row.expiresAt <= await databaseNow(tx) || user.disabledAt || !user.emailVerifiedAt || contact?.pendingId !== row.id) {
                await tx.smsVerification.update({ where: { id: row.id }, data: { status: 'cancelled', codeDigest: null, sealedPayload: null } });
                return null;
            }
            const sendingAt = await reserveSmsSubmission(tx, config);
            if (!sendingAt)
                return null;
            if (sendingAt >= row.expiresAt) {
                await tx.smsVerification.update({ where: { id: row.id }, data: { status: 'cancelled', codeDigest: null, sealedPayload: null } });
                return null;
            }
            return tx.smsVerification.update({ where: { id: row.id }, data: { status: 'sending', sendingAt } });
        });
        if (claimed) {
            let result: SmsResult;
            try {
                const payload = smsPayload.parse(unseal(config.AUTH_MAIL_KEY, claimed.sealedPayload!, payloadContext(claimed.id)));
                result = await transport.send(payload, claimed.targetDigest).catch(() => ({ status: 'unknown' as const, providerId: null, code: 'PROVIDER_OUTCOME_UNKNOWN' }));
            }
            catch {
                result = { status: 'failed', providerId: null, code: 'INVALID_ENCRYPTED_PAYLOAD' };
            }
            await db.smsVerification.updateMany({ where: { id: claimed.id, status: { in: ['sending', 'unknown'] } }, data: { status: result.status, providerId: result.providerId, lastCode: result.code, checkedAt: await databaseNow(db), ...(result.status === 'failed' ? { codeDigest: null, sealedPayload: null } : {}) } });
        }
    }
    const now = await databaseNow(db);
    const pending = await db.smsVerification.findFirst({ where: { sendingAt: { gt: new Date(now.getTime() - 86400000) }, providerId: { not: null }, status: { in: ['accepted', 'unknown'] }, OR: [{ checkedAt: null }, { checkedAt: { lt: new Date(now.getTime() - 30000) } }] }, orderBy: { checkedAt: { sort: 'asc', nulls: 'first' } } });
    if (pending) {
        const result = await transport.read(pending.providerId!, pending.targetDigest);
        // A temporary retrieval failure does not overwrite a previously accepted status.
        if (result.status !== 'unknown')
            await db.smsVerification.updateMany({ where: { id: pending.id, providerId: pending.providerId, status: { in: ['accepted', 'unknown'] } }, data: { status: result.status, lastCode: result.code, checkedAt: await databaseNow(db) } });
        else
            await db.smsVerification.updateMany({ where: { id: pending.id, status: { in: ['accepted', 'unknown'] } }, data: { lastCode: result.code, checkedAt: await databaseNow(db) } });
    }
}
export const verifiedNumber = z.object({ number: z.string().regex(/^947\d{8}$/) }).strict();
export function sealSmsNumber(config: Config, userId: string, number: string) { return seal(config.AUTH_MAIL_KEY, { number }, contactContext(userId)); }
