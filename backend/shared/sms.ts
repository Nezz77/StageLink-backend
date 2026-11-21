import { createHmac } from 'node:crypto';
import { z } from 'zod';
import type { Prisma } from '../generated/prisma/client.js';
import type { Config } from './config.js';
export const sriLankaMobile = z.string().trim().transform(value => value.replace(/[ -]/g, '').replace(/^\+/, '').replace(/^0/, '94')).pipe(z.string().regex(/^947\d{8}$/));
export const smsDigest = (config: Config, value: string) => createHmac('sha256', Buffer.from(config.AUTH_JWT_SECRET, 'hex')).update('stagelink-sms-v1:' + value).digest('hex');
export const smsPayload = z.object({ number: z.string().regex(/^947\d{8}$/), message: z.string().min(1).max(160) }).strict();
export const smsDeliveryStatus = z.enum(['queued', 'sending', 'accepted', 'delivered', 'failed', 'unknown', 'cancelled']);

export async function reserveSmsSubmission(tx: Prisma.TransactionClient, config: Config) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(176012, 17)`;
    const [budget] = await tx.$queryRaw<Array<{ count: bigint; now: Date }>>`
      WITH submission_clock AS (SELECT clock_timestamp() AS checked_at)
      SELECT checked_at AS now,
        (SELECT count(*) FROM sms_verifications WHERE sending_at > submission_clock.checked_at - interval '1 hour') +
        (SELECT count(*) FROM booking_sms_reminders WHERE sending_at > submission_clock.checked_at - interval '1 hour') +
        (SELECT count(*) FROM sms_campaign_recipients WHERE sending_at > submission_clock.checked_at - interval '1 hour') AS count
      FROM submission_clock`;
    return budget && budget.count < BigInt(config.SMS_HOURLY_LIMIT) ? budget.now : null;
}

const smsEnabled = (config: Config) => config.SMS_VERIFICATION_ENABLED === 'true' || config.BOOKING_SMS_REMINDERS === 'true' || config.PROMOTIONAL_SMS_DELIVERY === 'true';
const receipt = z.object({ status: z.literal('success'), data: z.object({ uid: z.string().regex(/^[A-Za-z0-9_-]{1,120}$/), to: z.string(), from: z.string(), status: z.string() }) });
export type SmsResult = {
    status: 'accepted' | 'delivered' | 'failed' | 'unknown';
    providerId: string | null;
    code: string | null;
};
export function checkedSmsReceipt(raw: unknown, config: Config, targetDigest: string, expectedId?: string): SmsResult {
    const result = receipt.safeParse(raw);
    if (!result.success)
        return { status: 'unknown', providerId: expectedId ?? null, code: 'INVALID_PROVIDER_RESPONSE' };
    const data = result.data.data;
    if (smsDigest(config, data.to) !== targetDigest || data.from !== config.TEXTLK_SENDER || expectedId && data.uid !== expectedId)
        return { status: 'unknown', providerId: expectedId ?? null, code: 'PROVIDER_EVIDENCE_MISMATCH' };
    const normalized = data.status.toLowerCase();
    return { providerId: data.uid, status: normalized === 'delivered' ? 'delivered' : ['failed', 'undelivered', 'rejected'].includes(normalized) ? 'failed' : ['accepted', 'queued', 'sent', 'pending', 'sending'].includes(normalized) ? 'accepted' : 'unknown', code: null };
}
export class TextLk {
    constructor(readonly config: Config) { }
    async send(payload: z.infer<typeof smsPayload>, targetDigest: string): Promise<SmsResult> {
        if (!smsEnabled(this.config) || !this.config.TEXTLK_TOKEN || !this.config.TEXTLK_SENDER)
            return { status: 'failed', providerId: null, code: 'SMS_DISABLED' };
        try {
            const response = await fetch('https://app.text.lk/api/v3/sms/send', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000), headers: { Authorization: 'Bearer ' + this.config.TEXTLK_TOKEN, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ recipient: payload.number, sender_id: this.config.TEXTLK_SENDER, type: 'plain', message: payload.message }) });
            const text = await response.text();
            if (text.length > 16384)
                throw Error();
            const raw: unknown = JSON.parse(text);
            if (response.status >= 400 && response.status < 500 && z.object({ status: z.literal('error') }).safeParse(raw).success)
                return { status: 'failed', providerId: null, code: 'PROVIDER_REJECTED' };
            if (!response.ok)
                return { status: 'unknown', providerId: null, code: 'PROVIDER_OUTCOME_UNKNOWN' };
            return checkedSmsReceipt(raw, this.config, targetDigest);
        }
        catch {
            return { status: 'unknown', providerId: null, code: 'PROVIDER_OUTCOME_UNKNOWN' };
        }
    }
    async read(providerId: string, targetDigest: string): Promise<SmsResult> {
        if (!smsEnabled(this.config) || !this.config.TEXTLK_TOKEN)
            return { status: 'unknown', providerId, code: 'SMS_DISABLED' };
        try {
            if (!/^[A-Za-z0-9_-]{1,120}$/.test(providerId))
                throw Error();
            const response = await fetch('https://app.text.lk/api/v3/sms/' + encodeURIComponent(providerId), { redirect: 'error', signal: AbortSignal.timeout(8000), headers: { Authorization: 'Bearer ' + this.config.TEXTLK_TOKEN, Accept: 'application/json' } });
            const text = await response.text();
            if (!response.ok || text.length > 16384)
                throw Error();
            return checkedSmsReceipt(JSON.parse(text), this.config, targetDigest, providerId);
        }
        catch {
            return { status: 'unknown', providerId, code: 'RECONCILIATION_UNAVAILABLE' };
        }
    }
}
