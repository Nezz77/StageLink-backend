import type { Redis } from 'ioredis';
import { z } from 'zod';
import { realtimeSubscription } from './realtime-subscription.js';
import { log } from './log.js';
import { ensureRedis } from './resources.js';

const recipients = z.array(z.uuid()).min(1).max(2);
const channel = (redis: Redis) => 'stagelink:notifications:v1:' + (redis.options.db ?? 0);

export async function publishNotificationChange(redis: Redis, userIds: string[]) {
  if (!userIds.length) return;
  try {
    await ensureRedis(redis);
    await redis.publish(channel(redis), JSON.stringify(userIds));
  } catch {
    log('notification.signal_failed', { code: 'REDIS_UNAVAILABLE' });
  }
}

export function subscribeToNotificationChanges(redis: Redis, deliver: (userIds: string[]) => void) {
  return realtimeSubscription(redis, channel(redis), body => {
    if (body.length > 128) return;
    try {
      const result = recipients.safeParse(JSON.parse(body));
      if (result.success) deliver(result.data);
    } catch {
      log('notification.signal_invalid', { code: 'INVALID_PAYLOAD' });
    }
  });
}
