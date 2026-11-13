import { Controller, Get, Header, HttpCode, Param, Post, Query, Req, StreamableFile } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiParam, ApiProduces, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import type { BookingDocument, Prisma } from '../../../generated/prisma/client.js';
import { documentKey, documentNumber, documentSnapshot } from '../../../shared/booking-documents.js';
import type { MediaStore } from '../../../shared/media-store.js';
import { PublicError } from '../auth/errors.js';
import type { AuthService, Identity } from '../auth/service.js';
import { parse, schema, uuid } from '../payments/orders.js';
import { ProfileService } from '../profiles/service.js';
import { member } from './requests.js';

const view = z.object({
  id: uuid, bookingId: uuid, number: z.string(), status: z.enum(['pending', 'ready', 'failed']),
  currency: z.literal('LKR'), environment: z.literal('sandbox'), snapshot: documentSnapshot,
});
const page = z.object({ items: z.array(view), nextCursor: uuid.nullable() });
const pageSize = 30;

function present(row: BookingDocument) {
  return {
    id: row.id, bookingId: row.bookingId, number: documentNumber(row.kind, row.id), status: row.status,
    currency: 'LKR' as const, environment: 'sandbox' as const, snapshot: documentSnapshot.parse(row.snapshot),
  };
}

export function makeDocumentsController(auth: AuthService, store: MediaStore) {
  const db = auth.deps.db;
  const profiles = new ProfileService(auth);
  const identity = (req: Request) => auth.authenticate(req.get('Authorization'));

  async function read(tx: Prisma.TransactionClient, id: string, actor: Identity) {
    const userId = actor.user.id;
    const admin = actor.session.activeRole === 'admin' && actor.user.roles.includes('admin');
    const row = await tx.bookingDocument.findFirst({
      where: {
        id,
        ...(!admin ? { OR: [
          { kind: 'invoice', booking: { OR: [{ customerId: userId }, { providerId: userId }] } },
          { kind: 'receipt', booking: { customerId: userId } },
          { kind: 'settlement', booking: { providerId: userId } },
        ] } : {}),
      },
    });
    if (!row) throw new PublicError(404, 'DOCUMENT_NOT_FOUND', 'This booking document is unavailable.');
    return row;
  }

  @ApiTags('Booking documents')
  @ApiBearerAuth()
  @Controller()
  class DocumentsController {
    @Get('bookings/:id/documents')
    @ApiParam({ name: 'id', format: 'uuid' })
    @ApiQuery({ name: 'cursor', required: false, type: String })
    @ApiOkResponse({ schema: schema(page) })
    async list(@Req() req: Request, @Param('id') id: string, @Query('cursor') raw?: string) {
      const actor = await identity(req);
      const bookingId = parse(uuid, id);
      const cursor = raw === undefined ? undefined : parse(uuid, raw);
      const admin = actor.session.activeRole === 'admin' && actor.user.roles.includes('admin');
      const booking = admin ? await db.booking.findUnique({ where: { id: bookingId } })
        : await member(db, bookingId, actor.user.id);
      if (!booking) throw new PublicError(404, 'BOOKING_NOT_FOUND', 'This booking is unavailable.');
      const rows = await db.bookingDocument.findMany({
        where: {
          bookingId, ...(cursor ? { id: { gt: cursor } } : {}),
          ...(!admin ? { kind: { in: ['invoice', actor.user.id === booking.customerId ? 'receipt' : 'settlement'] } } : {}),
        },
        orderBy: { id: 'asc' }, take: pageSize + 1,
      });
      const items = rows.slice(0, pageSize).map(present);
      return { items, nextCursor: rows.length > pageSize ? items[pageSize - 1]!.id : null };
    }

    @Get('documents/:id')
    @ApiParam({ name: 'id', format: 'uuid' })
    @ApiOkResponse({ schema: schema(view) })
    async detail(@Req() req: Request, @Param('id') id: string) {
      return present(await read(db, parse(uuid, id), await identity(req)));
    }

    @Post('documents/:id/render-retry')
    @HttpCode(200)
    @ApiParam({ name: 'id', format: 'uuid' })
    @ApiOkResponse({ schema: schema(view) })
    async retry(@Req() req: Request, @Param('id') id: string) {
      if (req.get('Origin') !== auth.config.WEB_ORIGIN || req.get('Sec-Fetch-Site') === 'cross-site' || !req.is('application/json')) {
        throw new PublicError(403, 'ORIGIN_REJECTED', 'Open StageLink in its own browser tab and try again.');
      }
      const actor = await identity(req);
      profiles.checkCsrf(actor, req.get('X-CSRF-Token'));
      return db.$transaction(async tx => {
        const current = await profiles.actor(tx, actor);
        const row = await read(tx, parse(uuid, id), current);
        if (row.status !== 'failed') return present(row);
        await tx.bookingDocument.updateMany({ where: { id: row.id, status: 'failed' }, data: { status: 'pending' } });
        return present(await tx.bookingDocument.findUniqueOrThrow({ where: { id: row.id } }));
      });
    }

    @Get('documents/:id/download')
    @Header('Cache-Control', 'private, no-store')
    @ApiParam({ name: 'id', format: 'uuid' })
    @ApiProduces('application/pdf')
    @ApiOkResponse({ schema: { type: 'string', format: 'binary' } })
    async download(@Req() req: Request, @Param('id') id: string) {
      const row = await read(db, parse(uuid, id), await identity(req));
      if (row.status !== 'ready' || !row.renderId) throw new PublicError(409, 'DOCUMENT_NOT_READY', 'This document is awaiting a successful render.');
      let bytes: Buffer;
      try {
        bytes = await store.get(documentKey(row.id, row.renderId), 1024 * 1024);
      } catch {
        throw new PublicError(503, 'DOCUMENT_STORAGE_UNAVAILABLE', 'The document could not be retrieved.');
      }
      return new StreamableFile(bytes, {
        type: 'application/pdf', disposition: 'attachment; filename="' + documentNumber(row.kind, row.id) + '.pdf"',
        length: bytes.length,
      });
    }
  }
  return DocumentsController;
}
