import { z } from 'zod';
import { seal, unseal } from '../api/src/auth/security.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import type { Config } from './config.js';

const context = 'stagelink-promotional-unsubscribe-v1';
const maxRevision = 2_147_483_647;
const consent = z.object({
  userId: z.uuid(),
  email: z.string().email().max(200),
  consentRevision: z.number().int().min(1).max(maxRevision),
}).strict();

export const promotionalUnsubscribePath = '/api/v1/marketing/unsubscribe';

export function promotionalUnsubscribeHeaders(config: Config, recipient: z.infer<typeof consent>) {
  if (!config.PROMOTIONAL_UNSUBSCRIBE_ORIGIN) return {};
  const url = new URL(promotionalUnsubscribePath, config.PROMOTIONAL_UNSUBSCRIBE_ORIGIN);
  url.searchParams.set('token', seal(config.AUTH_MAIL_KEY, recipient, context));
  return {
    'List-Unsubscribe': '<' + url.href + '>',
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
}

export function readPromotionalUnsubscribeToken(key: string, token: unknown) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{1,600}$/.test(token)) return null;
  try {
    const result = consent.safeParse(unseal(key, token, context));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

export async function revokePromotionalConsent(db: PrismaClient, recipient: z.infer<typeof consent>) {
  const { userId, email, consentRevision } = recipient;
  await db.$transaction(async tx => {
    // Share the user lock with account preference changes and campaign claims.
    await tx.$queryRaw`SELECT id FROM auth_users WHERE id=${userId}::uuid FOR NO KEY UPDATE`;
    await tx.marketingEmailPreference.updateMany({
      where: { userId, consentEmail: email, revision: consentRevision },
      data: { consentEmail: null, revision: Math.min(consentRevision + 1, maxRevision), updatedAt: new Date() },
    });
  });
}
