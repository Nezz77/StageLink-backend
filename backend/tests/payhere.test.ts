import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { checkoutHash, formatPayHereAmount, notificationStatus, payHereNotification, verifyNotification } from '../shared/payments/payhere.js';

const md5 = (value: string) => createHash('md5').update(value).digest('hex').toUpperCase();
const secret = 'fixture-only';
const fields = {
  merchant_id: '1210000', order_id: 'e4a51ba1-3863-44b9-ac18-19f036c75d09', payment_id: 'fixture-123',
  payhere_amount: '1750.01', payhere_currency: 'LKR' as const, status_code: '2' as const,
};

test('checkout uses fixed two-decimal LKR amounts and the documented PayHere hash', () => {
  assert.equal(formatPayHereAmount(175001), '1750.01');
  assert.equal(formatPayHereAmount(1), '0.01');
  assert.equal(checkoutHash(fields.merchant_id, fields.order_id, fields.payhere_amount, secret),
    md5(fields.merchant_id + fields.order_id + fields.payhere_amount + 'LKR' + md5(secret)));
});

test('callback verification rejects changes to signed fields and preserves the exact amount string', () => {
  const signature = md5(fields.merchant_id + fields.order_id + fields.payhere_amount + 'LKR2' + md5(secret));
  const event = payHereNotification.parse({ ...fields, md5sig: signature, card_no: 'masked-fixture' });
  assert.equal('card_no' in event, false);
  assert.equal(verifyNotification(event, fields.merchant_id, secret), true);
  assert.equal(verifyNotification({ ...event, payhere_amount: '1750.02' }, fields.merchant_id, secret), false);
  assert.equal(verifyNotification({ ...event, status_code: '-2' }, fields.merchant_id, secret), false);
  assert.equal(verifyNotification(event, '1210001', secret), false);
  assert.equal(payHereNotification.safeParse({ ...event, payhere_currency: 'USD' }).success, false);
});

test('late captures and chargebacks require review, and stale events preserve success', () => {
  assert.equal(notificationStatus('pending', '2', false), 'paid');
  assert.equal(notificationStatus('pending', '2', true), 'review');
  assert.equal(notificationStatus('failed', '2', false), 'review');
  assert.equal(notificationStatus('cancelled', '2', false), 'review');
  assert.equal(notificationStatus('paid', '-1', false), 'paid');
  assert.equal(notificationStatus('paid', '0', true), 'paid');
  assert.equal(notificationStatus('paid', '-3', true), 'review');
  assert.equal(notificationStatus('pending', '-2', false), 'failed');
});
