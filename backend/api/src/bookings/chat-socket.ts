import { canReadSupport, supportSignals, type SupportChange } from '../support/realtime.js';
import type { Server as HttpServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import { z } from 'zod';
import { log } from '../../../shared/log.js';
import { subscribeToNotificationChanges } from '../../../shared/notification-signals.js';
import { PublicError } from '../auth/errors.js';
import type { AuthService, Identity } from '../auth/service.js';
import { checkMaintenance } from '../operations/maintenance.js';
import { bookingChatSignals, type BookingSignal } from './chat-signals.js';
import type { BookingChat, BookingChatChange } from './messages.js';

const maxRooms = 16;
const interval = 15_000;
const bookingId = z.uuid().transform(id => id.toLowerCase());
const roomInput = z.object({ bookingId }).strict();
const writeInput = roomInput.extend({ data: z.unknown() });
const supportRoomInput = z.object({ caseId: z.uuid().transform(id => id.toLowerCase()) }).strict();
const empty = z.object({}).strict();
const typingInput = roomInput.extend({ typing: z.boolean() });

type Failure = { ok: false; error: { code: string; message: string } };
type Ack = (result: { ok: true; data: unknown } | Failure) => void;
type ChatAction = (identity: Identity, input: unknown) => unknown;

function failure(error: unknown): Failure {
  if (error instanceof PublicError) return { ok: false, error: { code: error.code, message: error.publicMessage } };
  log('chat.operation_failed', { code: 'CHAT_UNAVAILABLE' });
  return { ok: false, error: { code: 'CHAT_UNAVAILABLE', message: 'Booking chat is temporarily unavailable.' } };
}

function parse<T>(schema: z.ZodType<T>, input: unknown) {
  const value = schema.safeParse(input);
  if (!value.success) throw new PublicError(400, 'INVALID_CHAT_EVENT', 'Check the booking conversation and event fields.');
  return value.data;
}

export function attachBookingChat(server: HttpServer, auth: AuthService, chat: BookingChat) {
  const io = new Server(server, {
    path: '/api/v1/chat/socket.io',
    transports: ['websocket'],
    serveClient: false,
    maxHttpBufferSize: 32_768,
    connectTimeout: 5_000,
    allowRequest: (req, done) => done(null, req.headers.origin === auth.config.WEB_ORIGIN),
  });
  const room = (id: string) => 'booking:' + id;
  const inboxRoom = (id: string) => 'notifications:' + id;
  const supportRoom = (id: string) => 'support:' + id;
  const credentials = new WeakMap<Socket, string>();

  async function authenticate(socket: Socket) {
    try {
      return await auth.authenticate(credentials.get(socket));
    } catch (error) {
      if (error instanceof PublicError && error.getStatus() === 401 && socket.connected) socket.disconnect(true);
      throw error;
    }
  }

  io.use(async (socket, next) => {
    const accessToken = socket.handshake.auth?.accessToken;
    if (typeof accessToken === 'string' && accessToken.length <= 2048) {
      credentials.set(socket, 'Bearer ' + accessToken);
      try { await authenticate(socket); next(); return; }
      catch (error) {
        const connectionError = new Error('Booking chat connection rejected.');
        next(Object.assign(connectionError, { data: failure(error).error }));
        return;
      }
    }
    next(Object.assign(new Error('Sign in to use booking chat.'), { data: { code: 'UNAUTHORIZED' } }));
  });

  async function deliver(roomName: string, send: (socket: Socket, identity: Identity) => unknown, skip?: Socket) {
    const sockets = io.sockets.adapter.rooms.get(roomName);
    if (!sockets) return;
    await Promise.all([...sockets].map(async id => {
      const socket = io.sockets.sockets.get(id);
      if (!socket || socket === skip) return;
      try {
        const identity = await authenticate(socket);
        if (socket.connected && socket.rooms.has(roomName)) await send(socket, identity);
      } catch (error) {
        if (!(error instanceof PublicError)) log('chat.delivery_failed', { code: 'CHAT_UNAVAILABLE' });
      }
    }));
  }

  function deliverBooking(signal: BookingSignal, skip?: Socket) {
    if (signal.kind === 'typing') {
      const { kind: _kind, ...value } = signal;
      void deliver(room(signal.bookingId), socket => socket.volatile.emit('chat:typing', value), skip);
    } else {
      void deliver(room(signal.bookingId), socket => socket.emit('chat:changed', signal));
    }
  }

  function deliverSupport(change: SupportChange) {
    void deliver(supportRoom(change.caseId), async (socket, actor) => {
      if (await canReadSupport(auth.deps.db, actor, change.caseId, change.staffOnly)) {
        if (socket.connected && socket.rooms.has(supportRoom(change.caseId))) socket.emit('support:changed', { caseId: change.caseId });
      } else if (!await canReadSupport(auth.deps.db, actor, change.caseId)) {
        await socket.leave(supportRoom(change.caseId));
      }
    });
  }
  const support = supportSignals(auth.deps.redis, auth.config.AUTH_RATE_PREFIX, deliverSupport);
  const bookingSignals = bookingChatSignals(auth.deps.redis, auth.config.AUTH_RATE_PREFIX, deliverBooking);
  const inbox = subscribeToNotificationChanges(auth.deps.redis, userIds => {
    for (const userId of userIds) {
      void deliver(inboxRoom(userId), (socket, identity) => {
        if (identity.user.id === userId) socket.emit('notifications:changed', {});
      });
    }
  });

  io.on('connection', socket => {
    let windowStart = performance.now();
    let events = 0;
    let lastTyping = -Infinity;

    function handle(event: string, action: ChatAction) {
      socket.on(event, async (raw: unknown, ack: unknown) => {
        if (typeof ack !== 'function') return;
        const reply = ack as Ack;
        const now = performance.now();
        if (now - windowStart >= 10_000) { windowStart = now; events = 0; }
        if (++events > 40) {
          reply(failure(new PublicError(429, 'CHAT_RATE_LIMITED', 'Wait a moment before sending more chat events.')));
          return;
        }
        try { reply({ ok: true, data: await action(await authenticate(socket), raw) }); }
        catch (error) { if (socket.connected) reply(failure(error)); }
      });
    }

    function requireJoined(id: string) {
      if (!socket.rooms.has(room(id))) throw new PublicError(403, 'CHAT_JOIN_REQUIRED', 'Join the booking conversation first.');
    }

    handle('chat:join', async (actor, raw) => {
      const id = await chat.join(actor, parse(roomInput, raw).bookingId);
      try { await bookingSignals.start(); }
      catch { log('chat.subscription_unavailable', { code: 'REDIS_UNAVAILABLE' }); }
      const inboxCount = Number(socket.rooms.has(inboxRoom(actor.user.id)));
      if (socket.rooms.size > maxRooms + inboxCount && !socket.rooms.has(room(id))) {
        throw new PublicError(429, 'CHAT_ROOM_LIMIT', 'Leave another conversation first.');
      }
      if (socket.connected) await socket.join(room(id));
      return { bookingId: id };
    });
    handle('chat:leave', async (_actor, raw) => {
      const { bookingId } = parse(roomInput, raw);
      await socket.leave(room(bookingId));
      return { bookingId };
    });
    handle('chat:send', async (actor, raw) => {
      const { bookingId, data } = parse(writeInput, raw);
      requireJoined(bookingId);
      await checkMaintenance(auth.deps.db);
      return chat.sendMessage(actor, bookingId, data);
    });
    handle('chat:read', async (actor, raw) => {
      const { bookingId, data } = parse(writeInput, raw);
      requireJoined(bookingId);
      await checkMaintenance(auth.deps.db);
      return chat.markRead(actor, bookingId, data);
    });
    handle('chat:typing', (actor, raw) => {
      const { bookingId, typing } = parse(typingInput, raw);
      requireJoined(bookingId);
      const now = performance.now();
      if (now - lastTyping >= 750) {
        lastTyping = now;
        const signal = { kind: 'typing' as const, bookingId, userId: actor.user.id, typing };
        deliverBooking(signal, socket);
        void bookingSignals.publish(signal);
      }
      return { bookingId };
    });
    handle('support:join', async (actor, raw) => {
      const { caseId } = parse(supportRoomInput, raw);
      if (!await canReadSupport(auth.deps.db, actor, caseId)) {
        throw new PublicError(404, 'SUPPORT_CASE_NOT_FOUND', 'This support case is unavailable.');
      }
      try { await support.start(); }
      catch { throw new PublicError(503, 'SUPPORT_UNAVAILABLE', 'Live support updates are temporarily unavailable.'); }
      const inboxCount = Number(socket.rooms.has(inboxRoom(actor.user.id)));
      if (socket.rooms.size > maxRooms + inboxCount && !socket.rooms.has(supportRoom(caseId))) {
        throw new PublicError(429, 'CHAT_ROOM_LIMIT', 'Leave another conversation first.');
      }
      if (socket.connected) await socket.join(supportRoom(caseId));
      return { caseId };
    });
    handle('support:leave', async (_actor, raw) => {
      const { caseId } = parse(supportRoomInput, raw);
      await socket.leave(supportRoom(caseId));
      return { caseId };
    });
    handle('notifications:subscribe', async (actor, raw) => {
      parse(empty, raw);
      try { await inbox.start(); }
      catch { throw new PublicError(503, 'NOTIFICATIONS_UNAVAILABLE', 'Live notifications are temporarily unavailable.'); }
      if (socket.connected) await socket.join(inboxRoom(actor.user.id));
      return {};
    });

  });

  let checking = false;
  let stopped = false;
  const timer = setInterval(async () => {
    if (checking) return;
    checking = true;
    try {
      for (const socket of io.sockets.sockets.values()) {
        if (stopped) break;
        try { await authenticate(socket); } catch { /* The session is checked again on every chat event. */ }
      }
    } finally {
      checking = false;
    }
  }, interval);
  timer.unref();

  return {
    notify(change: BookingChatChange) {
      deliverBooking(change);
      void bookingSignals.publish(change);
    },
    notifySupport(change: SupportChange) {
      deliverSupport(change);
      void support.publish(change);
    },
    close() {
      support.close();
      stopped = true;
      clearInterval(timer);
      bookingSignals.close();
      inbox.close();
      io.disconnectSockets(true);
      io.engine.close();
    },
  };
}
