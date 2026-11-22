import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readConfig} from '../shared/config.js';
import {paymentCapabilities} from '../shared/payments/capabilities.js';
const base={AUTH_JWT_SECRET:'01'.repeat(32),AUTH_MAIL_KEY:'02'.repeat(32),PAYOUT_DATA_KEY:'03'.repeat(32),DATABASE_URL:'postgresql://unused:unused@localhost/test',REDIS_URL:'redis://localhost:6379'};
const admin={customerMembership:true,emailVerified:true,adminViewer:true};
test('payment capabilities default to disabled sandbox routes without promoting unsupported live or bank features',()=>{
 const view=paymentCapabilities(readConfig(base),admin);
 assert.ok(view.checkout.gateways.every(row=>!row.configured&&!row.availableToAccount&&row.unavailableReasons.includes('GATEWAY_NOT_CONFIGURED')));
 assert.equal(view.liveMoneyMovementEnabled,false);assert.equal(view.merchantEligibilityChecked,false);assert.equal(view.bookingEligibilityChecked,false);
 assert.ok(Object.values(view.adminExecution!).every(value=>value===false));
});
test('payment capability configuration and account requirements remain separate from booking and merchant eligibility',()=>{
 const config=readConfig({...base,STRIPE_TEST_SECRET_KEY:'sk_test_fixture',STRIPE_TEST_WEBHOOK_SECRET:'whsec_fixture',STRIPE_TEST_REFUND_EXECUTION:'true',STRIPE_TEST_PAYOUT_TRANSFERS:'true',PAYHERE_SANDBOX_MERCHANT_ID:'1210000',PAYHERE_SANDBOX_MERCHANT_SECRET:'fixture-merchant-secret',PAYHERE_SANDBOX_NOTIFY_URL:'https://staging.example.test/api/v1/payments/webhooks/payhere'});
 const view=paymentCapabilities(config,admin);
 assert.ok(view.checkout.gateways.every(row=>row.configured&&row.availableToAccount));assert.equal(view.adminExecution!.stripeTestRefundsEnabled,true);assert.equal(view.adminExecution!.stripeTestTransfersEnabled,true);assert.equal(view.adminExecution!.payhereFullSandboxRefundsEnabled,false);
 const denied=paymentCapabilities(config,{customerMembership:false,emailVerified:false,adminViewer:false});assert.equal(denied.adminExecution,null);assert.ok(denied.checkout.gateways.every(row=>row.unavailableReasons.includes('EMAIL_VERIFICATION_REQUIRED')&&row.unavailableReasons.includes('CUSTOMER_MEMBERSHIP_REQUIRED')));
 assert.doesNotMatch(JSON.stringify(view),/sk_test_fixture|whsec_fixture|fixture-merchant-secret|staging.example.test/);
});
test('historical PayHere refund execution configuration does not require checkout credentials or enable partial refunds',()=>{
 const config=readConfig({...base,PAYHERE_SANDBOX_REFUND_EXECUTION:'true',PAYHERE_SANDBOX_RETRIEVAL_APP_ID:'fixture-app',PAYHERE_SANDBOX_RETRIEVAL_APP_SECRET:'fixture-secret'});
 const view=paymentCapabilities(config,admin);assert.equal(view.checkout.gateways.find(row=>row.gateway==='payhere')!.configured,false);assert.equal(view.adminExecution!.payhereFullSandboxRefundsEnabled,true);assert.equal(view.adminExecution!.payherePartialSandboxRefundsEnabled,false);
});
