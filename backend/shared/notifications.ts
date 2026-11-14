import { z } from 'zod';
import type { NotificationKind, Prisma } from '../generated/prisma/client.js';

export const NOTIFICATION_TOPIC = 'notification.create.v1';
export const notificationKind = z.enum(['provider_decision', 'agreement', 'payment', 'completion', 'arbitration', 'support']);
export const notificationPayload = z.object({
  recipients: z.array(z.uuid()).min(1).max(2), kind: notificationKind,
  sourceId: z.uuid(), eventKey: z.string().min(1).max(80),
}).strict();

export async function notifyUsers(
  tx: Prisma.TransactionClient, recipients: string[], kind: NotificationKind, sourceId: string, eventKey: string,
) {
  const unique = [...new Set(recipients)].sort();
  if (!unique.length) return;
  await tx.outboxEvent.create({
    data: { topic: NOTIFICATION_TOPIC, payload: notificationPayload.parse({ recipients: unique, kind, sourceId, eventKey }) },
  });
}
