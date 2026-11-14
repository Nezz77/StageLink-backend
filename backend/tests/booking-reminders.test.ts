import { test } from 'node:test';
import assert from 'node:assert/strict';
import { smtpFailureState } from '../shared/booking-reminders.js';

test('reminder timeouts and interrupted SMTP sends have an unknown outcome', () => {
  assert.equal(smtpFailureState({ code: 'ETIMEDOUT' }), 'unknown');
  assert.equal(smtpFailureState(new Error('connection closed')), 'unknown');
  assert.equal(smtpFailureState({ responseCode: 450 }), 'failed');
  assert.equal(smtpFailureState({ responseCode: 550 }), 'failed');
});
