import { randomUUID } from 'node:crypto';
import { jsPDF } from 'jspdf';
import { z } from 'zod';
import type { BookingDocument, BookingDocumentKind, Prisma } from '../generated/prisma/client.js';
import type { MediaStore } from './media-store.js';
import type { Resources } from './resources.js';

const minor = z.number().int().nonnegative().max(2_147_483_647);
const time = z.iso.datetime();
const invoice = z.object({
  version: z.literal(1), kind: z.literal('invoice'), issuedAt: time,
  totalMinor: minor, advanceMinor: minor, depositMinor: minor,
  startsAt: time, endsAt: time, agreementDigest: z.string().regex(/^[a-f0-9]{64}$/),
});
const receipt = z.object({
  version: z.literal(1), kind: z.literal('receipt'), issuedAt: time,
  purpose: z.enum(['advance', 'balance', 'deposit']), amountMinor: minor,
  gateway: z.enum(['PayHere', 'Stripe']), orderId: z.string().uuid(),
  disposition: z.enum(['captured', 'review']),
});
const settlement = z.object({
  version: z.literal(1), kind: z.literal('settlement'), issuedAt: time,
  grossMinor: minor, platformFeeMinor: minor, netMinor: minor,
  destinationRevision: z.number().int().positive(), damageClaimId: z.uuid().optional(),
});
export const documentSnapshot = z.discriminatedUnion('kind', [invoice, receipt, settlement]);
export async function issueDocument(
  tx: Prisma.TransactionClient, bookingId: string, sourceId: string, snapshot: z.infer<typeof documentSnapshot>,
) {
  await tx.bookingDocument.create({
    data: { bookingId, sourceId, kind: snapshot.kind, snapshot: documentSnapshot.parse(snapshot) },
  });
}

export const documentKey = (id: string, renderId: string) => 'booking-documents/' + id + '/' + renderId + '.pdf';
export const documentNumber = (kind: BookingDocumentKind, id: string) =>
  ({ invoice: 'INV', receipt: 'RCT', settlement: 'SET' })[kind] + '-' + id.toUpperCase();

const titles = { invoice: 'Booking invoice', receipt: 'Payment receipt', settlement: 'Provider settlement statement' };
const amount = (minorUnits: number) => 'LKR ' + (minorUnits / 100).toFixed(2);

export function renderBookingDocument(record: Pick<BookingDocument, 'id' | 'kind' | 'bookingId' | 'snapshot'>) {
  const snapshot = documentSnapshot.parse(record.snapshot);
  if (snapshot.kind !== record.kind) throw new Error('Document kind mismatch');
  const title = titles[snapshot.kind];
  const number = documentNumber(record.kind, record.id);
  const pdf = new jsPDF({ unit: 'mm', format: 'a4', compress: true });
  pdf.setFileId(record.id.replaceAll('-', ''));
  pdf.setCreationDate(new Date(snapshot.issuedAt));
  pdf.setProperties({ title, author: 'StageLink', subject: 'Sandbox record' });
  pdf.setFillColor(255, 255, 255);
  pdf.rect(0, 0, 210, 297, 'F');
  pdf.setFillColor(25, 18, 44);
  pdf.rect(0, 0, 210, 34, 'F');
  pdf.setTextColor(255, 255, 255);
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(20);
  pdf.text('StageLink', 17, 17);
  pdf.setFontSize(9);
  pdf.text('SANDBOX RECORD', 17, 25);
  pdf.setTextColor(34, 30, 44);
  pdf.setFontSize(17);
  pdf.text(title, 17, 48);
  const rows: [string, string][] = [
    ['Document', number], ['Booking', record.bookingId], ['Issued (UTC)', snapshot.issuedAt],
  ];
  switch (snapshot.kind) {
    case 'invoice':
      rows.push(['Service price', amount(snapshot.totalMinor)], ['Service advance', amount(snapshot.advanceMinor)],
        ['Refundable deposit', amount(snapshot.depositMinor)], ['Starts (UTC)', snapshot.startsAt],
        ['Ends (UTC)', snapshot.endsAt], ['Agreement SHA-256', snapshot.agreementDigest]);
      break;
    case 'receipt':
      rows.push(['Payment', snapshot.purpose], ['Captured amount', amount(snapshot.amountMinor)],
        ['Gateway', snapshot.gateway], ['Payment order', snapshot.orderId],
        ['Capture disposition', snapshot.disposition === 'review' ? 'Reconciliation required' : 'Captured in sandbox']);
      break;
    case 'settlement':
      if (snapshot.damageClaimId) rows.push(['Damage claim', snapshot.damageClaimId]);
      rows.push([snapshot.damageClaimId ? 'Reserved deposit deduction' : 'Reserved service funds', amount(snapshot.grossMinor)], ['Platform fee', amount(snapshot.platformFeeMinor)],
        ['Provider net', amount(snapshot.netMinor)], ['Destination revision', String(snapshot.destinationRevision)],
        ['Settlement status', 'Funds reserved in sandbox']);
      break;
  }
  let y = 65;
  for (const [label, value] of rows) {
    pdf.setFontSize(10);
    pdf.setFont('helvetica', 'bold');
    pdf.text(label, 17, y);
    pdf.setFont('helvetica', 'normal');
    const lines = pdf.splitTextToSize(value, 119) as string[];
    pdf.text(lines, 73, y);
    y += 8 + (lines.length - 1) * 5;
  }
  pdf.setDrawColor(215, 208, 228);
  pdf.line(17, 275, 193, 275);
  pdf.setFontSize(8);
  pdf.text('StageLink sandbox record. For testing purposes.', 17, 283);
  return Buffer.from(pdf.output('arraybuffer'));
}

export async function processBookingDocuments(db: Resources['db'], store: MediaStore) {
  const now = new Date();
  const available = { status: 'pending' as const, OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }] };
  const rows = await db.bookingDocument.findMany({ where: available, orderBy: { createdAt: 'asc' }, take: 4 });
  for (const row of rows) {
    const leaseId = randomUUID();
    const leaseUntil = new Date(Date.now() + 60_000);
    const claimed = await db.bookingDocument.updateMany({ where: { id: row.id, ...available }, data: { leaseId, leaseUntil } });
    if (!claimed.count) continue;
    let status: 'ready' | 'failed' = 'ready';
    try {
      await store.put(documentKey(row.id, leaseId), renderBookingDocument(row), 'application/pdf');
    } catch {
      status = 'failed';
    }
    const saved = await db.bookingDocument.updateMany({
      where: { id: row.id, leaseId }, data: { status, leaseId: null, leaseUntil: null, renderId: status === 'ready' ? leaseId : null },
    });
    if (status === 'ready' && !saved.count) await store.remove(documentKey(row.id, leaseId));

  }
}
