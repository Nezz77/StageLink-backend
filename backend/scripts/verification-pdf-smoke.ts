import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { pdfBodyDigest } from './pdf-smoke-body.js';

const httpsOrigin = z.url({ protocol: /^https$/ }).refine(raw => {
  const { origin } = new URL(raw);
  return raw === origin || raw === origin + '/';
}).transform(raw => new URL(raw).origin);
const assetId = z.uuid().transform(value => value.toLowerCase());
const settings = z.object({
  STAGELINK_SMOKE_ORIGIN: httpsOrigin,
  STAGELINK_SMOKE_WEB_ORIGIN: httpsOrigin,
  STAGELINK_SMOKE_PENDING_PDF_ASSET_ID: assetId,
  STAGELINK_SMOKE_CLOSED_PDF_ASSET_ID: assetId,
});
const jwt = z.string().max(4096).regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
const account = z.object({ accessToken: jwt, csrfToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict();
const sessions = z.object({ owner: account, admin: account, outsider: account }).strict();
const casePage = z.object({ items: z.array(z.object({
  status: z.enum(['pending', 'approved', 'rejected']),
  documents: z.array(z.object({ assetId, mime: z.string() })).max(5),
})).max(30) });
const capability = z.object({ url: z.string().max(2300), expiresIn: z.literal(60) });
const limit = 9 * 1024 * 1024;

class SmokeConfigError extends Error {}
export function verificationPdfSmokeConfig(env: NodeJS.ProcessEnv, rawSessions: unknown) {
  const parsed = settings.safeParse(env);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map(issue => String(issue.path[0])))];
    throw new SmokeConfigError('Check PDF smoke settings: ' + fields.join(', '));
  }
  const credentials = sessions.safeParse(rawSessions);
  if (!credentials.success || new Set(Object.values(credentials.data).map(row => row.accessToken)).size !== 3) {
    throw new SmokeConfigError('Supply distinct owner, administrator and outsider sessions with matching CSRF tokens.');
  }
  const {
    STAGELINK_SMOKE_ORIGIN: origin, STAGELINK_SMOKE_WEB_ORIGIN: webOrigin,
    STAGELINK_SMOKE_PENDING_PDF_ASSET_ID: pending, STAGELINK_SMOKE_CLOSED_PDF_ASSET_ID: closed,
  } = parsed.data;
  if (pending === closed) throw new SmokeConfigError('Use different pending and closed verification PDF fixtures.');
  return { origin, webOrigin, pending, closed, ...credentials.data };
}

type Check = { check: string; passed: boolean; status?: number; reason?: string };
type PdfResult = { check: Check; digest?: string };
type Config = ReturnType<typeof verificationPdfSmokeConfig>;

const mediaPath = (id: string) => `/api/v1/media/content/${id}`;
const authorization = (actor: z.infer<typeof account>) => ({ Authorization: 'Bearer ' + actor.accessToken });

function contentUrl(raw: string, origin: string, id: string) {
  const path = mediaPath(id);
  if (!raw.startsWith(path + '?')) return null;
  const url = new URL(raw, origin);
  return url.origin === origin && url.pathname === path && !url.hash && url.searchParams.size === 1 &&
    jwt.safeParse(url.searchParams.get('token')).success ? url : null;
}

async function pdfDigest(response: Response) {
  const cacheDirectives = response.headers.get('Cache-Control')?.split(',').map(part => part.trim().toLowerCase());
  if (response.headers.get('Content-Type') !== 'application/pdf' ||
    response.headers.get('Content-Disposition') !== 'attachment; filename="verification-evidence.pdf"' ||
    response.headers.get('X-Content-Type-Options') !== 'nosniff' || response.headers.get('Referrer-Policy') !== 'no-referrer' ||
    !cacheDirectives?.includes('no-store')) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  return pdfBodyDigest(response, limit);
}

export async function runVerificationPdfSmoke(config: Config, send = fetch) {
  async function request(path: string | URL, init?: RequestInit) {
    try {
      return await send(new URL(path, config.origin), {
        ...init, cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(20_000),
      });
    } catch { return null; }
  }

  async function json<T>(response: Response | null, schema: z.ZodType<T>) {
    if (response?.status !== 200) {
      await response?.body?.cancel().catch(() => undefined);
      return null;
    }
    try { return schema.parse(await response.json()); } catch { return null; }
  }

  function permit(id: string, actor?: z.infer<typeof account>) {
    return request(`/api/v1/assets/${id}/access`, { method: 'POST',
      headers: { Origin: config.webOrigin, 'Content-Type': 'application/json',
        ...(actor ? { ...authorization(actor), 'X-CSRF-Token': actor.csrfToken } : {}) },
      body: JSON.stringify({ variant: 'display' }),
    });
  }

  async function download(check: string, id: string, actor: z.infer<typeof account>): Promise<PdfResult> {
    const permitResponse = await permit(id, actor);
    const grant = await json(permitResponse, capability);
    if (!grant) return { check: { check, passed: false, status: permitResponse?.status, reason: 'capability_unavailable' } };
    const url = contentUrl(grant.url, config.origin, id);
    if (!url) return { check: { check, passed: false, reason: 'invalid_capability_url' } };
    const response = await request(url);
    if (response?.status !== 200) {
      await response?.body?.cancel().catch(() => undefined);
      return { check: { check, passed: false, status: response?.status, reason: 'pdf_unavailable' } };
    }
    const digest = await pdfDigest(response);
    return digest ? { check: { check, passed: true, status: 200 }, digest } :
      { check: { check, passed: false, status: 200, reason: 'invalid_pdf_or_private_headers' } };
  }

  async function denial(check: string, response: Promise<Response | null>, expected: number[]): Promise<Check> {
    const result = await response;
    await result?.body?.cancel().catch(() => undefined);
    return { check, passed: result !== null && expected.includes(result.status), status: result?.status };
  }

  const fixtureResponse = await request('/api/v1/me/verification', { headers: authorization(config.owner) });
  const fixtures = await json(fixtureResponse, casePage);
  const states = (id: string) => fixtures?.items.filter(row => row.documents.some(doc => doc.assetId === id && doc.mime === 'application/pdf'))
    .map(row => row.status) ?? [];
  const pending = states(config.pending);
  const closed = states(config.closed);
  if (!pending.includes('pending') || !closed.length || closed.includes('pending')) {
    return { passed: false, checks: [{ check: 'owner_case_fixtures', passed: false, status: fixtureResponse?.status, reason: 'fixture_status_mismatch' }] };
  }

  const [ownerPending, ownerClosed, adminPending, ...denials] = await Promise.all([
    download('owner_pending_pdf', config.pending, config.owner),
    download('owner_closed_pdf', config.closed, config.owner),
    download('admin_pending_pdf', config.pending, config.admin),
    denial('admin_closed_denied', permit(config.closed, config.admin), [404]),
    denial('outsider_pending_denied', permit(config.pending, config.outsider), [404]),
    denial('outsider_closed_denied', permit(config.closed, config.outsider), [404]),
    denial('anonymous_capability_denied', permit(config.pending), [401]),
    denial('unsigned_download_denied', request(mediaPath(config.pending)), [400, 401, 404]),
  ]);
  const sameDerivative = ownerPending.digest !== undefined && ownerPending.digest === adminPending.digest;
  const checks: Check[] = [
    { check: 'owner_case_fixtures', passed: true, status: 200 }, ownerPending.check, ownerClosed.check, adminPending.check,
    { check: 'pending_pdf_derivatives_match', passed: sameDerivative }, ...denials,
  ];
  return { passed: checks.every(row => row.passed), checks };
}

if (import.meta.main) {
  async function main() {
    if (process.stdin.isTTY) throw new SmokeConfigError('Supply the staging session JSON through a protected stdin pipe.');
    const config = verificationPdfSmokeConfig(process.env, JSON.parse(readFileSync(0, 'utf8')));
    const report = await runVerificationPdfSmoke(config);
    console.log(JSON.stringify(report, null, 2));
    if (!report.passed) process.exitCode = 1;
  }
  main().catch(error => {
    console.error(error instanceof SmokeConfigError ? error.message : 'PDF smoke check could not run. Check the protected session JSON.');
    process.exitCode = 1;
  });
}
