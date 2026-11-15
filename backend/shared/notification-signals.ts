import type { Redis } from 'ioredis';
import { z } from 'zod';
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
  let subscriber: Redis | undefined;
  let subscription: Promise<void> | undefined;
  let closed = false;

  return {
    start() {
      if (closed) throw new Error('NOTIFICATION_SUBSCRIBER_CLOSED');
      if (!subscriber) {
        subscriber = redis.duplicate({
          lazyConnect: true, enableOfflineQueue: true, autoResubscribe: true,
          connectTimeout: 1500, commandTimeout: 2500, maxRetriesPerRequest: 0,
          retryStrategy: attempts => Math.min(attempts * 200, 5000),
        });
        subscriber.on('error', () => {});
        subscriber.on('close', () => { subscription = undefined; });
        subscriber.on('message', (name, body) => {
          if (name !== channel(redis) || body.length > 128) return;
          try {
            const result = recipients.safeParse(JSON.parse(body));
            if (result.success) deliver(result.data);
          } catch {
            log('notification.signal_invalid', { code: 'INVALID_PAYLOAD' });
          }
        });
      }
      subscription ??= subscriber.subscribe(channel(redis)).then(() => undefined).catch(error => {
        subscription = undefined;
        throw error;
      });
      return subscription;
    },
    close() {
      closed = true;
      subscriber?.disconnect();
    },
  };
}
