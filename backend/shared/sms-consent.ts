import type { Prisma, SmsContact } from '../generated/prisma/client.js';
import { unseal } from '../api/src/auth/security.js';
import type { Config } from './config.js';
import { smsDigest } from './sms.js';
import { contactContext, verifiedNumber } from './sms-verification.js';
type Choices = {
    bookingConsent: boolean;
    marketingConsent: boolean;
};
// The caller holds the account lock used by verification, consent changes and send claims.
export async function auditSmsConsent(tx: Prisma.TransactionClient, config: Config, contact: SmsContact, choices: Choices, action: 'consent' | 'revoked') {
    let targetDigest: string | null = null;
    try {
        if (contact.sealedNumber)
            targetDigest = smsDigest(config, verifiedNumber.parse(unseal(config.AUTH_MAIL_KEY, contact.sealedNumber, contactContext(contact.userId))).number);
    }
    catch {
        // Corrupt encrypted contact data must never prevent an opt-out or revocation.
    }
    const revision = contact.revision + 1;
    const [clock] = await tx.$queryRaw<{
        now: Date;
    }[]> `SELECT clock_timestamp() AS now`;
    await tx.smsConsentEvent.create({ data: { userId: contact.userId, revision, action, last4: contact.last4, targetDigest, bookingConsent: choices.bookingConsent, marketingConsent: choices.marketingConsent, createdAt: clock!.now } });
    return { revision, now: clock!.now };
}
export async function invalidateQueuedSms(tx: Prisma.TransactionClient, userId: string, choices: Choices, revision: number) {
    if (!choices.bookingConsent) {
        await tx.bookingSmsReminder.updateMany({ where: { recipientId: userId, status: 'queued' }, data: { status: 'cancelled', lastCode: 'RECIPIENT_OPTED_OUT' } });
    }
    // Campaign audiences pin the contact revision, including when only booking consent changes.
    await tx.smsCampaignRecipient.updateMany({
        where: { userId, status: 'queued', ...(choices.marketingConsent ? { contactRevision: { not: revision } } : {}) },
        data: { status: 'skipped', lastCode: choices.marketingConsent ? 'CONTACT_CONSENT_CHANGED' : 'RECIPIENT_OPTED_OUT' },
    });
}
