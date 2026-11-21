import { z } from 'zod';
import type { PrismaClient } from '../generated/prisma/client.js';
import { unseal } from '../api/src/auth/security.js';
import type { Config } from './config.js';
import { contactContext, verifiedNumber } from './sms-verification.js';
import { TextLk, reserveSmsSubmission, smsDigest, type SmsResult } from './sms.js';
// Keep the full message within one GSM basic-alphabet SMS, including opt-out instructions.
export const promotionalSmsBody = z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9 .,!?"'():;@#$%&*+=_\/-]+$/);
export const promotionalSmsMessage = (body: string) => 'StageLink: ' + promotionalSmsBody.parse(body) + ' Stop SMS: StageLink > Account > SMS preferences.';
type Transport = Pick<TextLk, 'send' | 'read'>;
async function databaseNow(db: PrismaClient) {
    const [clock] = await db.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
    return clock!.now;
}

export async function processPromotionalSms(db: PrismaClient, config: Config, transport: Transport = new TextLk(config)) {
    await db.$executeRaw `
    UPDATE sms_campaign_recipients SET status='unknown', last_code='SEND_INTERRUPTED'
    WHERE status='sending' AND sending_at<clock_timestamp()-interval '30 seconds'`;
    // Expired or revoked consent is invalidated even when provider delivery is paused.
    await db.$executeRaw `
    UPDATE sms_campaign_recipients r SET status='skipped', last_code='CAMPAIGN_OR_CONSENT_INELIGIBLE'
    FROM sms_campaigns c WHERE c.id=r.campaign_id AND r.status='queued' AND (
      c.state<>'scheduled' OR c.scheduled_for<clock_timestamp()-interval '24 hours'
      OR NOT EXISTS (SELECT 1 FROM sms_contacts s JOIN auth_users u ON u.id=s.user_id
        WHERE s.user_id=r.user_id AND s.revision=r.contact_revision AND s.marketing_consent
          AND s.verified_at IS NOT NULL AND s.sealed_number IS NOT NULL
          AND u.disabled_at IS NULL AND u.email_verified_at IS NOT NULL
          AND u.roles && ARRAY['customer','artist','renter']::"AuthRole"[]))`;
    if (config.PROMOTIONAL_SMS_DELIVERY !== 'true')
        return;
    const [candidate] = await db.$queryRaw<{
        campaignId: string;
        userId: string;
    }[]> `
    SELECT r.campaign_id AS "campaignId", r.user_id AS "userId" FROM sms_campaign_recipients r
    JOIN sms_campaigns c ON c.id=r.campaign_id
    WHERE r.status='queued' AND c.state='scheduled' AND c.scheduled_for<=clock_timestamp()
    ORDER BY c.scheduled_for,r.campaign_id,r.user_id LIMIT 1`;
    if (candidate) {
        const claim = await db.$transaction(async (tx) => {
            // Consent mutations lock the user; cancellation locks the campaign. Budget is last.
            await tx.$queryRaw `SELECT id FROM auth_users WHERE id=${candidate.userId}::uuid FOR UPDATE`;
            await tx.$queryRaw `SELECT id FROM sms_campaigns WHERE id=${candidate.campaignId}::uuid FOR UPDATE`;
            const row = await tx.smsCampaignRecipient.findUnique({
                where: { campaignId_userId: candidate }, include: { campaign: true, user: { include: { smsContact: true } } },
            });
            if (!row || row.status !== 'queued')
                return null;
            const [clock] = await tx.$queryRaw<{
                now: Date;
            }[]> `SELECT clock_timestamp() AS now`;
            const c = row.campaign, user = row.user, contact = user.smsContact;
            if (c.state !== 'scheduled' || !c.scheduledFor || c.scheduledFor.getTime() < clock!.now.getTime() - 86400000 ||
                user.disabledAt || !user.emailVerifiedAt || !user.roles.some(role => role !== 'admin') ||
                !contact?.verifiedAt || !contact.marketingConsent || contact.revision !== row.contactRevision || !contact.sealedNumber) {
                await tx.smsCampaignRecipient.update({ where: { campaignId_userId: candidate }, data: { status: 'skipped', lastCode: 'CAMPAIGN_OR_CONSENT_INELIGIBLE' } });
                return null;
            }
            if (c.scheduledFor > clock!.now)
                return null;
            let number: string;
            try {
                number = verifiedNumber.parse(unseal(config.AUTH_MAIL_KEY, contact.sealedNumber, contactContext(user.id))).number;
            }
            catch {
                await tx.smsCampaignRecipient.update({ where: { campaignId_userId: candidate }, data: { status: 'failed', lastCode: 'INVALID_SMS_CONTACT' } });
                return null;
            }
            const sendingAt = await reserveSmsSubmission(tx, config);
            if (!sendingAt)
                return null;
            if (sendingAt.getTime() >= c.scheduledFor.getTime() + 86400000) {
                await tx.smsCampaignRecipient.update({ where: { campaignId_userId: candidate }, data: { status: 'skipped', lastCode: 'CAMPAIGN_EXPIRED' } });
                return null;
            }
            const targetDigest = smsDigest(config, number);
            await tx.smsCampaignRecipient.update({ where: { campaignId_userId: candidate }, data: { status: 'sending', sendingAt, targetDigest } });
            return { number, targetDigest, sendingAt, message: promotionalSmsMessage(c.body) };
        });
        if (claim) {
            const result = await transport.send({ number: claim.number, message: claim.message }, claim.targetDigest).catch((): SmsResult => ({ status: 'unknown', providerId: null, code: 'PROVIDER_OUTCOME_UNKNOWN' }));
            await db.smsCampaignRecipient.updateMany({
                where: { ...candidate, status: { in: ['sending', 'unknown'] }, sendingAt: claim.sendingAt },
                data: { status: result.status, providerId: result.providerId, lastCode: result.code, checkedAt: await databaseNow(db) },
            });
        }
    }
    const [pending] = await db.$queryRaw<{
        campaignId: string;
        userId: string;
        providerId: string;
        targetDigest: string;
        status: 'accepted' | 'unknown';
        checkedAt: Date | null;
    }[]> `
    SELECT campaign_id AS "campaignId",user_id AS "userId",provider_id AS "providerId",target_digest AS "targetDigest",status,checked_at AS "checkedAt"
    FROM sms_campaign_recipients WHERE status IN ('accepted','unknown') AND provider_id IS NOT NULL
      AND sending_at>clock_timestamp()-interval '24 hours' AND (checked_at IS NULL OR checked_at<clock_timestamp()-interval '30 seconds')
    ORDER BY checked_at NULLS FIRST,campaign_id,user_id LIMIT 1`;
    if (pending) {
        const result = await transport.read(pending.providerId, pending.targetDigest);
        await db.smsCampaignRecipient.updateMany({
            where: { campaignId: pending.campaignId, userId: pending.userId, providerId: pending.providerId, status: pending.status, checkedAt: pending.checkedAt },
            data: { status: result.status === 'unknown' ? pending.status : result.status, lastCode: result.code, checkedAt: await databaseNow(db) },
        });
    }
}
