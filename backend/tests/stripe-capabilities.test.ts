import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkStripeCapabilities } from '../shared/payments/stripe-capabilities.js';

const platform = { object: 'account', country: 'US', id: 'acct_platform', charges_enabled: true, payouts_enabled: true };
const connected = {
  object: 'account', country: 'LK', id: 'acct_provider', charges_enabled: false, payouts_enabled: false,
  controller: { is_controller: true }, capabilities: { transfers: 'pending' }, email: 'private@example.test',
};
const spec = { object: 'country_spec', supported_payment_currencies: ['lkr'], supported_bank_account_currencies: {} };

test('Stripe capability evidence keeps payment currencies, balances and payout settings distinct', async () => {
  const replies: Record<string, unknown> = {
    '/v1/account': platform,
    '/v1/accounts/acct_provider': connected,
    '/v1/balance': { livemode: false, object: 'balance', available: [{ currency: 'usd', amount: 500 }] },
    '/v1/country_specs/US': { ...spec, id: 'US', supported_transfer_countries: ['US', 'LK'] },
    '/v1/country_specs/LK': { ...spec, id: 'LK', supported_bank_account_currencies: { lkr: ['LK'] } },
  };
  const report = await checkStripeCapabilities('sk_test_fixture', 'acct_provider', async (url, init) => {
    const request = new Request(url, init);
    assert.equal(new URL(request.url).origin, 'https://api.stripe.com');
    assert.equal(request.method, 'GET');
    assert.equal(request.headers.get('authorization'), 'Bearer sk_test_fixture');
    assert.ok(replies[new URL(request.url).pathname]);
    return Response.json(replies[new URL(request.url).pathname]);
  });
  assert.deepEqual(report, {
    status: 'checked',
    platform: { country: 'US', chargesEnabled: true, lkrChargeCurrencyListed: true, availableLkrMinor: null },
    connectedAccount: {
      id: 'acct_provider', country: 'LK', platformControlsAccount: true, transfersCapability: 'pending',
      payoutsEnabled: false, lkrBankCurrencyListed: true, destinationCountryListed: true,
    },
  });
});

test('Stripe capabilities require test-mode balance and an exact connected account response', async () => {
  assert.equal((await checkStripeCapabilities('sk_live_fixture', undefined, async () => assert.fail('No live request'))).status, 'unconfigured');
  const unavailable = await checkStripeCapabilities('sk_test_fixture', undefined, async url => Response.json(
    String(url).endsWith('/balance') ? { livemode: true, object: 'balance', available: [] } : platform,
  ));
  assert.equal(unavailable.status, 'unavailable');
  const mismatch = await checkStripeCapabilities('sk_test_fixture', 'acct_mismatch', async url => {
    if (String(url).endsWith('/balance')) {
      return Response.json({ livemode: false, object: 'balance', available: [{ currency: 'lkr', amount: 0 }] });
    }
    if (String(url).endsWith('/account')) return Response.json(platform);
    if (String(url).endsWith('/accounts/acct_mismatch')) return Response.json(connected);
    return new Response(null, { status: 404 });
  });
  assert.equal(mismatch.platform?.availableLkrMinor, '0');
  assert.equal(mismatch.platform?.lkrChargeCurrencyListed, null);
  assert.equal(mismatch.connectedAccount, null);
});
