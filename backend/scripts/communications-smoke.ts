import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { communicationState, smtpCheckResult } from '../shared/communications.js';
const httpsOrigin = z.url({ protocol: /^https$/ }).refine(raw => raw === new URL(raw).origin || raw === new URL(raw).origin + '/').transform(raw => new URL(raw).origin);
const token = z.string().max(4096).regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
export const communicationsSmokeSettings = z.object({ origin: httpsOrigin, webOrigin: httpsOrigin, session: z.object({ accessToken: token, csrfToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict() });
const ready = z.object({ status: z.literal('ready'), dependencies: z.object({ postgres: z.literal('up'), redis: z.literal('up') }) });
const n = z.number().int().nonnegative();
const emailQueue = z.object({ enabled: z.boolean(), counts: z.object({ queued: n, sending: n, accepted: n, failed: n, unknown: n, cancelled: n }) });
const smsQueue = z.object({ enabled: z.boolean(), counts: z.object({ queued: n, sending: n, accepted: n, delivered: n, failed: n, unknown: n, cancelled: n }) });
type Check = {
    check: string;
    passed: boolean;
    status?: number;
};
export async function runCommunicationsSmoke(raw: z.input<typeof communicationsSmokeSettings>, send = fetch) {
    const config = communicationsSmokeSettings.parse(raw), checks: Check[] = [];
    const report = { passed: false, checks, messageSent: false as const, smsDeliveryVerified: false as const, channels: null as {
            emailRemindersEnabled: boolean;
            smsRemindersEnabled: boolean;
            smsProviderConfigured: boolean;
        } | null };
    async function request<T>(path: string, shape: z.ZodType<T>, post = false) {
        let status: number | undefined;
        try {
            const response = await send(new URL(path, config.origin), { redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15000), headers: { Authorization: 'Bearer ' + config.session.accessToken, ...(post ? { Origin: config.webOrigin, 'Content-Type': 'application/json', 'X-CSRF-Token': config.session.csrfToken } : {}) }, ...(post ? { method: 'POST', body: '{}' } : {}) });
            status = response.status;
            if (status !== 200) {
                await response.body?.cancel();
                return { status, data: null };
            }
            return { status, data: shape.parse(await response.json()) };
        }
        catch {
            return { status, data: null };
        }
    }
    const health = await request('/api/v1/health/ready', ready);
    checks.push({ check: 'backend_ready', passed: health.data !== null, status: health.status });
    if (!health.data)
        return report;
    const state = await request('/api/v1/admin/communications', communicationState);
    checks.push({ check: 'communication_settings', passed: state.data !== null, status: state.status });
    if (!state.data)
        return report;
    report.channels = { emailRemindersEnabled: state.data.email.bookingRemindersEnabled, smsRemindersEnabled: state.data.sms.bookingRemindersEnabled, smsProviderConfigured: state.data.sms.providerConfigured };
    const smtp = await request('/api/v1/admin/communications/smtp-check', smtpCheckResult, true);
    checks.push({ check: 'smtp_connection', passed: smtp.data?.connection === 'ready', status: smtp.status });
    checks.push({ check: 'smtp_transport_security', passed: !!smtp.data && smtp.data.security !== 'development' && smtp.data.security === state.data.email.security, status: smtp.status });
    const email = await request('/api/v1/admin/reminders', emailQueue);
    checks.push({ check: 'email_queue_read', passed: !!email.data && email.data.enabled === state.data.email.bookingRemindersEnabled, status: email.status });
    const sms = await request('/api/v1/admin/sms-reminders', smsQueue);
    checks.push({ check: 'sms_queue_read', passed: !!sms.data && sms.data.enabled === state.data.sms.bookingRemindersEnabled, status: sms.status });
    report.passed = checks.every(row => row.passed);
    return report;
}
if (import.meta.main) {
    async function main() {
        const session: unknown = process.stdin.isTTY ? null : JSON.parse(readFileSync(0, 'utf8'));
        const config = communicationsSmokeSettings.parse({ origin: process.env.STAGELINK_SMOKE_ORIGIN, webOrigin: process.env.STAGELINK_SMOKE_WEB_ORIGIN, session });
        const report = await runCommunicationsSmoke(config);
        console.log(JSON.stringify(report, null, 2));
        if (!report.passed)
            process.exitCode = 1;
    }
    main().catch(() => { console.error('Set the staging API and web HTTPS origins, then pipe a recently signed-in administrator access/CSRF session through protected stdin.'); process.exitCode = 1; });
}
