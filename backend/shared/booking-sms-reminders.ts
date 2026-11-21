import type { BookingSmsReminder, PrismaClient } from '../generated/prisma/client.js';
import { lockBooking, paidAdvance, paymentBlocked } from '../api/src/bookings/lifecycle.js';
import { unseal } from '../api/src/auth/security.js';
import type { Config } from './config.js';
import { TextLk, reserveSmsSubmission, smsDigest, type SmsResult } from './sms.js';
import { contactContext, verifiedNumber } from './sms-verification.js';

type Transport = Pick<TextLk, 'send' | 'read'>;
const hour = 3_600_000;
const windowEnd = (job: BookingSmsReminder) => job.startsAt.getTime() - (job.offsetHours === 24 ? 2 * hour : 0);
const dateFormat = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Colombo',
});

export function scheduleBookingSmsReminders(db: PrismaClient) {
  return db.$executeRaw`
    INSERT INTO booking_sms_reminders (booking_id, recipient_id, starts_at, due_at, offset_hours)
    SELECT b.id, u.id, b.starts_at, b.starts_at - offsets.hours * interval '1 hour', offsets.hours
    FROM bookings b
    CROSS JOIN LATERAL (VALUES (b.customer_id), (b.provider_id)) AS recipient(id)
    JOIN auth_users u ON u.id = recipient.id
    JOIN sms_contacts c ON c.user_id = u.id
    CROSS JOIN (VALUES (24), (2)) AS offsets(hours)
    WHERE c.booking_consent AND c.verified_at IS NOT NULL AND u.email_verified_at IS NOT NULL AND u.disabled_at IS NULL
      AND b.agreed_at IS NOT NULL AND b.cancelled_at IS NULL AND b.starts_at <= now() + interval '7 days'
      AND b.starts_at - (CASE WHEN offsets.hours = 24 THEN 2 ELSE 0 END) * interval '1 hour' > now()
      AND EXISTS (SELECT 1 FROM payment_orders p WHERE p.booking_id = b.id AND p.purpose = 'advance' AND p.status = 'paid')
      AND NOT EXISTS (
        SELECT 1 FROM booking_sms_reminders r
        WHERE r.booking_id = b.id AND r.recipient_id = u.id AND r.starts_at = b.starts_at AND r.offset_hours = offsets.hours
      )
    ORDER BY b.starts_at, b.id, u.id, offsets.hours
    LIMIT 250
    ON CONFLICT (booking_id, recipient_id, starts_at, offset_hours) DO NOTHING`;
}

async function submitDue(db: PrismaClient, config: Config, transport: Transport) {
  const candidate = await db.bookingSmsReminder.findFirst({
    where: {
      status: 'queued', dueAt: { lte: new Date() },
      booking: { AND: [
        { OR: [{ dispute: null }, { dispute: { dismissedAt: { not: null } } }] },
        { OR: [{ refundRequest: null }, { refundRequest: { status: 'declined' } }] },
        { paymentOrders: { some: { purpose: 'advance', status: 'paid' } } },
      ] },
    },
    orderBy: [{ dueAt: 'asc' }, { id: 'asc' }],
  });
  if (!candidate) return;

  const claim = await db.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM auth_users WHERE id=${candidate.recipientId}::uuid FOR UPDATE`;
    await lockBooking(tx, candidate.bookingId);
    await tx.$queryRaw`SELECT id FROM booking_sms_reminders WHERE id=${candidate.id}::uuid FOR UPDATE`;
    const row = await tx.bookingSmsReminder.findUnique({
      where: { id: candidate.id },
      include: {
        booking: { select: { startsAt: true, agreedAt: true, cancelledAt: true, providerId: true, customerId: true } },
        recipient: { select: { disabledAt: true, emailVerifiedAt: true, smsContact: true } },
      },
    });
    if (!row || row.status !== 'queued') return null;
    const { booking, recipient } = row;
    const contact = recipient.smsContact;
    const now = Date.now();
    if (!booking.agreedAt || booking.cancelledAt || booking.startsAt.getTime() !== row.startsAt.getTime() ||
      ![booking.customerId, booking.providerId].includes(row.recipientId) || windowEnd(row) <= now ||
      recipient.disabledAt || !recipient.emailVerifiedAt || !contact?.verifiedAt || !contact.bookingConsent || !contact.sealedNumber) {
      await tx.bookingSmsReminder.update({ where: { id: row.id }, data: { status: 'cancelled', lastCode: 'REMINDER_NO_LONGER_ELIGIBLE' } });
      return null;
    }
    if (row.dueAt.getTime() > now || await paymentBlocked(tx, row.bookingId) || !await paidAdvance(tx, row.bookingId)) return null;

    let number: string;
    try {
      number = verifiedNumber.parse(unseal(config.AUTH_MAIL_KEY, contact.sealedNumber, contactContext(row.recipientId))).number;
    } catch {
      await tx.bookingSmsReminder.update({ where: { id: row.id }, data: { status: 'failed', lastCode: 'INVALID_SMS_CONTACT' } });
      return null;
    }
    const sendingAt = await reserveSmsSubmission(tx, config);
    if (!sendingAt || sendingAt.getTime() >= windowEnd(row)) return null;
    const targetDigest = smsDigest(config, number);
    await tx.bookingSmsReminder.update({ where: { id: row.id }, data: { status: 'sending', sendingAt, targetDigest } });
    return { id: row.id, startsAt: row.startsAt, sendingAt, number, targetDigest };
  });
  if (!claim) return;

  const start = dateFormat.format(claim.startsAt).replace(/\s+/g, ' ');
  const payload = { number: claim.number, message: `StageLink booking reminder: ${start} Sri Lanka time. Open StageLink for details.` };
  const result = await transport.send(payload, claim.targetDigest).catch((): SmsResult => ({
    status: 'unknown', providerId: null, code: 'PROVIDER_OUTCOME_UNKNOWN',
  }));
  await db.bookingSmsReminder.updateMany({
    where: { id: claim.id, status: { in: ['sending', 'unknown'] }, sendingAt: claim.sendingAt },
    data: { status: result.status, providerId: result.providerId, lastCode: result.code, checkedAt: new Date() },
  });
}

async function reconcileDelivery(db: PrismaClient, transport: Transport) {
  const pending = await db.bookingSmsReminder.findFirst({
    where: {
      sendingAt: { gt: new Date(Date.now() - 24 * hour) }, status: { in: ['accepted', 'unknown'] },
      providerId: { not: null }, targetDigest: { not: null },
      OR: [{ checkedAt: null }, { checkedAt: { lt: new Date(Date.now() - 30_000) } }],
    },
    orderBy: { checkedAt: { sort: 'asc', nulls: 'first' } },
  });
  if (!pending?.providerId || !pending.targetDigest) return;
  const result = await transport.read(pending.providerId, pending.targetDigest);
  await db.bookingSmsReminder.updateMany({
    where: { id: pending.id, providerId: pending.providerId, status: pending.status, checkedAt: pending.checkedAt },
    data: { status: result.status === 'unknown' ? pending.status : result.status, lastCode: result.code, checkedAt: new Date() },
  });
}

export async function processBookingSmsReminders(db: PrismaClient, config: Config, transport: Transport = new TextLk(config)) {
  await db.bookingSmsReminder.updateMany({
    where: { status: 'sending', sendingAt: { lt: new Date(Date.now() - 30_000) } },
    data: { status: 'unknown', lastCode: 'SEND_INTERRUPTED' },
  });
  await db.$executeRaw`
    UPDATE booking_sms_reminders r SET status = 'cancelled', last_code = 'REMINDER_NO_LONGER_ELIGIBLE'
    FROM bookings b WHERE r.booking_id = b.id AND r.status = 'queued'
      AND (b.cancelled_at IS NOT NULL OR b.agreed_at IS NULL OR r.starts_at <> b.starts_at
        OR now() >= r.starts_at - (CASE WHEN r.offset_hours = 24 THEN 2 ELSE 0 END) * interval '1 hour'
        OR NOT EXISTS (SELECT 1 FROM sms_contacts c JOIN auth_users u ON u.id = c.user_id
          WHERE c.user_id = r.recipient_id AND c.booking_consent AND c.verified_at IS NOT NULL
            AND u.disabled_at IS NULL AND u.email_verified_at IS NOT NULL))`;
  if (config.BOOKING_SMS_REMINDERS !== 'true') return;
  await scheduleBookingSmsReminders(db);
  await submitDue(db, config, transport);
  await reconcileDelivery(db, transport);
}
