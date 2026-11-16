import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { log } from '../../../shared/log.js';
import { realtimeSubscription } from '../../../shared/realtime-subscription.js';
import { ensureRedis, type Resources } from '../../../shared/resources.js';

const bookingId = z.uuid();
const sequence = z.string().regex(/^[1-9][0-9]{0,18}$/);
const payload = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('message'), bookingId, messageId: sequence }).strict(),
  z.object({ kind: z.literal('read'), bookingId, readerId: z.uuid(), throughId: sequence }).strict(),
  z.object({ kind: z.literal('typing'), bookingId, userId: z.uuid(), typing: z.boolean() }).strict(),
]);
const envelope = z.object({ publisher: z.uuid(), payload }).strict();

export type BookingSignal = z.infer<typeof payload>;

export function bookingChatSignals(redis: Resources['redis'], namespace: string, deliver: (value: BookingSignal) => void) {
  const publisher = randomUUID();
  const channel = 'stagelink:booking-chat:v1:' + namespace + ':' + (redis.options.db ?? 0);
  const subscription = realtimeSubscription(redis, channel, body => {
    if (body.length > 512) return;
    try {
      const parsed = envelope.safeParse(JSON.parse(body));
      if (parsed.success && parsed.data.publisher !== publisher) deliver(parsed.data.payload);
    } catch {
      log('chat.signal_invalid', { code: 'INVALID_PAYLOAD' });
    }
  });

  return {
    ...subscription,
    async publish(value: BookingSignal) {
      try {
        await ensureRedis(redis);
        await redis.publish(channel, JSON.stringify({ publisher, payload: value }));
      } catch {
        log('chat.signal_failed', { code: 'REDIS_UNAVAILABLE' });
      }
    },
  };
}
