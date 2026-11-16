import { z } from 'zod';

export const stripeAccountId = z.string().max(150).regex(/^acct_[A-Za-z0-9]+$/);
const country = z.string().regex(/^[A-Z]{2}$/);
const currency = z.string().regex(/^[a-z]{3}$/);
const account = z.object({
  object: z.literal('account'), id: stripeAccountId, country,
  charges_enabled: z.boolean(), payouts_enabled: z.boolean(),
  controller: z.object({ is_controller: z.boolean().optional() }).nullish(),
  capabilities: z.object({ transfers: z.string().max(30).optional() }).nullish(),
});
const countrySpec = z.object({
  object: z.literal('country_spec'), id: country,
  supported_payment_currencies: z.array(currency).max(300),
  supported_bank_account_currencies: z.record(currency, z.array(country).max(300)),
  supported_transfer_countries: z.array(country).max(300).optional(),
});
const balance = z.object({
  object: z.literal('balance'), livemode: z.literal(false),
  available: z.array(z.object({
    currency, amount: z.number().int(),
    source_types: z.object({ card: z.number().int().optional() }).nullish(),
  })).max(300),
});

export const stripeCapabilities = z.object({
  status: z.enum(['unconfigured', 'unavailable', 'checked']),
  platform: z.object({
    country, chargesEnabled: z.boolean(), lkrChargeCurrencyListed: z.boolean().nullable(),
    availableLkrMinor: z.string().regex(/^-?\d+$/).nullable(),
  }).nullable(),
  connectedAccount: z.object({
    id: stripeAccountId, country, platformControlsAccount: z.boolean().nullable(),
    transfersCapability: z.string().nullable(), payoutsEnabled: z.boolean(),
    lkrBankCurrencyListed: z.boolean().nullable(), destinationCountryListed: z.boolean().nullable(),
  }).nullable(),
});

function stripeRead(key: string, send: typeof fetch) {
  return async function read<T>(path: string, schema: z.ZodType<T>) {
    try {
      const response = await send('https://api.stripe.com/v1/' + path, {
        method: 'GET', redirect: 'error', signal: AbortSignal.timeout(4000), headers: { Authorization: 'Bearer ' + key },
      });
      if (!response.ok) return null;
      const parsed = schema.safeParse(await response.json());
      return parsed.success ? parsed.data : null;
    } catch { return null; }
  };
}

export async function readStripeTestAccounts(key: string, destinationId?: string, send = fetch) {
  if (!key.startsWith('sk_test_') || (destinationId !== undefined && !stripeAccountId.safeParse(destinationId).success)) return null;
  const read = stripeRead(key, send);
  const [platform, funds, candidate] = await Promise.all([
    read('account', account), read('balance', balance),
    destinationId ? read('accounts/' + destinationId, account) : null,
  ]);
  if (!platform || !funds) return null;
  const destination = candidate && candidate.id === destinationId && candidate.id !== platform.id ? candidate : null;
  return { platform, funds, destination };
}

export async function readStripeTestPlatform(key: string, send = fetch) {
  return key.startsWith('sk_test_') ? stripeRead(key, send)('account', account) : null;
}

export async function verifyStripeTestDestination(key: string | undefined, accountId: string, send = fetch) {
  if (!key?.startsWith('sk_test_') || !stripeAccountId.safeParse(accountId).success) return null;
  const evidence = await readStripeTestAccounts(key, accountId, send);
  if (!evidence || evidence.destination?.controller?.is_controller !== true) return null;
  return { platformAccountId: evidence.platform.id, stripeAccountId: evidence.destination.id, accountCountry: evidence.destination.country };
}

export async function checkStripeCapabilities(key: string | undefined, destinationId?: string, send = fetch) {
  const empty = { platform: null, connectedAccount: null };
  if (!key?.startsWith('sk_test_')) return { status: 'unconfigured' as const, ...empty };
  if (destinationId !== undefined && !stripeAccountId.safeParse(destinationId).success) {
    return { status: 'unavailable' as const, ...empty };
  }

  const evidence = await readStripeTestAccounts(key, destinationId, send);
  if (!evidence) return { status: 'unavailable' as const, ...empty };
  const { platform, funds, destination } = evidence;
  const read = stripeRead(key, send);
  const platformCountry = read('country_specs/' + platform.country, countrySpec);
  const [origin, location] = await Promise.all([
    platformCountry,
    destination ? destination.country === platform.country ? platformCountry : read('country_specs/' + destination.country, countrySpec) : null,
  ]);
  const originSpec = origin?.id === platform.country ? origin : null;
  const destinationSpec = location?.id === destination?.country ? location : null;
  return {
    status: 'checked' as const,
    platform: {
      country: platform.country, chargesEnabled: platform.charges_enabled,
      lkrChargeCurrencyListed: originSpec?.supported_payment_currencies.includes('lkr') ?? null,
      availableLkrMinor: funds.available.find(row => row.currency === 'lkr')?.amount.toString() ?? null,
    },
    connectedAccount: destination ? {
      id: destination.id, country: destination.country,
      platformControlsAccount: destination.controller?.is_controller ?? null,
      transfersCapability: destination.capabilities?.transfers ?? null,
      payoutsEnabled: destination.payouts_enabled,
      lkrBankCurrencyListed: destinationSpec ? Boolean(destinationSpec.supported_bank_account_currencies.lkr?.length) : null,
      destinationCountryListed: originSpec?.supported_transfer_countries?.includes(destination.country) ?? null,
    } : null,
  };
}
