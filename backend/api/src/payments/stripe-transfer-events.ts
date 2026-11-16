import { z } from 'zod';
import { readStripeTestPlatform } from '../../../shared/payments/stripe-capabilities.js';
import { matchStripePayoutTransfer, retrieveStripePayoutTransfer, stripeTransferReference } from '../../../shared/payments/stripe-transfers.js';
import { stripeEvent } from '../../../shared/payments/stripe.js';
import type { Resources } from '../../../shared/resources.js';
import { PublicError } from '../auth/errors.js';
import { lockBooking } from '../bookings/lifecycle.js';
import { recordConfirmedStripeTransfer } from './stripe-transfer-settlement.js';

const platformTransferEvent = stripeEvent.extend({
  type: z.enum(['transfer.created', 'transfer.reversed']), account: z.null().optional(),
});

function mismatch() {
  return new PublicError(409, 'STRIPE_TRANSFER_MISMATCH', 'The Stripe event differs from the recorded transfer attempt.');
}

// The webhook controller verifies the signature before passing the event here.
export async function reconcileStripeTransferEvent(db: Resources['db'], key: string, body: unknown) {
  const parsed = platformTransferEvent.safeParse(body);
  if (!parsed.success) return;
  const event = parsed.data;
  const reference = stripeTransferReference.safeParse(event.data.object);
  if (!reference.success) return;
  const transferId = reference.data.metadata.stagelink_payout_transfer;
  const recorded = await db.stripePayoutTransferEvent.findUnique({ where: { id: event.id }, select: { id: true } });
  if (recorded) return;

  const attempt = await db.stripePayoutTransfer.findUnique({
    where: { id: transferId },
    include: { destination: true, payout: { select: { bookingId: true } } },
  });
  if (!attempt) return;
  const expected = { ...attempt, stripeAccountId: attempt.destination.stripeAccountId };
  const snapshot = matchStripePayoutTransfer(event.data.object, expected);
  if (!snapshot || (event.type === 'transfer.reversed' && snapshot.reversedMinor === 0)) throw mismatch();

  const [platform, observed] = await Promise.all([
    readStripeTestPlatform(key),
    retrieveStripePayoutTransfer(key, { ...expected, providerTransferId: snapshot.id }),
  ]);
  if (platform && platform.id !== attempt.destination.platformAccountId) throw mismatch();
  if (!platform || !observed || observed.reversedMinor < snapshot.reversedMinor) {
    throw new PublicError(503, 'STRIPE_TRANSFER_UNAVAILABLE', 'The transfer could not be verified with Stripe.');
  }

  await db.$transaction(async tx => {
    await lockBooking(tx, attempt.payout.bookingId);
    const current = await tx.stripePayoutTransfer.findUniqueOrThrow({ where: { id: transferId } });
    if (current.status === 'rejected' || (current.providerTransferId && current.providerTransferId !== observed.id)) throw mismatch();
    const receipt = await tx.stripePayoutTransferEvent.createMany({
      data: {
        id: event.id, transferId, eventType: event.type,
        observedReversedMinor: observed.reversedMinor, createdAt: new Date(event.created * 1000),
      }, skipDuplicates: true,
    });
    if (receipt.count) await recordConfirmedStripeTransfer(tx, current, observed);
  });
}
