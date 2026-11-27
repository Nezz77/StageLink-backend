import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { providerStatus } from '../shared/payments/reconciliation.js';
import { stripeBankPayoutEvidence, stripeBankPayoutId } from '../shared/payments/stripe-bank-payouts.js';
import { stripeAccountId, stripeCapabilities } from '../shared/payments/stripe-capabilities.js';

const httpsOrigin = z.url({ protocol: /^https$/ }).refine(raw => {
  const { origin } = new URL(raw);
  return raw === origin || raw === origin + '/';
});
const settings = z.object({
  STAGELINK_SMOKE_ORIGIN: httpsOrigin,
  STAGELINK_SMOKE_STRIPE_ORDER_ID: z.uuid(),
  STAGELINK_SMOKE_PAYHERE_ORDER_ID: z.uuid(),
  STAGELINK_SMOKE_STRIPE_ACCOUNT_ID: stripeAccountId,
  STAGELINK_SMOKE_RECOVERY_ORDER_ID: z.uuid().optional(),
  STAGELINK_SMOKE_PAYHERE_REFUND_EXECUTION_ID: z.uuid().optional(),
  STAGELINK_SMOKE_PAYHERE_REFUND_AMOUNT_MINOR: z.string().regex(/^[1-9][0-9]{0,9}$/)
    .transform(Number).pipe(z.number().int().positive().max(2_147_483_647)).optional(),
  STAGELINK_SMOKE_STRIPE_PAYOUT_ORDER_ID: z.uuid().optional(),
  STAGELINK_SMOKE_STRIPE_BANK_PAYOUT_ID: stripeBankPayoutId.optional(),
});
const bearer = z.string().max(4096).regex(/^[\w-]+\.[\w-]+\.[\w-]+$/);
const ready = z.object({
  status: z.literal('ready'), dependencies: z.object({ postgres: z.literal('up'), redis: z.literal('up') }),
  schemaVersion: z.string().min(1),
});
const paymentGateway = z.enum(['stripe', 'payhere']);
const reconciliation = z.object({
  orderId: z.uuid(), gateway: paymentGateway.nullable(),
  localStatus: z.enum(['open', 'pending', 'failed', 'cancelled', 'paid', 'review']), localCaptureRecorded: z.boolean(),
  providerStatus, assessment: z.enum(['consistent', 'needs_review', 'inconclusive']), checkedAt: z.iso.datetime(),
});
const recoveries = z.object({ items: z.array(z.object({
  orderId: z.uuid(), gateway: paymentGateway, outcome: z.enum(['captured', 'expired']),
  journalId: z.uuid().nullable(), observedAt: z.iso.datetime(),
})).max(20) });
const payHereRefundAudit = z.object({ recovery: z.object({
  executionId: z.uuid(), amountMinor: z.number().int().positive(), journalId: z.uuid(), observedAt: z.iso.datetime(),
}).nullable() });
const bankPayoutCheck = stripeBankPayoutEvidence.extend({ transferId: z.uuid(), bankPayoutId: stripeBankPayoutId });
const bankSettlements = z.object({ settlements: z.array(z.object({
  transferId: z.uuid(), bankPayoutId: stripeBankPayoutId, balanceTransactionId: z.string().nullable(),
  state: z.enum(['settled', 'review_required']), journalId: z.uuid().nullable(), reversalJournalId: z.uuid().nullable(),
})).max(20) });

type Gateway = z.infer<typeof paymentGateway>;
type ReadFailure = { failure: 'http_error'; httpStatus: number } | { failure: 'invalid_response' | 'request_failed' };
type ReadResult<T> = { value: T } | ReadFailure;
type Check = { check: string } & (
  { status: 'pass' | 'review'; evidence?: Record<string, string | boolean | null> } |
  ({ status: 'unavailable' } & ReadFailure)
);

class SmokeConfigError extends Error {}

export function paymentSmokeConfig(env: NodeJS.ProcessEnv, token: string) {
  const result = settings.safeParse(env);
  if (!result.success) {
    const fields = [...new Set(result.error.issues.map(issue => String(issue.path[0])))];
    throw new SmokeConfigError('Check payment smoke settings: ' + fields.join(', '));
  }
  const access = bearer.safeParse(token.trim());
  if (!access.success) throw new SmokeConfigError('Supply a StageLink administrator access token through stdin.');
  const {
    STAGELINK_SMOKE_ORIGIN: origin, STAGELINK_SMOKE_STRIPE_ORDER_ID: stripeOrder,
    STAGELINK_SMOKE_PAYHERE_ORDER_ID: payHereOrder, STAGELINK_SMOKE_STRIPE_ACCOUNT_ID: connectedAccountId,
    STAGELINK_SMOKE_RECOVERY_ORDER_ID: recoveryOrder,
    STAGELINK_SMOKE_PAYHERE_REFUND_EXECUTION_ID: refundExecutionId, STAGELINK_SMOKE_PAYHERE_REFUND_AMOUNT_MINOR: refundAmount,
    STAGELINK_SMOKE_STRIPE_PAYOUT_ORDER_ID: payoutOrderId, STAGELINK_SMOKE_STRIPE_BANK_PAYOUT_ID: bankPayoutId,
  } = result.data;
  const orderIds = [stripeOrder, payHereOrder, ...(recoveryOrder ? [recoveryOrder] : [])].map(id => id.toLowerCase());
  if (new Set(orderIds).size !== orderIds.length) {
    throw new SmokeConfigError('Use distinct sandbox orders for the checkout and recovery fixtures.');
  }
  if (Boolean(refundExecutionId) !== Boolean(refundAmount)) {
    throw new SmokeConfigError('Supply both the PayHere refund execution ID and the expected refund amount in minor units.');
  }
  if (Boolean(payoutOrderId) !== Boolean(bankPayoutId)) {
    throw new SmokeConfigError('Supply both the StageLink payout order ID and the Stripe bank payout ID.');
  }
  return {
    origin: new URL(origin).origin, token: access.data, connectedAccountId,
    stripeOrder: stripeOrder.toLowerCase(), payHereOrder: payHereOrder.toLowerCase(), recoveryOrder: recoveryOrder?.toLowerCase(),
    payHereRefund: refundExecutionId && refundAmount ? { executionId: refundExecutionId.toLowerCase(), amountMinor: refundAmount } : undefined,
    stripeBankPayout: payoutOrderId && bankPayoutId ? { payoutOrderId: payoutOrderId.toLowerCase(), bankPayoutId } : undefined,
  };
}

export async function runPaymentSmoke(config: ReturnType<typeof paymentSmokeConfig>, send = fetch) {
  async function read<T>(path: string, schema: z.ZodType<T>, authenticated = true): Promise<ReadResult<T>> {
    let response: Response;
    try {
      response = await send(new URL('/api/v1/' + path, config.origin), {
        method: 'GET', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(20_000),
        headers: { Accept: 'application/json', ...(authenticated ? { Authorization: 'Bearer ' + config.token } : {}) },
      });
    } catch { return { failure: 'request_failed' }; }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return { failure: 'http_error', httpStatus: response.status };
    }
    try {
      const parsed = schema.safeParse(await response.json());
      if (parsed.success) return { value: parsed.data };
    } catch { /* JSON and transport errors are reported without response content. */ }
    return { failure: 'invalid_response' };
  }

  const unavailable = (check: string, failure: ReadFailure): Check => ({ check, status: 'unavailable', ...failure });
  async function checkOrder(gateway: Gateway, orderId: string): Promise<Check> {
    const check = `${gateway}_capture_reconciliation`;
    const result = await read(`admin/payment-orders/${orderId}/reconciliation`, reconciliation);
    if ('failure' in result) return unavailable(check, result);
    const row = result.value;
    const matchesFixture = row.orderId === orderId && row.gateway === gateway;
    const passed = matchesFixture && row.localStatus === 'paid' && row.localCaptureRecorded &&
      row.providerStatus === 'captured' && row.assessment === 'consistent';
    return { check, status: passed ? 'pass' : 'review', evidence: {
      matchesFixture, localStatus: row.localStatus, localCaptureRecorded: row.localCaptureRecorded,
      providerStatus: row.providerStatus, assessment: row.assessment,
    } };
  }

  async function checkStripe(): Promise<Check> {
    const check = 'stripe_lkr_and_connect_evidence';
    const query = new URLSearchParams({ connectedAccountId: config.connectedAccountId });
    const result = await read('admin/payments/stripe-capabilities?' + query, stripeCapabilities.extend({ checkedAt: z.iso.datetime() }));
    if ('failure' in result) return unavailable(check, result);
    const { status, platform, connectedAccount } = result.value;
    const matchesAccount = connectedAccount?.id === config.connectedAccountId;
    const evidence = {
      providerStatus: status,
      matchesAccount,
      chargesEnabled: platform?.chargesEnabled ?? null,
      lkrChargeCurrencyListed: platform?.lkrChargeCurrencyListed ?? null,
      hasAvailableLkr: platform?.availableLkrMinor == null ? null : BigInt(platform.availableLkrMinor) > 0n,
      platformControlsAccount: connectedAccount?.platformControlsAccount ?? null,
      transfersActive: connectedAccount?.transfersCapability == null ? null : connectedAccount.transfersCapability === 'active',
      payoutsEnabled: connectedAccount?.payoutsEnabled ?? null,
      lkrBankCurrencyListed: connectedAccount?.lkrBankCurrencyListed ?? null,
      destinationCountryListed: connectedAccount?.destinationCountryListed ?? null,
    };
    const passed = status === 'checked' && matchesAccount && evidence.chargesEnabled === true &&
      evidence.lkrChargeCurrencyListed === true && evidence.platformControlsAccount === true &&
      evidence.transfersActive === true && evidence.payoutsEnabled === true &&
      evidence.lkrBankCurrencyListed === true && evidence.destinationCountryListed === true;
    return { check, status: passed ? 'pass' : 'review', evidence };
  }

  async function checkRecovery(orderId: string): Promise<Check> {
    const check = 'checkout_capture_recovery_audit';
    const result = await read(`admin/payment-orders/${orderId}/reconciliation/recoveries`, recoveries);
    if ('failure' in result) return unavailable(check, result);
    const recorded = result.value.items.some(row => row.orderId === orderId && row.outcome === 'captured' && row.journalId !== null);
    return { check, status: recorded ? 'pass' : 'review', evidence: { recorded } };
  }

  async function checkPayHereRefund(executionId: string, amountMinor: number): Promise<Check> {
    const check = 'payhere_refund_recovery_audit';
    const result = await read(`admin/payhere-refund-executions/${executionId}/recovery`, payHereRefundAudit);
    if ('failure' in result) return unavailable(check, result);
    const { recovery } = result.value;
    const matchesExecution = recovery?.executionId === executionId;
    const matchesAmount = recovery?.amountMinor === amountMinor;
    return {
      check, status: matchesExecution && matchesAmount ? 'pass' : 'review',
      evidence: { recoveryRecorded: recovery !== null, matchesExecution, matchesAmount },
    };
  }

  async function checkBankPayout(payoutOrderId: string, bankPayoutId: string): Promise<Check> {
    const check = 'stripe_bank_payout_settlement';
    const path = `admin/payouts/${payoutOrderId}/stripe-transfer`;
    const query = new URLSearchParams({ bankPayoutId });
    const current = await read(path + '/bank-payout?' + query, bankPayoutCheck);
    if ('failure' in current) return unavailable(check, current);
    const stored = await read(path + '/bank-settlements', bankSettlements);
    if ('failure' in stored) return unavailable(check, stored);
    const provider = current.value;
    const payoutMatches = provider.bankPayoutId === bankPayoutId;
    const included = payoutMatches && provider.status === 'included' && provider.stripePayoutStatus === 'paid' &&
      provider.balanceTransactionId !== null;
    const settlement = stored.value.settlements.find(row => row.transferId === provider.transferId && row.bankPayoutId === bankPayoutId);
    const journalRecorded = settlement?.state === 'settled' && settlement.journalId !== null && settlement.reversalJournalId === null;
    const matchesBalanceTransaction = included && settlement?.balanceTransactionId === provider.balanceTransactionId;
    return {
      check, status: journalRecorded && matchesBalanceTransaction ? 'pass' : 'review',
      evidence: {
        payoutMatches, providerStatus: provider.status, stripePayoutStatus: provider.stripePayoutStatus,
        settlementRecorded: settlement !== undefined, journalRecorded, matchesBalanceTransaction,
      },
    };
  }

  const readiness = await read('health/ready', ready, false);
  if ('failure' in readiness) return { passed: false, checks: [unavailable('api_readiness', readiness)] };
  const { payHereRefund, stripeBankPayout } = config;
  const checks: Check[] = [{ check: 'api_readiness', status: 'pass' }, ...await Promise.all([
    checkOrder('stripe', config.stripeOrder), checkOrder('payhere', config.payHereOrder), checkStripe(),
    ...(config.recoveryOrder ? [checkRecovery(config.recoveryOrder)] : []),
    ...(payHereRefund ? [checkPayHereRefund(payHereRefund.executionId, payHereRefund.amountMinor)] : []),
    ...(stripeBankPayout ? [checkBankPayout(stripeBankPayout.payoutOrderId, stripeBankPayout.bankPayoutId)] : []),
  ])];
  return { passed: checks.every(check => check.status === 'pass'), checks };
}

async function main() {
  if (process.stdin.isTTY) throw new SmokeConfigError('Provide the administrator access token through a protected stdin pipe.');
  const config = paymentSmokeConfig(process.env, readFileSync(0, 'utf8'));
  const report = await runPaymentSmoke(config);
  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) process.exitCode = 1;
}

if (import.meta.main) {
  main().catch(error => {
    console.error(error instanceof SmokeConfigError ? error.message : 'Payment smoke check could not run.');
    process.exitCode = 1;
  });
}
