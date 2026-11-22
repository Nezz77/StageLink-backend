import {z} from 'zod';
import type {Config} from '../config.js';
const reason=z.enum(['GATEWAY_NOT_CONFIGURED','EMAIL_VERIFICATION_REQUIRED','CUSTOMER_MEMBERSHIP_REQUIRED']);
export const paymentCapabilityView=z.object({
 checkedAt:z.iso.datetime(),environment:z.literal('sandbox'),currency:z.literal('LKR'),liveMoneyMovementEnabled:z.literal(false),merchantEligibilityChecked:z.literal(false),bookingEligibilityChecked:z.literal(false),
 account:z.object({customerMembership:z.boolean(),emailVerified:z.boolean()}),
 checkout:z.object({requiresEligiblePaymentOrder:z.literal(true),gateways:z.array(z.object({gateway:z.enum(['stripe','payhere']),mode:z.enum(['test','sandbox']),configured:z.boolean(),availableToAccount:z.boolean(),unavailableReasons:z.array(reason)}))}),
 adminExecution:z.object({stripeTestRefundsEnabled:z.boolean(),stripeTestTransfersEnabled:z.boolean(),payhereFullSandboxRefundsEnabled:z.boolean(),payherePartialSandboxRefundsEnabled:z.literal(false),payhereProviderPayoutsEnabled:z.literal(false),manualBankPayoutsEnabled:z.literal(false),productionDocumentsEnabled:z.literal(false),liveFinancialTotalsEnabled:z.literal(false)}).nullable(),
});
type Account={customerMembership:boolean;emailVerified:boolean;adminViewer:boolean};
export function paymentCapabilities(config:Config,account:Account){
 const stripe=Boolean(config.STRIPE_TEST_SECRET_KEY&&config.STRIPE_TEST_WEBHOOK_SECRET);
 const payhere=Boolean(config.PAYHERE_SANDBOX_MERCHANT_ID&&config.PAYHERE_SANDBOX_MERCHANT_SECRET&&config.PAYHERE_SANDBOX_NOTIFY_URL);
 function gateway(gateway:'stripe'|'payhere',configured:boolean){
  const unavailableReasons:z.infer<typeof reason>[]=[];
  if(!configured)unavailableReasons.push('GATEWAY_NOT_CONFIGURED');
  if(!account.emailVerified)unavailableReasons.push('EMAIL_VERIFICATION_REQUIRED');
  if(!account.customerMembership)unavailableReasons.push('CUSTOMER_MEMBERSHIP_REQUIRED');
  return{gateway,mode:gateway==='stripe'?'test' as const:'sandbox' as const,configured,availableToAccount:unavailableReasons.length===0,unavailableReasons};
 }
 return{environment:'sandbox' as const,currency:'LKR' as const,liveMoneyMovementEnabled:false as const,merchantEligibilityChecked:false as const,bookingEligibilityChecked:false as const,
  account:{customerMembership:account.customerMembership,emailVerified:account.emailVerified},
  checkout:{requiresEligiblePaymentOrder:true as const,gateways:[gateway('stripe',stripe),gateway('payhere',payhere)]},
  adminExecution:account.adminViewer?{
   stripeTestRefundsEnabled:config.STRIPE_TEST_REFUND_EXECUTION==='true'&&stripe,
   stripeTestTransfersEnabled:config.STRIPE_TEST_PAYOUT_TRANSFERS==='true'&&stripe,
   payhereFullSandboxRefundsEnabled:config.PAYHERE_SANDBOX_REFUND_EXECUTION==='true'&&Boolean(config.PAYHERE_SANDBOX_RETRIEVAL_APP_ID&&config.PAYHERE_SANDBOX_RETRIEVAL_APP_SECRET),
   payherePartialSandboxRefundsEnabled:false as const,payhereProviderPayoutsEnabled:false as const,manualBankPayoutsEnabled:false as const,productionDocumentsEnabled:false as const,liveFinancialTotalsEnabled:false as const,
  }:null};
}
