import { randomUUID } from 'node:crypto';
import nodemailer from 'nodemailer';
import { z } from 'zod';
import type { Config } from './config.js';
import type { Resources } from './resources.js';
import { digest, unseal } from '../api/src/auth/security.js';
const payloadSchema = z.object({ to: z.string().email(), token: z.string().regex(/^[A-Za-z0-9_-]{43}$/), purpose: z.enum(['verify_email', 'password_reset']) }).strict();
export function createMailer(config: Config) {
  return nodemailer.createTransport({ host: config.SMTP_HOST, port: config.SMTP_PORT,
    secure: config.SMTP_SECURE === 'true', requireTLS: config.NODE_ENV === 'production' && config.SMTP_SECURE !== 'true',
    ...(config.SMTP_USER ? { auth: { user: config.SMTP_USER, pass: config.SMTP_PASSWORD } } : {}),
    connectionTimeout: 3000, greetingTimeout: 3000, socketTimeout: 5000,
  });
}
export async function deliverAuthMail(deps: Resources, config: Config, transport: ReturnType<typeof createMailer>) {
  const owner = randomUUID();
  await deps.db.authMail.updateMany({ where: { status: 'pending', expiresAt: { lte: new Date() } }, data: { status: 'expired', sealedPayload: null } });
  const jobs = await deps.db.$queryRaw<Array<{ id: string; sealed_payload: string; attempts: number }>>`
    WITH selected AS (
      SELECT id FROM auth_mail_outbox WHERE status = 'pending' AND expires_at > NOW()
        AND available_at <= NOW() AND attempts < 5 AND (locked_until IS NULL OR locked_until < NOW())
      ORDER BY created_at LIMIT 5 FOR UPDATE SKIP LOCKED
    ) UPDATE auth_mail_outbox m SET locked_until = NOW() + INTERVAL '60 seconds', lease_owner = ${owner}::uuid,
      attempts = attempts + 1 FROM selected WHERE m.id = selected.id RETURNING m.id, m.sealed_payload, m.attempts`;
  for (const job of jobs) {
    try {
      const data = payloadSchema.parse(unseal(config.AUTH_MAIL_KEY, job.sealed_payload));
      const token = await deps.db.authToken.findUnique({ where: { digest: digest(data.token) }, include: { user: true } });
      if (!token || token.usedAt || token.expiresAt <= new Date() || token.email !== data.to || token.user.email !== data.to || token.user.disabledAt) {
        await deps.db.authMail.updateMany({ where: { id: job.id, leaseOwner: owner, status: 'pending' }, data: { status: 'expired', sealedPayload: null, lockedUntil: null, leaseOwner: null } });
        continue;
      }
      const verify = data.purpose === 'verify_email';
      const result = await transport.sendMail({ from: config.SMTP_FROM, to: data.to,
        subject: verify ? 'Verify your StageLink email' : 'Reset your StageLink password',
        messageId: `<${job.id}@${config.SMTP_FROM.split('@')[1]}>`,
        text: [verify ? 'Verify your email address.' : 'A password reset was requested for your account.',
          `${config.WEB_ORIGIN}/#${verify ? 'verify' : 'reset'}=${data.token}`,
          `Your one-time code: ${data.token}`, 'If you did not request this, you can ignore this message.'].join('\n\n'),
      });
      if (!result.accepted?.length) throw new Error('SMTP_NOT_ACCEPTED');
      await deps.db.authMail.updateMany({ where: { id: job.id, leaseOwner: owner, status: 'pending' }, data: {
        status: 'delivered', deliveredAt: new Date(), sealedPayload: null, lastErrorCode: null, lockedUntil: null, leaseOwner: null,
      } });
    } catch {
      await deps.db.authMail.updateMany({ where: { id: job.id, leaseOwner: owner, status: 'pending' }, data: {
        status: job.attempts >= 5 ? 'failed' : 'pending', lastErrorCode: 'SMTP_DELIVERY_UNCONFIRMED',
        availableAt: new Date(Date.now() + Math.min(300000, 5000 * 2 ** job.attempts)), lockedUntil: null, leaseOwner: null,
      } });
    }
  }
}
