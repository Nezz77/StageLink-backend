import type { BookingReminder, PrismaClient } from '../generated/prisma/client.js';
import { lockBooking, paidAdvance, paymentBlocked } from '../api/src/bookings/lifecycle.js';
import type { createMailer } from './auth-mail.js';
import { databaseNow } from './database-clock.js';
import type { Config } from './config.js';

type Mailer = Pick<ReturnType<typeof createMailer>, 'sendMail'>;

// A reminder queued after its due time is still useful until the next reminder window.
const windowEnd = (job: BookingReminder) => new Date(job.startsAt.getTime() - (job.offsetHours === 24 ? 2 * 3_600_000 : 0));

export async function scheduleBookingReminders(db: PrismaClient) {
  return db.$executeRaw`
    INSERT INTO booking_reminders (booking_id, recipient_id, starts_at, due_at, offset_hours)
    SELECT b.id, recipient.id, b.starts_at, b.starts_at - offsets.hours * interval '1 hour', offsets.hours
    FROM bookings b
    CROSS JOIN LATERAL (VALUES (b.customer_id), (b.provider_id)) AS recipient(id)
    CROSS JOIN (VALUES (24), (2)) AS offsets(hours)
    WHERE b.agreed_at IS NOT NULL AND b.cancelled_at IS NULL
      AND b.starts_at > now() AND b.starts_at <= now() + interval '7 days'
      AND b.starts_at - (CASE WHEN offsets.hours = 24 THEN 2 ELSE 0 END) * interval '1 hour' > now()
      AND EXISTS (SELECT 1 FROM payment_orders p WHERE p.booking_id=b.id AND p.purpose='advance' AND p.status='paid')
      AND NOT EXISTS (
        SELECT 1 FROM booking_reminders r
        WHERE r.booking_id=b.id AND r.recipient_id=recipient.id AND r.starts_at=b.starts_at AND r.offset_hours=offsets.hours
      )
    ORDER BY b.starts_at, b.id, recipient.id, offsets.hours
    LIMIT 250
    ON CONFLICT (booking_id, recipient_id, starts_at, offset_hours) DO NOTHING`;
}

export function smtpFailureState(error: unknown): 'failed' | 'unknown' {
  const failure = error as { responseCode?: number } | null;
  const code = failure?.responseCode;
  return typeof code === 'number' && code >= 400 && code < 600 ? 'failed' : 'unknown';
}

export async function processBookingReminders(db: PrismaClient, config: Config, mailer: Mailer) {
  await db.$executeRaw`UPDATE booking_reminders SET status='unknown', sending_at=NULL, last_code='SEND_INTERRUPTED' WHERE status='sending' AND sending_at<clock_timestamp()-interval '60 seconds'`;
  // Invalidate old schedule rows even when delivery has been disabled.
  await db.$executeRaw`
    UPDATE booking_reminders r SET status='cancelled', last_code='SCHEDULE_NO_LONGER_ELIGIBLE'
    FROM bookings b WHERE r.booking_id=b.id AND r.status IN ('queued','failed')
      AND (b.cancelled_at IS NOT NULL OR b.agreed_at IS NULL OR r.starts_at<>b.starts_at
        OR now() >= r.starts_at - (CASE WHEN r.offset_hours=24 THEN 2 ELSE 0 END) * interval '1 hour')`;
  if (config.BOOKING_EMAIL_REMINDERS !== 'true') return;
  await scheduleBookingReminders(db);
  const candidate = await db.bookingReminder.findFirst({
    where: {
      status: 'queued', dueAt: { lte: await databaseNow(db) }, attempts: { lt: 3 },
      recipient: {
        disabledAt: null, emailVerifiedAt: { not: null },
        OR: [{ notificationPreferences: null }, { notificationPreferences: { bookingReminderEmail: true } }],
      },
      booking: { AND: [
        { OR: [{ dispute: null }, { dispute: { dismissedAt: { not: null } } }] },
        { OR: [{ refundRequest: null }, { refundRequest: { status: 'declined' } }] },
        { paymentOrders: { some: { purpose: 'advance', status: 'paid' } } },
      ] },
    },
    orderBy: [{ dueAt: 'asc' }, { id: 'asc' }],
  });
  if (!candidate) return;
  const claimed = await db.$transaction(async tx => {
    // Use the same lock order as booking changes: users, booking, reminder.
    await tx.$queryRaw`SELECT id FROM auth_users WHERE id=${candidate.recipientId}::uuid FOR UPDATE`;
    await lockBooking(tx, candidate.bookingId);
    await tx.$queryRaw`SELECT id FROM booking_reminders WHERE id=${candidate.id}::uuid FOR UPDATE`;
    const current = await tx.bookingReminder.findUnique({
      where: { id: candidate.id }, include: {
        booking: { select: { startsAt: true, agreedAt: true, cancelledAt: true } },
        recipient: { select: {
          email: true, emailVerifiedAt: true, disabledAt: true,
          notificationPreferences: { select: { bookingReminderEmail: true } },
        } },
      },
    });
    if (!current || current.status !== 'queued' || current.attempts >= 3) return null;
    const started = await databaseNow(tx);
    const booking = current.booking;
    if (!booking.agreedAt || booking.cancelledAt || booking.startsAt.getTime() !== current.startsAt.getTime() ||
      windowEnd(current) <= started) {
      await tx.bookingReminder.update({ where: { id: current.id }, data: { status: 'cancelled', lastCode: 'RECIPIENT_OR_BOOKING_INELIGIBLE' } });
      return null;
    }
    if (current.dueAt > started || await paymentBlocked(tx, current.bookingId) || !await paidAdvance(tx, current.bookingId) ||
      current.recipient.disabledAt || !current.recipient.emailVerifiedAt ||
      current.recipient.notificationPreferences?.bookingReminderEmail === false) return null;
    await tx.bookingReminder.update({
      where: { id: current.id }, data: { status: 'sending', sendingAt: started, attempts: { increment: 1 }, lastCode: null },
    });
    return { ...current, sendingAt: started };
  });
  if (!claimed) return;
  const where = { id: claimed.id, status: 'sending' as const, sendingAt: claimed.sendingAt };
  const start = new Intl.DateTimeFormat('en-LK', {
    dateStyle: 'full', timeStyle: 'short', timeZone: 'Asia/Colombo',
  }).format(claimed.startsAt);
  let status: 'accepted' | 'failed' | 'unknown';
  let lastCode: string | null;
  try {
    const result = await mailer.sendMail({
      from: config.SMTP_FROM, to: claimed.recipient.email,
      subject: 'Upcoming StageLink booking',
      messageId: '<booking-reminder-' + claimed.id + '@' + config.SMTP_FROM.split('@')[1] + '>',
      text: ['Your StageLink booking is scheduled for ' + start + ' (Sri Lanka time).',
        'Booking reference: ' + claimed.bookingId, 'View your booking in StageLink: ' + config.WEB_ORIGIN].join('\n\n'),
    });
    status = result.accepted?.length ? 'accepted' : 'failed';
    lastCode = status === 'accepted' ? null : 'SMTP_REJECTED';
  } catch (error) {
    status = smtpFailureState(error);
    lastCode = status === 'failed' ? 'SMTP_REJECTED' : 'SMTP_OUTCOME_UNKNOWN';
  }
  await db.bookingReminder.updateMany({
    where, data: { status, lastCode, sendingAt: null, acceptedAt: status === 'accepted' ? await databaseNow(db) : null },
  });
}
