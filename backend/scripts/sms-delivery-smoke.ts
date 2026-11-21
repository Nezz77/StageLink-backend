import { readFileSync } from 'node:fs';
import { z } from 'zod';

const httpsOrigin = z.url({ protocol: /^https$/ }).refine(raw => {
  const { origin } = new URL(raw);
  return raw === origin || raw === origin + '/';
}).transform(raw => new URL(raw).origin);
const uuid = z.uuid().transform(value => value.toLowerCase());
const token = z.string().max(2048).regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
const count = z.number().int().nonnegative();
const settings = z.object({
  origin: httpsOrigin,
  verificationId: uuid,
  reminderId: uuid,
  campaignId: uuid,
  expectedRecipients: z.string().regex(/^\d{1,3}$/).transform(Number).pipe(count.min(1).max(100)),
  sessions: z.object({ member: token, admin: token }).strict().refine(({ member, admin }) => member !== admin),
});
const verificationHistory = z.object({ items: z.array(z.object({
  id: uuid, status: z.string(), confirmedAt: z.iso.datetime().nullable(),
})).max(20) });
const reminderHistory = z.object({ items: z.array(z.object({
  id: uuid, status: z.string(), checkedAt: z.iso.datetime().nullable(),
})).max(20) });
const campaign = z.object({
  id: uuid,
  state: z.enum(['draft', 'scheduled', 'cancelled']),
  recipientCount: count,
  deliveryCounts: z.object({
    queued: count, sending: count, accepted: count, delivered: count, failed: count, unknown: count, skipped: count,
  }),
});
type Config = z.output<typeof settings>;
type Check = { check: string; passed: boolean; status?: number };

export async function runSmsDeliverySmoke(config: Config, send = fetch) {
  async function check<T>(name: string, path: string, actor: string, schema: z.ZodType<T>, matches: (data: T) => boolean): Promise<Check> {
    let status: number | undefined;
    try {
      const response = await send(new URL('/api/v1/' + path, config.origin), {
        method: 'GET', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15_000),
        headers: { Authorization: 'Bearer ' + actor },
      });
      status = response.status;
      if (status !== 200) {
        await response.body?.cancel();
        return { check: name, passed: false, status };
      }
      return { check: name, passed: matches(schema.parse(await response.json())), status };
    } catch {
      return { check: name, passed: false, status };
    }
  }

  const checks = await Promise.all([
    check('verification_delivered_and_confirmed', 'me/sms-verifications', config.sessions.member, verificationHistory,
      ({ items }) => items.some(row => row.id === config.verificationId && row.status === 'delivered' && row.confirmedAt !== null)),
    check('booking_reminder_delivered', 'me/booking-sms-reminders', config.sessions.member, reminderHistory,
      ({ items }) => items.some(row => row.id === config.reminderId && row.status === 'delivered' && row.checkedAt !== null)),
    check('campaign_audience_delivered', 'admin/sms-campaigns/' + config.campaignId, config.sessions.admin, campaign,
      ({ id, state, recipientCount, deliveryCounts }) => {
        const { delivered, ...others } = deliveryCounts;
        return id === config.campaignId && state === 'scheduled' && recipientCount === config.expectedRecipients &&
          delivered === recipientCount && Object.values(others).every(value => value === 0);
      }),
  ]);
  return { passed: checks.every(row => row.passed), checks };
}

if (import.meta.main) {
  async function main() {
    const sessions: unknown = process.stdin.isTTY ? null : JSON.parse(readFileSync(0, 'utf8'));
    const config = settings.parse({
      origin: process.env.STAGELINK_SMOKE_ORIGIN,
      verificationId: process.env.STAGELINK_SMOKE_SMS_VERIFICATION_ID,
      reminderId: process.env.STAGELINK_SMOKE_SMS_REMINDER_ID,
      campaignId: process.env.STAGELINK_SMOKE_SMS_CAMPAIGN_ID,
      expectedRecipients: process.env.STAGELINK_SMOKE_SMS_CAMPAIGN_RECIPIENTS,
      sessions,
    });
    const report = await runSmsDeliverySmoke(config);
    console.log(JSON.stringify(report, null, 2));
    if (!report.passed) process.exitCode = 1;
  }
  main().catch(() => {
    console.error('Set the staging HTTPS origin and SMS fixture settings, then pipe the member and administrator access tokens through protected stdin.');
    process.exitCode = 1;
  });
}
