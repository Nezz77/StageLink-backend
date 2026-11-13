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

// Call with the provider user row locked, shared by catalog, calendar and inventory mutations.
export async function checkCapacity(tx: Prisma.TransactionClient, lines: ReservationLine[], window: Window, now: Date, exclude?: string) {
  for (const line of lines) {
    let capacity = line.capacity;
    if (line.resource === 'equipment') {
      const counts = await tx.inventoryUnit.groupBy({
        by: ['status'], where: { listingId: line.resourceId }, _count: { _all: true },
      });
      if (counts.length) capacity = Math.min(capacity, counts.find(row => row.status === 'available')?._count._all ?? 0);
    }
    const held = await tx.bookingReservationLine.findMany({
      where: {
        resource: line.resource, resourceId: line.resourceId, ...(exclude ? { bookingId: { not: exclude } } : {}),
        booking: { cancelledAt: null, OR: [{ agreedAt: { not: null } }, { providerDecision: null, holdExpiresAt: { gt: now } }, { providerDecision: 'accepted', holdExpiresAt: { gt: now } }], startsAt: { lt: window.endsAt }, endsAt: { gt: window.startsAt } },
      },
      select: { quantity: true, booking: { select: { startsAt: true, endsAt: true } } },
    });
    if (line.quantity + peakReserved(held.map(row => ({ ...row.booking, quantity: row.quantity })), window) > capacity) unavailable();
  }
}
