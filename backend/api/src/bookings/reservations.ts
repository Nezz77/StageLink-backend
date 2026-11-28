import type { Prisma, ReservationResource } from '../../../generated/prisma/client.js';
import { PublicError } from '../auth/errors.js';
import { dayHours } from '../profiles/schemas.js';
import { z } from 'zod';

type Window = { startsAt: Date; endsAt: Date };
export type ReservationLine = { resource: ReservationResource; resourceId: string; quantity: number; capacity: number };

function unavailable(): never {
  throw new PublicError(409, 'RESERVATION_UNAVAILABLE', 'The requested time or quantity is unavailable.');
}

export async function checkCalendar(tx: Prisma.TransactionClient, providerId: string, window: Window, artist: boolean) {
  const calendar = await tx.availabilityCalendar.findUnique({
    where: { ownerId: providerId },
    include: { blocks: { where: { startsAt: { lt: window.endsAt }, endsAt: { gt: window.startsAt } }, take: 1 } },
  });
  if (!calendar) return;
  if (calendar.blocks.length) unavailable();
  const rules = z.array(dayHours).parse(calendar.hours);
  const format = new Intl.DateTimeFormat('en-US', {
    timeZone: calendar.timezone, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  function local(date: Date) {
    const parts = Object.fromEntries(format.formatToParts(date).map(part => [part.type, part.value]));
    return {
      rule: rules.find(rule => rule.day === ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday ?? '')),
      time: parts.hour + ':' + parts.minute,
      day: parts.year + '-' + parts.month + '-' + parts.day,
    };
  }
  const start = local(window.startsAt), end = local(window.endsAt);
  if (!start.rule?.opens || !start.rule.closes || start.time < start.rule.opens || start.time >= start.rule.closes ||
    !end.rule?.opens || !end.rule.closes || end.time < end.rule.opens || end.time > end.rule.closes ||
    (artist && start.day !== end.day)) unavailable();
}

export function peakReserved(allocations: (Window & { quantity: number })[], window: Window) {
  const events = allocations.filter(row => row.startsAt < window.endsAt && row.endsAt > window.startsAt).flatMap(({ startsAt, endsAt, quantity }) => [
    { at: Math.max(startsAt.getTime(), window.startsAt.getTime()), change: quantity },
    { at: Math.min(endsAt.getTime(), window.endsAt.getTime()), change: -quantity },
  ]).sort((a, b) => a.at - b.at || a.change - b.change);
  let total = 0, peak = 0;
  for (const event of events) {
    total += event.change;
    peak = Math.max(peak, total);
  }
  return peak;
}

export async function reservationStock(tx: Prisma.TransactionClient, line: ReservationLine, window: Window, now: Date, exclude?: string) {
  let availableSerials: number | null = null;
  if (line.resource === 'equipment') {
    const counts = await tx.inventoryUnit.groupBy({
      by: ['status'], where: { listingId: line.resourceId }, _count: { _all: true },
    });
    if (counts.length) availableSerials = counts.find(row => row.status === 'available')?._count._all ?? 0;
  }
  const held = await tx.bookingReservationLine.findMany({
    where: {
      resource: line.resource, resourceId: line.resourceId, ...(exclude ? { bookingId: { not: exclude } } : {}),
      booking: {
        cancelledAt: null, startsAt: { lt: window.endsAt }, endsAt: { gt: window.startsAt },
        OR: [
          { agreedAt: { not: null } },
          { providerDecision: null, holdExpiresAt: { gt: now } },
          { providerDecision: 'accepted', holdExpiresAt: { gt: now } },
        ],
      },
    },
    select: {
      quantity: true,
      booking: { select: {
        startsAt: true,
        endsAt: true,
        inspection: { select: { _count: { select: {
          units: { where: { releasedAt: null, unit: { listingId: line.resourceId, status: { not: 'available' } } } },
        } } } },
      } },
    },
  });
  const catalogReserved = peakReserved(held.map(({ booking, quantity }) => ({
    startsAt: booking.startsAt, endsAt: booking.endsAt, quantity,
  })), window);
  const catalogRemaining = line.capacity - catalogReserved;
  if (availableSerials === null) {
    return { totalUnits: line.capacity, reservedUnits: catalogReserved, availableUnits: Math.max(0, catalogRemaining) };
  }

  // An unreleased serial already out of stock covers the overlapping reservation that assigned it.
  // Keep it unavailable outside that reservation too until the inspection releases it.
  let occupiedSerials = 0;
  const holdsOnAvailableSerials = held.map(({ booking, quantity }) => {
    const assigned = Math.min(quantity, booking.inspection?._count.units ?? 0);
    occupiedSerials += assigned;
    return { startsAt: booking.startsAt, endsAt: booking.endsAt, quantity: quantity - assigned };
  });
  const physicalRemaining = availableSerials - peakReserved(holdsOnAvailableSerials, window);
  const totalUnits = Math.min(line.capacity, availableSerials + occupiedSerials);
  const remaining = Math.min(catalogRemaining, physicalRemaining);
  return { totalUnits, reservedUnits: totalUnits - remaining, availableUnits: Math.max(0, remaining) };
}

// Call with the provider user row locked, shared by catalog, calendar and inventory mutations.
export async function checkCapacity(tx: Prisma.TransactionClient, lines: ReservationLine[], window: Window, now: Date, exclude?: string) {
  for (const line of lines) {
    const stock = await reservationStock(tx, line, window, now, exclude);
    if (line.quantity > stock.availableUnits) unavailable();
  }
}
