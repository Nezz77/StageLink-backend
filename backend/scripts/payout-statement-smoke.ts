import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { documentNumber, documentSnapshot } from '../shared/booking-documents.js';
import { pdfBodyDigest } from './pdf-smoke-body.js';

const httpsOrigin = z.url({ protocol: /^https$/ }).refine(raw => {
  const { origin } = new URL(raw);
  return raw === origin || raw === origin + '/';
}).transform(raw => new URL(raw).origin);
const id = z.uuid().transform(value => value.toLowerCase());
const settings = z.object({
  STAGELINK_SMOKE_ORIGIN: httpsOrigin,
  STAGELINK_SMOKE_BOOKING_ID: id,
  STAGELINK_SMOKE_PAYOUT_SETTLEMENT_DOCUMENT_ID: id,
  STAGELINK_SMOKE_PAYOUT_REVERSAL_DOCUMENT_ID: id,
});
const token = z.string().max(4096).regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
const sessions = z.object({ admin: token, provider: token, customer: token }).strict();
const document = z.object({
  id, bookingId: id, number: z.string(), status: z.literal('ready'),
  currency: z.literal('LKR'), environment: z.literal('sandbox'), snapshot: documentSnapshot,
});

class SmokeConfigError extends Error {}

export function payoutStatementSmokeConfig(env: NodeJS.ProcessEnv, rawSessions: unknown) {
  const parsed = settings.safeParse(env);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map(issue => String(issue.path[0])))];
    throw new SmokeConfigError('Check payout statement smoke settings: ' + fields.join(', '));
  }
  const credentials = sessions.safeParse(rawSessions);
  if (!credentials.success || new Set(Object.values(credentials.data)).size !== 3) {
    throw new SmokeConfigError('Supply distinct administrator, provider and customer access tokens.');
  }
  const {
    STAGELINK_SMOKE_ORIGIN: origin, STAGELINK_SMOKE_BOOKING_ID: bookingId,
    STAGELINK_SMOKE_PAYOUT_SETTLEMENT_DOCUMENT_ID: settlementId,
    STAGELINK_SMOKE_PAYOUT_REVERSAL_DOCUMENT_ID: reversalId,
  } = parsed.data;
  if (settlementId === reversalId) throw new SmokeConfigError('Use distinct settlement and reversal documents.');
  return { origin, bookingId, settlementId, reversalId, ...credentials.data };
}

type Config = ReturnType<typeof payoutStatementSmokeConfig>;
type Check = { check: string; passed: boolean; status?: number };
const downloadLimit = 1024 * 1024;
const statementPath = (documentId: string) => '/api/v1/documents/' + documentId;

export async function runPayoutStatementSmoke(config: Config, send = fetch) {
  async function request(path: string, accessToken: string | undefined, accept: string) {
    try {
      return await send(new URL(path, config.origin), {
        method: 'GET', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(20_000),
        headers: { Accept: accept, ...(accessToken ? { Authorization: 'Bearer ' + accessToken } : {}) },
      });
    } catch { return null; }
  }

  async function readStatement(documentId: string) {
    const response = await request(statementPath(documentId), config.admin, 'application/json');
    if (response?.status !== 200) {
      await response?.body?.cancel().catch(() => undefined);
      return null;
    }
    try {
      const row = document.parse(await response.json());
      const { snapshot } = row;
      if (row.id === documentId && row.bookingId === config.bookingId && row.number === documentNumber('settlement', documentId) &&
        snapshot.kind === 'settlement' && snapshot.version === 3 && snapshot.damageClaimId === undefined &&
        snapshot.arbitrationId === undefined && snapshot.grossMinor === snapshot.platformFeeMinor + snapshot.netMinor) return snapshot;
    } catch { /* Report fixture failure without logging the response. */ }
    return null;
  }

  async function download(check: string, documentId: string, accessToken: string) {
    const response = await request(statementPath(documentId) + '/download', accessToken, 'application/pdf');
    const cache = response?.headers.get('Cache-Control')?.toLowerCase().split(',').map(part => part.trim());
    if (response?.status !== 200 || response.headers.get('Content-Type') !== 'application/pdf' ||
      response.headers.get('Content-Disposition') !== 'attachment; filename="' + documentNumber('settlement', documentId) + '.pdf"' ||
      !cache?.includes('private') || !cache.includes('no-store') || cache.includes('public')) {
      await response?.body?.cancel().catch(() => undefined);
      return { check: { check, passed: false, status: response?.status } };
    }
    const digest = await pdfBodyDigest(response, downloadLimit);
    return { check: { check, passed: digest !== null, status: 200 }, digest };
  }

  async function denial(check: string, documentId: string, accessToken: string | undefined, expected: number): Promise<Check> {
    const response = await request(statementPath(documentId) + '/download', accessToken, 'application/pdf');
    await response?.body?.cancel().catch(() => undefined);
    return { check, passed: response?.status === expected, status: response?.status };
  }

  const [settled, reversed] = await Promise.all([readStatement(config.settlementId), readStatement(config.reversalId)]);
  const original = settled?.manualSettlement;
  const reversal = reversed?.manualSettlement;
  if (!settled || !reversed || original?.state !== 'settled' || reversal?.state !== 'reversed' ||
    original.settlementId !== reversal.settlementId || original.journalId !== reversal.originalJournalId ||
    original.journalId === reversal.journalId || original.revision !== reversal.revision ||
    settled.destinationRevision !== reversed.destinationRevision || settled.grossMinor !== reversed.grossMinor ||
    settled.netMinor !== reversed.netMinor) {
    return { passed: false, checks: [{ check: 'linked_manual_statement_fixtures', passed: false }] };
  }

  const checks: Check[] = [{ check: 'linked_manual_statement_fixtures', passed: true }];
  const providerDigests = new Map<string, string>();
  for (const [kind, documentId] of [['settlement', config.settlementId], ['reversal', config.reversalId]] as const) {
    const [provider, admin, customer, anonymous] = await Promise.all([
      download('provider_' + kind, documentId, config.provider),
      download('admin_' + kind, documentId, config.admin),
      denial('customer_' + kind + '_denied', documentId, config.customer, 404),
      denial('anonymous_' + kind + '_denied', documentId, undefined, 401),
    ]);
    checks.push(provider.check, admin.check, {
      check: kind + '_pdf_matches', passed: provider.digest != null && provider.digest === admin.digest,
    }, customer, anonymous);
    if (provider.digest) providerDigests.set(kind, provider.digest);
  }
  checks.push({
    check: 'settlement_and_reversal_pdfs_differ',
    passed: providerDigests.size === 2 && providerDigests.get('settlement') !== providerDigests.get('reversal'),
  });
  return { passed: checks.every(row => row.passed), checks };
}

if (import.meta.main) {
  async function main() {
    if (process.stdin.isTTY) throw new SmokeConfigError('Supply the staging session JSON through a protected stdin pipe.');
    const config = payoutStatementSmokeConfig(process.env, JSON.parse(readFileSync(0, 'utf8')));
    const report = await runPayoutStatementSmoke(config);
    console.log(JSON.stringify(report, null, 2));
    if (!report.passed) process.exitCode = 1;
  }
  main().catch(error => {
    console.error(error instanceof SmokeConfigError ? error.message : 'Payout statement smoke check could not run. Check the protected session JSON.');
    process.exitCode = 1;
  });
}
