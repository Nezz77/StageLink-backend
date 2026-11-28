import { randomUUID } from 'node:crypto';
import nodemailer from 'nodemailer';
import { z } from 'zod';
import type { Config } from './config.js';
import type { Resources } from './resources.js';
import { digest, unseal } from '../api/src/auth/security.js';
import { databaseNow } from './database-clock.js';
const payloadSchema = z.object({ to: z.string().email(), token: z.string().regex(/^[A-Za-z0-9_-]{43}$/), purpose: z.enum(['verify_email', 'password_reset', 'email_change']) }).strict();
const maxAttempts = 5;
export function createMailer(config: Config) {
  return nodemailer.createTransport({ host: config.SMTP_HOST, port: config.SMTP_PORT,
    secure: config.SMTP_SECURE === 'true', requireTLS: config.NODE_ENV === 'production' && config.SMTP_SECURE !== 'true',
    ...(config.SMTP_USER ? { auth: { user: config.SMTP_USER, pass: config.SMTP_PASSWORD } } : {}),
    connectionTimeout: 3000, greetingTimeout: 3000, socketTimeout: 5000,
  });
}
export async function deliverAuthMail(deps: Resources, config: Config, transport: Pick<ReturnType<typeof createMailer>, 'sendMail'>) {
  const owner = randomUUID();
  await deps.db.$executeRaw`
    WITH sweep AS (SELECT clock_timestamp() AS checked_at)
    UPDATE auth_mail_outbox m
    SET status = CASE WHEN m.expires_at <= sweep.checked_at THEN 'expired' ELSE 'failed' END,
        sealed_payload = NULL, locked_until = NULL, lease_owner = NULL
    FROM sweep WHERE m.status = 'pending'
      AND (m.expires_at <= sweep.checked_at OR m.attempts >= ${maxAttempts})
      AND (m.locked_until IS NULL OR m.locked_until <= sweep.checked_at)`;
  const jobs = await deps.db.$queryRaw<Array<{ id: string; sealed_payload: string; attempts: number }>>`
    WITH selected AS (
      SELECT id FROM auth_mail_outbox WHERE status = 'pending' AND expires_at > NOW()
        AND available_at <= NOW() AND attempts < ${maxAttempts} AND (locked_until IS NULL OR locked_until <= NOW())
      ORDER BY created_at LIMIT 5 FOR UPDATE SKIP LOCKED
    ) UPDATE auth_mail_outbox m SET locked_until = clock_timestamp() + INTERVAL '60 seconds', lease_owner = ${owner}::uuid,
      attempts = attempts + 1 FROM selected WHERE m.id = selected.id RETURNING m.id, m.sealed_payload, m.attempts`;
  for (const job of jobs) {
    try {
      const data = payloadSchema.parse(unseal(config.AUTH_MAIL_KEY, job.sealed_payload));
      const token = await deps.db.authToken.findUnique({ where: { digest: digest(data.token) }, include: { user: true } });
      const pending=data.purpose==='email_change'&&token?await deps.db.pendingEmailChange.findUnique({where:{userId:token.userId}}):null;
      const checkedAt = await databaseNow(deps.db);
      const recipientEligible=data.purpose==='email_change'?Boolean(pending&&pending.newEmail===data.to&&pending.fromEmail===token?.user.email&&pending.tokenDigest===token.digest&&pending.expiresAt>checkedAt):token?.user.email===data.to;
      if (!token || token.purpose!==data.purpose || token.usedAt || token.expiresAt <= checkedAt || token.email !== data.to || !recipientEligible || token.user.disabledAt) {
        await deps.db.authMail.updateMany({ where: { id: job.id, leaseOwner: owner, status: 'pending' }, data: { status: 'expired', sealedPayload: null, lockedUntil: null, leaseOwner: null } });
        continue;
      }
      const verify = data.purpose === 'verify_email';
      const result = await transport.sendMail({ from: config.SMTP_FROM, to: data.to,
        subject: verify ? 'Verify your StageLink email' : data.purpose==='email_change'?'Confirm your StageLink email change':'Reset your StageLink password',
        messageId: `<${job.id}@${config.SMTP_FROM.split('@')[1]}>`,
        text: [verify ? 'Verify your email address.' : data.purpose==='email_change'?'Confirm your new account email. Your previous email remains active until you confirm.':'A password reset was requested for your account.',
          `${config.WEB_ORIGIN}/#${verify ? 'verify' : data.purpose==='email_change'?'emailchange':'reset'}=${data.token}`,
          `Your one-time code: ${data.token}`, 'If you did not request this, you can ignore this message.'].join('\n\n'),
      });
      if (!result.accepted?.length) throw new Error('SMTP_NOT_ACCEPTED');
      await deps.db.authMail.updateMany({ where: { id: job.id, leaseOwner: owner, status: 'pending' }, data: {
        status: 'delivered', deliveredAt: await databaseNow(deps.db), sealedPayload: null, lastErrorCode: null, lockedUntil: null, leaseOwner: null,
      } });
    } catch {
      const exhausted = job.attempts >= maxAttempts;
      const now = await databaseNow(deps.db);
      await deps.db.authMail.updateMany({ where: { id: job.id, leaseOwner: owner, status: 'pending' }, data: {
        status: exhausted ? 'failed' : 'pending',
        lastErrorCode: 'SMTP_DELIVERY_UNCONFIRMED',
        ...(exhausted ? { sealedPayload: null } : { availableAt: new Date(now.getTime() + 5000 * 2 ** job.attempts) }),
        lockedUntil: null,
        leaseOwner: null,
      } });
    }
  }
}
