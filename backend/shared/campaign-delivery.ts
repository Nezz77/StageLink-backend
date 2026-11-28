import type { PrismaClient } from '../generated/prisma/client.js';
import type { createMailer } from './auth-mail.js';
import { smtpFailureState } from './booking-reminders.js';
import { databaseNow } from './database-clock.js';
import { promotionalUnsubscribeHeaders } from './promotional-unsubscribe.js';
import type { Config } from './config.js';

type Mailer = Pick<ReturnType<typeof createMailer>, 'sendMail'>;
type RecipientKey = { campaignId: string; userId: string };

export async function processPromotionalEmail(db: PrismaClient, config: Config, mailer: Mailer) {
  await db.$executeRaw`
    UPDATE promotional_campaign_recipients
    SET delivery_status='unknown', resolved_at=clock_timestamp(), delivery_code='SEND_INTERRUPTED'
    WHERE delivery_status='sending' AND claimed_at < clock_timestamp() - interval '5 minutes'`;
  if (config.PROMOTIONAL_EMAIL_DELIVERY !== 'true') return;

  const message = await db.$transaction(async tx => {
    // Serialize claims across worker replicas so the rolling cap includes in-flight sends.
    const [lock] = await tx.$queryRaw<{ acquired: boolean }[]>`
      SELECT pg_try_advisory_xact_lock(71831, 1) AS acquired`;
    if (!lock?.acquired) return null;

    const [candidate] = await tx.$queryRaw<RecipientKey[]>`
      SELECT r.campaign_id AS "campaignId", r.user_id AS "userId"
      FROM promotional_campaign_recipients r
      JOIN promotional_campaigns c ON c.id=r.campaign_id
      WHERE r.delivery_status='queued' AND c.state='scheduled' AND c.scheduled_for<=now()
      ORDER BY c.scheduled_for, r.campaign_id, r.user_id LIMIT 1`;
    if (!candidate) return null;

    // Consent changes use the user lock, and cancellation uses the campaign lock.
    await tx.$queryRaw`SELECT id FROM auth_users WHERE id=${candidate.userId}::uuid FOR NO KEY UPDATE`;
    await tx.$queryRaw`SELECT id FROM promotional_campaigns WHERE id=${candidate.campaignId}::uuid FOR UPDATE`;
    const [current] = await tx.$queryRaw<{ email: string; consentRevision: number; subject: string; body: string; eligible: boolean }[]>`
      SELECT u.email, r.consent_revision AS "consentRevision", c.subject, c.body,
        COALESCE(p.revision=r.consent_revision AND p.consent_email=u.email
          AND u.email_verified_at IS NOT NULL AND u.disabled_at IS NULL
          AND u.roles && ARRAY['customer','artist','renter']::"AuthRole"[], false) AS eligible
      FROM promotional_campaign_recipients r
      JOIN promotional_campaigns c ON c.id=r.campaign_id
      JOIN auth_users u ON u.id=r.user_id
      LEFT JOIN marketing_email_preferences p ON p.user_id=u.id
      WHERE r.campaign_id=${candidate.campaignId}::uuid AND r.user_id=${candidate.userId}::uuid
        AND r.delivery_status='queued' AND c.state='scheduled' AND c.scheduled_for<=now()`;
    if (!current) return null;

    const where = { campaignId_userId: candidate };
    if (!current.eligible) {
      await tx.promotionalCampaignRecipient.update({
        where, data: { deliveryStatus: 'skipped', resolvedAt: await databaseNow(tx), deliveryCode: 'RECIPIENT_INELIGIBLE' },
      });
      return null;
    }
    const [usage] = await tx.$queryRaw<{ capped: boolean }[]>`
      SELECT count(*) >= ${config.PROMOTIONAL_EMAIL_HOURLY_LIMIT} AS capped
      FROM promotional_campaign_recipients WHERE claimed_at > clock_timestamp() - interval '1 hour'`;
    if (usage?.capped) return null;
    await tx.$executeRaw`
      UPDATE promotional_campaign_recipients SET delivery_status='sending', claimed_at=clock_timestamp()
      WHERE campaign_id=${candidate.campaignId}::uuid AND user_id=${candidate.userId}::uuid`;
    return { ...candidate, ...current };
  });
  if (!message) return;

  let deliveryStatus: 'accepted' | 'failed' | 'unknown';
  let deliveryCode: string | null;
  try {
    const result = await mailer.sendMail({
      from: config.SMTP_FROM,
      to: message.email,
      subject: message.subject,
      headers: promotionalUnsubscribeHeaders(config, {
        userId: message.userId, email: message.email, consentRevision: message.consentRevision,
      }),
      messageId: `<campaign-${message.campaignId}-${message.userId}@${config.SMTP_FROM.split('@')[1]}>`,
      text: [message.body, 'Manage promotional email preferences in your StageLink account: ' + config.WEB_ORIGIN].join('\n\n'),
    });
    deliveryStatus = result.accepted?.length ? 'accepted' : 'failed';
    deliveryCode = deliveryStatus === 'accepted' ? null : 'SMTP_REJECTED';
  } catch (error) {
    deliveryStatus = smtpFailureState(error);
    deliveryCode = deliveryStatus === 'failed' ? 'SMTP_REJECTED' : 'SMTP_OUTCOME_UNKNOWN';
  }
  await db.promotionalCampaignRecipient.updateMany({
    where: { campaignId: message.campaignId, userId: message.userId, deliveryStatus: 'sending' },
    data: { deliveryStatus, deliveryCode, resolvedAt: await databaseNow(db) },
  });
}
