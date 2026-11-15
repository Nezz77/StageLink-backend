import type { Server as HttpServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import { z } from 'zod';
import { log } from '../../../shared/log.js';
import { PublicError } from '../auth/errors.js';
import type { AuthService, Identity } from '../auth/service.js';
import { checkMaintenance } from '../operations/maintenance.js';
import type { BookingChat, BookingChatChange } from './messages.js';

const maxRooms = 16;
const interval = 15_000;
const bookingId = z.uuid().transform(id => id.toLowerCase());
const roomInput = z.object({ bookingId }).strict();
const writeInput = roomInput.extend({ data: z.unknown() });
const typingInput = roomInput.extend({ typing: z.boolean() });

type Failure = { ok: false; error: { code: string; message: string } };
type Ack = (result: { ok: true; data: unknown } | Failure) => void;
type ChatAction = (identity: Identity, input: unknown) => unknown;
type Typing = { bookingId: string; userId: string; typing: boolean };

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

  async function deliver(event: 'chat:changed' | 'chat:typing', payload: BookingChatChange | Typing, skip?: Socket) {
    const sockets = io.sockets.adapter.rooms.get(room(payload.bookingId));
    if (!sockets) return;
    await Promise.all([...sockets].map(async id => {
      const socket = io.sockets.sockets.get(id);
      if (!socket || socket === skip) return;
      try {
        await authenticate(socket);
        if (!socket.connected || !socket.rooms.has(room(payload.bookingId))) return;
        if (event === 'chat:typing') socket.volatile.emit(event, payload);
        else socket.emit(event, payload);
      } catch (error) {
        if (!(error instanceof PublicError)) log('chat.delivery_failed', { code: 'CHAT_UNAVAILABLE' });
      }
    }));
  }

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
      if (socket.rooms.size > maxRooms && !socket.rooms.has(room(id))) {
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
        void deliver('chat:typing', { bookingId, userId: actor.user.id, typing }, socket);
      }
      return { bookingId };
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
    notify(change: BookingChatChange) { void deliver('chat:changed', change); },
    close() {
      stopped = true;
      clearInterval(timer);
      io.disconnectSockets(true);
      io.engine.close();
    },
  };
}
