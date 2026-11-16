import type { Redis } from 'ioredis';

export function realtimeSubscription(redis: Redis, channel: string, onMessage: (body: string) => void) {
  let subscriber: Redis | undefined;
  let subscription: Promise<void> | undefined;
  let closed = false;

  function subscribe(client: Redis) {
    if (!subscription) {
      const pending = client.subscribe(channel).then(() => undefined);
      subscription = pending;
      void pending.catch(() => {
        if (subscription === pending) subscription = undefined;
      });
    }
    return subscription;
  }

  return {
    start() {
      if (closed) throw new Error('Realtime subscriber is closed.');
      if (!subscriber) {
        const client = redis.duplicate({
          lazyConnect: true, enableOfflineQueue: true, autoResubscribe: true,
          connectTimeout: 1500, commandTimeout: 2500, maxRetriesPerRequest: 0,
          retryStrategy: attempts => Math.min(attempts * 200, 5000),
        });
        subscriber = client;
        client.on('error', () => {});
        client.on('close', () => { subscription = undefined; });
        client.on('ready', () => {
          if (!closed) void subscribe(client).catch(() => {});
        });
        client.on('message', (name, body) => {
          if (!closed && name === channel) onMessage(body);
        });
      }
      return subscribe(subscriber);
    },
    close() {
      closed = true;
      subscriber?.disconnect();
    },
  };
}
