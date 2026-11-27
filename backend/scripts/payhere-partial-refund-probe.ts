import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { makePayHereSandboxClient } from '../shared/payments/reconciliation.js';

const minor = z.string().regex(/^[1-9][0-9]{0,9}$/).transform(Number).pipe(z.number().int().max(2_147_483_647));
const settings = z.object({
  PAYHERE_SANDBOX_RETRIEVAL_APP_ID: z.string().trim().min(1),
  PAYHERE_SANDBOX_RETRIEVAL_APP_SECRET: z.string().trim().min(1),
  STAGELINK_PROBE_PAYHERE_ORDER_ID: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_:-]{0,127}$/),
  STAGELINK_PROBE_PAYHERE_PAYMENT_ID: z.string().regex(/^\d{1,120}$/),
  STAGELINK_PROBE_PAYHERE_CAPTURE_MINOR: minor,
  STAGELINK_PROBE_PAYHERE_REFUND_MINOR: minor,
});

class ProbeConfigError extends Error {}

export function payHerePartialRefundProbeConfig(env: NodeJS.ProcessEnv) {
  const result = settings.safeParse(env);
  if (!result.success) {
    const fields = [...new Set(result.error.issues.map(issue => String(issue.path[0])))];
    throw new ProbeConfigError('Check PayHere sandbox probe settings: ' + fields.join(', '));
  }
  const {
    PAYHERE_SANDBOX_RETRIEVAL_APP_ID: appId, PAYHERE_SANDBOX_RETRIEVAL_APP_SECRET: appSecret,
    STAGELINK_PROBE_PAYHERE_ORDER_ID: orderId, STAGELINK_PROBE_PAYHERE_PAYMENT_ID: paymentId,
    STAGELINK_PROBE_PAYHERE_CAPTURE_MINOR: captureMinor, STAGELINK_PROBE_PAYHERE_REFUND_MINOR: refundMinor,
  } = result.data;
  if (refundMinor >= captureMinor) throw new ProbeConfigError('Use a partial amount below the original sandbox capture.');
  return { appId, appSecret, orderId, paymentId, captureMinor, refundMinor };
}

export async function runPayHerePartialRefundProbe(
  config: ReturnType<typeof payHerePartialRefundProbeConfig>, mode: 'observe' | 'submit', send = fetch,
) {
  const client = makePayHereSandboxClient(config.appId, config.appSecret, send);
  const observation = await client.inspect({ id: config.orderId, amountMinor: config.captureMinor });
  const paymentMatches = observation.paymentReference === config.paymentId;
  const cardConfirmed = observation.payHereCardPayment === true;
  const evidence = {
    environment: 'sandbox', mode, paymentStatus: observation.status, paymentMatches, cardConfirmed,
    captureMinor: config.captureMinor, requestedRefundMinor: config.refundMinor,
    refundFields: paymentMatches ? observation.refundFields ?? [] : [],
  };
  if (!paymentMatches || !cardConfirmed || (mode === 'submit' && observation.status !== 'captured')) {
    return { ...evidence, passed: false, submission: null };
  }
  if (mode === 'observe') return { ...evidence, passed: true, submission: null };
  const submission = await client.refund(config.paymentId, randomUUID(), config.refundMinor);
  return { ...evidence, passed: submission.status === 'pending', submission };
}

if (import.meta.main) {
  async function main() {
    const args = process.argv.slice(2);
    if (args.length > 1 || (args.length === 1 && args[0] !== '--submit')) {
      throw new ProbeConfigError('Use the default observation mode or --submit for one sandbox partial refund request.');
    }
    const report = await runPayHerePartialRefundProbe(payHerePartialRefundProbeConfig(process.env), args.length ? 'submit' : 'observe');
    console.log(JSON.stringify(report, null, 2));
    if (!report.passed) process.exitCode = 1;
  }
  main().catch(error => {
    console.error(error instanceof ProbeConfigError ? error.message : 'PayHere sandbox partial refund probe failed.');
    process.exitCode = 1;
  });
}
