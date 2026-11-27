import assert from 'node:assert/strict';
import { test } from 'node:test';
import { payoutStatementSmokeConfig, runPayoutStatementSmoke } from '../scripts/payout-statement-smoke.js';
import { documentNumber } from '../shared/booking-documents.js';

const bookingId = 'a018594a-02ce-445f-97c7-6ebc73d5bb14';
const settlementId = '5f6fe928-b401-416b-91d0-9a0af6a11203';
const reversalId = 'e269bb37-7a18-4809-bb0c-50e08bce915e';
const originalJournalId = '668bc5c4-3510-4400-b69f-238d03c4d2d1';
const reversalJournalId = '4367728b-ec8b-4e54-9a70-8062cf68d7b2';
const env = {
  STAGELINK_SMOKE_ORIGIN: 'https://staging.example.test',
  STAGELINK_SMOKE_BOOKING_ID: bookingId,
  STAGELINK_SMOKE_PAYOUT_SETTLEMENT_DOCUMENT_ID: settlementId,
  STAGELINK_SMOKE_PAYOUT_REVERSAL_DOCUMENT_ID: reversalId,
};
const credentials = { admin: 'staging.admin.signature', provider: 'staging.provider.signature', customer: 'staging.customer.signature' };
const config = payoutStatementSmokeConfig(env, credentials);

function transport(fault?: 'link' | 'cache' | 'access' | 'storage' | 'same_pdf' | 'size'): typeof fetch {
  return async (input, init) => {
    const url = new URL(String(input));
    const parts = url.pathname.split('/');
    const id = parts[4]!;
    assert.equal(url.origin, config.origin);
    assert.equal(init?.method, 'GET');
    assert.equal(init?.redirect, 'error');
    assert.equal(url.search, '');
    assert.ok(id === settlementId || id === reversalId);
    const headers = new Headers(init?.headers);
    const auth = headers.get('Authorization');
    const reversing = id === reversalId;
    const number = documentNumber('settlement', id);
    if (parts.length === 5) {
      assert.equal(auth, 'Bearer ' + credentials.admin);
      const reference = { settlementId, revision: 2 };
      return Response.json({
        id, bookingId, number, status: 'ready', currency: 'LKR', environment: 'sandbox',
        snapshot: {
          kind: 'settlement', version: 3, issuedAt: '2026-11-27T08:00:00.000Z',
          grossMinor: 1000, platformFeeMinor: 50, netMinor: 950, destinationRevision: 1,
          manualSettlement: reversing ? { ...reference, state: 'reversed', journalId: reversalJournalId,
            originalJournalId: fault === 'link' ? reversalJournalId : originalJournalId } :
            { ...reference, state: 'settled', journalId: originalJournalId },
        },
      });
    }
    assert.equal(parts[5], 'download');
    if (!auth) return new Response(null, { status: 401 });
    if (auth === 'Bearer ' + credentials.customer && fault !== 'access') return new Response(null, { status: 404 });
    const marker = reversing && fault !== 'same_pdf' ? reversalId : settlementId;
    const suffix = fault === 'storage' && auth === 'Bearer ' + credentials.admin ? 'other bytes' : 'private bytes';
    const body = fault === 'size' ? '%PDF-' + 'x'.repeat(1024 * 1024) : '%PDF-' + marker + suffix;
    return new Response(body, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': 'attachment; filename="' + number + '.pdf"',
        'Cache-Control': fault === 'cache' ? 'public, no-store' : 'private, no-store',
      },
    });
  };
}

test('payout statement smoke verifies linked PDFs and access without reporting record IDs or data', async () => {
  const report = await runPayoutStatementSmoke(config, transport());
  assert.equal(report.passed, true);
  assert.equal(report.checks.length, 12);
  assert.doesNotMatch(JSON.stringify(report), /signature|5f6fe928|private bytes|[a-f0-9]{64}/);
});

test('payout statement smoke rejects invalid fixtures, public access, byte mismatches and oversized PDFs', async () => {
  for (const [fault, check] of [
    ['link', 'linked_manual_statement_fixtures'], ['cache', 'provider_settlement'], ['access', 'customer_reversal_denied'],
    ['storage', 'settlement_pdf_matches'], ['same_pdf', 'settlement_and_reversal_pdfs_differ'], ['size', 'admin_reversal'],
  ] as const) {
    const report = await runPayoutStatementSmoke(config, transport(fault));
    assert.equal(report.passed, false);
    assert.equal(report.checks.find(row => row.check === check)?.passed, false);
  }
  assert.throws(() => payoutStatementSmokeConfig(env, { ...credentials, customer: credentials.provider }));
  assert.throws(() => payoutStatementSmokeConfig({ ...env, STAGELINK_SMOKE_ORIGIN: env.STAGELINK_SMOKE_ORIGIN + '/api' }, credentials));
});
