import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Identity } from '../auth/service.js';
import type { Resources } from '../../../shared/resources.js';
import { ensureRedis } from '../../../shared/resources.js';
import { realtimeSubscription } from '../../../shared/realtime-subscription.js';
import { log } from '../../../shared/log.js';

const change = z.object({ caseId: z.uuid(), staffOnly: z.boolean() }).strict();
const envelope = z.object({ publisher: z.uuid(), change }).strict();
export type SupportChange = z.infer<typeof change>;

export async function canReadSupport(db: Resources['db'], actor: Identity, caseId: string, staffOnly = false) {
  const staff = actor.session.activeRole === 'admin' && actor.user.roles.includes('admin') && Boolean(actor.user.emailVerifiedAt);
  if (staffOnly && !staff) return false;
  const row = await db.supportCase.findUnique({ where: { id: caseId }, select: { ownerId: true } });
  return Boolean(row && (staff || (!staffOnly && row.ownerId === actor.user.id)));
}

export function supportSignals(redis: Resources['redis'], namespace: string, deliver: (value: SupportChange) => void) {
  const publisher = randomUUID();
  const channel = 'stagelink:support:v1:' + namespace + ':' + (redis.options.db ?? 0);
  const subscription = realtimeSubscription(redis, channel, body => {
    if (body.length > 256) return;
    try {
      const parsed = envelope.safeParse(JSON.parse(body));
      if (parsed.success && parsed.data.publisher !== publisher) deliver(parsed.data.change);
    } catch { log('support.signal_invalid', { code: 'INVALID_PAYLOAD' }); }
  });
  return {
    ...subscription,
    async publish(value: SupportChange) {
      try {
        await ensureRedis(redis);
        await redis.publish(channel, JSON.stringify({ publisher, change: value }));
      } catch { log('support.signal_failed', { code: 'REDIS_UNAVAILABLE' }); }
    },
  };
}
