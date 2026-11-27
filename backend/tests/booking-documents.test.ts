import { test } from 'node:test';
import assert from 'node:assert/strict';
import { documentNumber, renderBookingDocument } from '../shared/booking-documents.js';

test('server renders each sandbox booking document from its stable snapshot', () => {
  const id = '5f6fe928-b401-416b-91d0-9a0af6a11203';
  const bookingId = 'a018594a-02ce-445f-97c7-6ebc73d5bb14';
  const issuedAt = '2026-11-13T18:00:00.000Z';
  const common = { version: 1, issuedAt };
  const allocation = { grossMinor: 35_011, platformFeeMinor: 1_751, netMinor: 33_260, destinationRevision: 2 };
  const reference = { settlementId: id, journalId: '668bc5c4-3510-4400-b69f-238d03c4d2d1' };
  const snapshots = [
    { ...common, kind: 'invoice', totalMinor: 35_011, advanceMinor: 17_506, depositMinor: 0,
      startsAt: issuedAt, endsAt: '2026-11-13T19:00:00.000Z', agreementDigest: '0'.repeat(64) },
    { ...common, kind: 'receipt', purpose: 'advance', amountMinor: 17_506, gateway: 'Stripe', orderId: id, disposition: 'review' },
    { version: 2, issuedAt, kind: 'receipt', purpose: 'deposit', amountMinor: 15_000, gateway: 'PayHere',
      orderId: id, disposition: 'refunded', refundContext: 'deposit_claim', refundExecutionId: id, journalId: reference.journalId },
    { ...common, ...allocation, kind: 'settlement' },
    { version: 2, issuedAt, ...allocation, kind: 'settlement', bankSettlement: { ...reference, state: 'settled' } },
    { version: 2, issuedAt, ...allocation, kind: 'settlement', bankSettlement: {
      ...reference, state: 'reversed', originalJournalId: id, reason: 'transfer_reversed',
    } },
  ] as const;
  for (const snapshot of snapshots) {
    const record = { id, bookingId, kind: snapshot.kind, snapshot };
    const pdf = renderBookingDocument(record);
    assert.match(pdf.toString('latin1'), /^%PDF-/);
    assert.match(pdf.toString('latin1'), /%%EOF$/);
    assert.deepEqual(renderBookingDocument(record), pdf);
  }
  assert.equal(documentNumber('receipt', id), 'RCT-' + id.toUpperCase());
  assert.throws(() => renderBookingDocument({ id, bookingId, kind: 'receipt', snapshot: snapshots[0] }), /kind mismatch/);
  assert.throws(() => renderBookingDocument({ id, bookingId, kind: 'settlement', snapshot: { ...snapshots[3], version: 2 } }));
  assert.throws(() => renderBookingDocument({ id, bookingId, kind: 'receipt', snapshot: { ...snapshots[2], amountMinor: 0 } }));
});
