import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {SignJWT} from 'jose';
import type {AuthRole} from '../generated/prisma/client.js';
import {createApp} from '../api/src/app.js';
import {readConfig} from '../shared/config.js';
import {resources} from '../shared/resources.js';
const config=readConfig({...process.env,AUTH_RATE_PREFIX:'payment-caps-'+randomUUID(),STRIPE_TEST_SECRET_KEY:'sk_test_fixture',STRIPE_TEST_WEBHOOK_SECRET:'whsec_fixture',STRIPE_TEST_REFUND_EXECUTION:'true',STRIPE_TEST_PAYOUT_TRANSFERS:'true',PAYHERE_SANDBOX_MERCHANT_ID:'1210000',PAYHERE_SANDBOX_MERCHANT_SECRET:'fixture-private-secret',PAYHERE_SANDBOX_NOTIFY_URL:'https://callback.stagelink.test/api/v1/payments/webhooks/payhere',PAYHERE_SANDBOX_RETRIEVAL_APP_ID:'fixture-app',PAYHERE_SANDBOX_RETRIEVAL_APP_SECRET:'fixture-refund-secret',PAYHERE_SANDBOX_REFUND_EXECUTION:'true'});
if(config.NODE_ENV!=='test'||!new URL(config.DATABASE_URL).pathname.endsWith('_test'))throw Error('Payment capability integration requires an isolated test database');

test('payment capability reads reflect configuration and account scope without gateway calls or money movement',async t=>{
 const deps=resources(config),{app}=await createApp(config,deps),users:string[]=[];let external=0;
 t.mock.method(globalThis,'fetch',((original)=>async(input:string|URL|Request,init?:RequestInit)=>{const url=new URL(input instanceof Request?input.url:input);if(!['127.0.0.1','localhost'].includes(url.hostname)){external++;throw Error('External payment requests forbidden in capability reads');}return original(input,init);})(globalThis.fetch));
 await app.listen(0,'127.0.0.1');const root=(await app.getUrl())+'/api/v1/payments/capabilities';
 async function actor(roles:AuthRole[],verified=true,activeRole:AuthRole=roles[0]!){const user=await deps.db.authUser.create({data:{email:randomUUID()+'@stagelink.test',displayName:'Payment capabilities fixture',passwordHash:'unused',roles,emailVerifiedAt:verified?new Date():null}});users.push(user.id);const session=await deps.db.authSession.create({data:{userId:user.id,activeRole,expiresAt:new Date(Date.now()+600000)}});const token=await new SignJWT({sid:session.id}).setProtectedHeader({alg:'HS256',typ:'JWT'}).setIssuer('stagelink-api').setAudience('stagelink-web').setSubject(user.id).setIssuedAt().setExpirationTime('10m').sign(Buffer.from(config.AUTH_JWT_SECRET,'hex'));return{id:user.id,sessionId:session.id,headers:{Authorization:'Bearer '+token}};}
 type Actor=Awaited<ReturnType<typeof actor>>;
 async function call(a?:Actor){const r=await fetch(root,{headers:a?.headers});return{status:r.status,data:await r.json() as any,cache:r.headers.get('Cache-Control')};}
 const before=await deps.db.paymentOrder.count();
 try{
  const customer=await actor(['customer']),provider=await actor(['artist']),unverified=await actor(['customer'],false),admin=await actor(['admin']),inactiveAdmin=await actor(['admin','customer'],true,'customer');
  assert.equal((await call()).status,401);
  const view=await call(customer);assert.equal(view.status,200);assert.equal(view.cache,'no-store');assert.equal(view.data.environment,'sandbox');assert.equal(view.data.liveMoneyMovementEnabled,false);assert.equal(view.data.merchantEligibilityChecked,false);assert.equal(view.data.bookingEligibilityChecked,false);assert.equal(view.data.checkout.requiresEligiblePaymentOrder,true);assert.equal(view.data.adminExecution,null);
  assert.ok(view.data.checkout.gateways.every((row:any)=>row.configured&&row.availableToAccount&&row.unavailableReasons.length===0));
  const needsVerification=await call(unverified);assert.equal(needsVerification.status,200);assert.ok(needsVerification.data.checkout.gateways.every((row:any)=>!row.availableToAccount&&row.unavailableReasons.includes('EMAIL_VERIFICATION_REQUIRED')));
  const providerView=await call(provider);assert.ok(providerView.data.checkout.gateways.every((row:any)=>!row.availableToAccount&&row.unavailableReasons.includes('CUSTOMER_MEMBERSHIP_REQUIRED')));assert.equal(providerView.data.adminExecution,null);
  const adminView=await call(admin);assert.equal(adminView.data.adminExecution.stripeTestRefundsEnabled,true);assert.equal(adminView.data.adminExecution.stripeTestTransfersEnabled,true);assert.equal(adminView.data.adminExecution.payhereFullSandboxRefundsEnabled,true);assert.equal(adminView.data.adminExecution.manualBankPayoutsEnabled,false);assert.equal(adminView.data.adminExecution.payherePartialSandboxRefundsEnabled,false);assert.equal(adminView.data.adminExecution.payhereProviderPayoutsEnabled,false);assert.equal(adminView.data.adminExecution.productionDocumentsEnabled,false);
  assert.equal((await call(inactiveAdmin)).data.adminExecution,null,'An inactive admin role does not expose execution controls');
  for(const raw of ['sk_test_fixture','whsec_fixture','1210000','fixture-private-secret','fixture-refund-secret','callback.stagelink.test'])assert.ok(!JSON.stringify(adminView.data).includes(raw));
  await deps.db.authUser.update({where:{id:provider.id},data:{disabledAt:new Date()}});assert.equal((await call(provider)).status,401);
  await deps.db.authSession.update({where:{id:customer.sessionId},data:{revokedAt:new Date()}});assert.equal((await call(customer)).status,401);
  assert.equal(external,0);assert.equal(await deps.db.paymentOrder.count(),before);
 }finally{try{await deps.db.authUser.deleteMany({where:{id:{in:users}}});assert.equal(await deps.db.authUser.count({where:{id:{in:users}}}),0);}finally{await app.close();}}
});
