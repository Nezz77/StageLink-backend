import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runVerificationPdfSmoke, verificationPdfSmokeConfig } from '../scripts/verification-pdf-smoke.js';

const pending = '9cc551a1-0012-4f86-9bc3-33aa48211111';
const closed = 'f1380fb7-8789-459a-9ed4-edd96f822222';
const env = {
  STAGELINK_SMOKE_ORIGIN: 'https://staging-api.example.test', STAGELINK_SMOKE_WEB_ORIGIN: 'https://staging.example.test',
  STAGELINK_SMOKE_PENDING_PDF_ASSET_ID: pending, STAGELINK_SMOKE_CLOSED_PDF_ASSET_ID: closed,
};
const credentials = {
  owner: { accessToken: 'staging.owner.signature', csrfToken: 'o'.repeat(43) },
  admin: { accessToken: 'staging.admin.signature', csrfToken: 'a'.repeat(43) },
  outsider: { accessToken: 'staging.outsider.signature', csrfToken: 'x'.repeat(43) },
};
const config = verificationPdfSmokeConfig(env, credentials);
const history = { items: [
  { status: 'pending', documents: [{ assetId: pending, mime: 'application/pdf', filename: 'private pending file' }] },
  { status: 'approved', documents: [{ assetId: closed, mime: 'application/pdf', filename: 'private closed file' }] },
] };

function fixture(overrides: { unsafeCapability?: string; unsafePdf?: boolean; mismatchedDerivative?: boolean; wrongHistory?: boolean } = {}) {
  const downloads: URL[] = [];
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, config.origin);
    assert.equal(init?.redirect, 'error');
    const headers = new Headers(init?.headers);
    const auth = headers.get('Authorization');
    if (url.pathname.endsWith('/me/verification')) {
      assert.equal(auth, 'Bearer ' + config.owner.accessToken);
      return Response.json(overrides.wrongHistory ? { items: [] } : history);
    }
    if (url.pathname.endsWith('/access')) {
      assert.equal(init?.method, 'POST');
      assert.equal(headers.get('Origin'), config.webOrigin);
      assert.deepEqual(JSON.parse(String(init?.body)), { variant: 'display' });
      const id = url.pathname.split('/').at(-2);
      if (!auth) return new Response(null, { status: 401 });
      const actor = Object.entries(credentials).find(([, row]) => auth === 'Bearer ' + row.accessToken);
      assert.ok(actor);
      assert.equal(headers.get('X-CSRF-Token'), actor[1].csrfToken);
      if (actor[0] === 'outsider' || (actor[0] === 'admin' && id === closed)) return new Response(null, { status: 404 });
      const path = `/api/v1/media/content/${id}?token=capability.${actor[0]}.signature`;
      const unsafe = actor[0] === 'admin' ? overrides.unsafeCapability : undefined;
      return Response.json({ expiresIn: 60, url: unsafe ?? path });
    }
    assert.equal(auth, null);
    assert.equal(headers.get('X-CSRF-Token'), null);
    const token = url.searchParams.get('token');
    if (!token) return new Response(null, { status: 400 });
    downloads.push(url);
    const admin = token.startsWith('capability.admin.');
    return new Response(admin && overrides.mismatchedDerivative ? '%PDF-1.7\nOther' : '%PDF-1.7\nPrivate test bytes', {
      headers: {
        'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment; filename="verification-evidence.pdf"',
        'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
        'Cache-Control': admin && overrides.unsafePdf ? 'public' : 'no-store',
      },
    });
  };
  return { transport, downloads };
}

test('PDF smoke proves the expected owner, pending administrator and outsider policy without printing sensitive data', async () => {
  const { transport, downloads } = fixture();
  const report = await runVerificationPdfSmoke(config, transport);
  assert.equal(report.passed, true, JSON.stringify(report));
  assert.equal(report.checks.length, 10);
  assert.equal(downloads.length, 3);
  assert.doesNotMatch(JSON.stringify(report), /signature|private pending|Private test bytes|[a-f0-9]{64}|9cc551a1/);
});

test('PDF smoke rejects off-origin and wrong-asset grants before sending the download request', async () => {
  for (const unsafeCapability of [
    `https://other.example.test/api/v1/media/content/${pending}?token=capability.admin.signature`,
    `/api/v1/media/content/${closed}?token=capability.admin.signature`,
  ]) {
    const { transport, downloads } = fixture({ unsafeCapability });
    const report = await runVerificationPdfSmoke(config, transport);
    assert.equal(report.passed, false);
    assert.equal(downloads.length, 2);
    assert.equal(report.checks.find(row => row.check === 'admin_pending_pdf')?.reason, 'invalid_capability_url');
  }
});

test('PDF smoke fails unsafe cache headers, unequal derivatives and incorrectly configured case fixtures', async () => {
  for (const overrides of [{ unsafePdf: true }, { mismatchedDerivative: true }, { wrongHistory: true }]) {
    const { transport, downloads } = fixture(overrides);
    const report = await runVerificationPdfSmoke(config, transport);
    assert.equal(report.passed, false);
    if (overrides.wrongHistory) {
      assert.equal(downloads.length, 0);
      assert.equal(report.checks.length, 1);
    } else {
      assert.equal(report.checks.find(row => row.check === 'pending_pdf_derivatives_match')?.passed, false);
    }
  }
  assert.throws(() => verificationPdfSmokeConfig({ ...env, STAGELINK_SMOKE_ORIGIN: 'http://localhost' }, credentials));
  assert.throws(() => verificationPdfSmokeConfig(env, { ...credentials, outsider: credentials.owner }));
  assert.throws(() => verificationPdfSmokeConfig({ ...env, STAGELINK_SMOKE_CLOSED_PDF_ASSET_ID: pending }, credentials));
});
