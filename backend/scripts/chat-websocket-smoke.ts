import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { io, type Socket } from 'socket.io-client';
import { z } from 'zod';

const timeout = 8_000;
const httpsOrigin = z.url({ protocol: /^https$/ }).refine(raw => {
  const { origin } = new URL(raw);
  return raw === origin || raw === origin + '/';
}).transform(raw => new URL(raw).origin);
const uuid = z.uuid().transform(id => id.toLowerCase());
const token = z.string().max(2048).regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
const participants = z.object({ sender: token, receiver: token }).strict()
  .refine(({ sender, receiver }) => sender !== receiver);
const settings = z.object({ origin: httpsOrigin, webOrigin: httpsOrigin, bookingId: uuid, sessions: participants });
const messageId = z.string().regex(/^[1-9][0-9]{0,18}$/);
const message = z.object({ id: messageId, authorId: uuid, body: z.string().max(4000) });
const history = z.object({ items: z.array(message).max(40) });
const changed = z.object({ bookingId: uuid, kind: z.literal('message'), messageId });
const sent = z.object({ ok: z.literal(true), data: message });
const joined = z.object({ ok: z.literal(true), data: z.object({ bookingId: uuid }) });
type Config = z.output<typeof settings>;
type Check = { check: string; passed: boolean };

function requireResult(condition: unknown): asserts condition {
  if (!condition) throw new Error('The chat response did not match the fixture.');
}

function open(socket: Socket) {
  return new Promise<string>((resolve, reject) => {
    function clear() {
      clearTimeout(timer);
      socket.off('connect', connected);
      socket.off('connect_error', failed);
    }
    function connected() {
      const id = socket.id;
      if (!id || socket.io.engine.transport.name !== 'websocket') return failed();
      clear();
      resolve(id);
    }
    function failed() {
      clear();
      reject(new Error('The WebSocket connection did not open.'));
    }
    const timer = setTimeout(failed, timeout);
    socket.once('connect', connected);
    socket.once('connect_error', failed);
    socket.connect();
  });
}

export async function runChatWebSocketSmoke(config: Config) {
  const room = { bookingId: config.bookingId };
  const checks: Check[] = [];
  const client = (accessToken: string) => io(config.origin, {
    path: '/api/v1/chat/socket.io', transports: ['websocket'], autoConnect: false,
    reconnection: false, forceNew: true, timeout, extraHeaders: { Origin: config.webOrigin },
    auth: { accessToken },
  });
  const sender = client(config.sessions.sender);
  const receiver = client(config.sessions.receiver);

  async function check<T>(name: string, action: () => Promise<T>) {
    try {
      const result = await action();
      checks.push({ check: name, passed: true });
      return result;
    } catch (error) {
      checks.push({ check: name, passed: false });
      throw error;
    }
  }

  async function join(socket: Socket) {
    const reply = joined.parse(await socket.timeout(timeout).emitWithAck('chat:join', room));
    requireResult(reply.data.bookingId === room.bookingId);
  }

  async function send(socket: Socket, body: string) {
    const reply = sent.parse(await socket.timeout(timeout).emitWithAck('chat:send', {
      ...room, data: { requestKey: randomUUID(), body },
    }));
    requireResult(reply.data.body === body);
    return reply.data;
  }

  async function observeMessage(listener: Socket, publisher: Socket, body: string) {
    let notify: (id: string | null) => void = () => {};
    const changedId = new Promise<string | null>(resolve => { notify = resolve; });
    function receive(raw: unknown) {
      const notice = changed.safeParse(raw);
      if (notice.success && notice.data.bookingId === room.bookingId) notify(notice.data.messageId);
    }
    const timer = setTimeout(() => notify(null), timeout);
    listener.on('chat:changed', receive);
    try {
      const [notified, saved] = await Promise.all([changedId, send(publisher, body)]);
      requireResult(notified === saved.id);
      return saved;
    } finally {
      clearTimeout(timer);
      listener.off('chat:changed', receive);
    }
  }

  try {
    const [, firstConnection] = await check('websocket_connections', () => Promise.all([open(sender), open(receiver)]));
    await check('join_booking', () => Promise.all([join(sender), join(receiver)]));
    const anchor = await check('initial_message_signal', () => observeMessage(sender, receiver, 'Chat smoke fixture: before disconnect.'));
    const missed = await check('publish_during_disconnect', async () => {
      receiver.disconnect();
      requireResult(!receiver.connected);
      const saved = await send(sender, 'Chat smoke fixture: during disconnect.');
      requireResult(saved.authorId !== anchor.authorId && BigInt(saved.id) > BigInt(anchor.id));
      return saved;
    });
    await check('reconnect_and_rejoin', async () => {
      requireResult(await open(receiver) !== firstConnection);
      await join(receiver);
    });
    await check('recover_missed_message', async () => {
      const url = new URL(`/api/v1/conversations/${room.bookingId}/messages`, config.origin);
      url.searchParams.set('after', anchor.id);
      const response = await fetch(url, {
        headers: { Authorization: 'Bearer ' + config.sessions.receiver },
        redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(timeout),
      });
      if (response.status !== 200) {
        await response.body?.cancel();
        throw new Error('Chat history was unavailable.');
      }
      const recovered = history.parse(await response.json()).items;
      requireResult(recovered.some(row => row.id === missed.id && row.authorId === missed.authorId && row.body === missed.body));
    });
    await check('resumed_message_signal', () => observeMessage(receiver, sender, 'Chat smoke fixture: after reconnect.'));
    return { passed: true, checks };
  } catch {
    return { passed: false, checks };
  } finally {
    sender.close();
    receiver.close();
  }
}

if (import.meta.main) {
  async function main() {
    const sessions: unknown = process.stdin.isTTY ? null : JSON.parse(readFileSync(0, 'utf8'));
    const config = settings.parse({
      origin: process.env.STAGELINK_SMOKE_ORIGIN, webOrigin: process.env.STAGELINK_SMOKE_WEB_ORIGIN,
      bookingId: process.env.STAGELINK_SMOKE_BOOKING_ID, sessions,
    });
    const report = await runChatWebSocketSmoke(config);
    console.log(JSON.stringify(report, null, 2));
    if (!report.passed) process.exitCode = 1;
  }
  main().catch(() => {
    console.error('Set the staging API and web HTTPS origins and fixture booking ID, then pipe two distinct participant access tokens through protected stdin.');
    process.exitCode = 1;
  });
}
