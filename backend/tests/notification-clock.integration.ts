import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import { createApp } from '../api/src/app.js';
import { csrfFor, seal, unseal } from '../api/src/auth/security.js';
import { readConfig } from '../shared/config.js';
import { resources } from '../shared/resources.js';
import { databaseNow } from '../shared/database-clock.js';
import { processBookingReminders } from '../shared/booking-reminders.js';
import { processBookingSmsReminders } from '../shared/booking-sms-reminders.js';
import { payloadContext, processSmsVerifications, sealSmsNumber } from '../shared/sms-verification.js';
import { smsDigest } from '../shared/sms.js';
import { serverClock } from './fixtures/server-clock.js';

const config = readConfig({ ...process.env, AUTH_RATE_PREFIX: 'notification-clock-'+randomUUID(), SMS_VERIFICATION_ENABLED:'true', BOOKING_SMS_REMINDERS:'true', BOOKING_EMAIL_REMINDERS:'true', TEXTLK_TOKEN:'fixture-token',TEXTLK_SENDER:'StageLink',SMS_HOURLY_LIMIT:'1000' });
if(config.NODE_ENV!=='test'||!new URL(config.DATABASE_URL).pathname.endsWith('_test'))throw Error('Notification clock checks require an isolated test database');
const ActualDate = Date;

test('booking reminders and verification use database time with fast/slow server clocks and lock waits',async()=>{
 const deps=resources(config),{app}=await createApp(config,deps),users:string[]=[],bookings:string[]=[];
 const number='94771234567',targetDigest=smsDigest(config,number);
 let smsSends=0,smsReads=0,emails=0,verificationSends=0,verificationReads=0;
 const transport={
   async send(){smsSends++;return {status:'accepted' as const,providerId:'clock-sms-'+randomUUID(),code:null};},
   async read(id:string){smsReads++;return {status:'delivered' as const,providerId:id,code:null};},
 };
 const verification={
   async send(){verificationSends++;return {status:'accepted' as const,providerId:'clock-otp-'+randomUUID(),code:null};},
   async read(id:string){verificationReads++;return {status:'delivered' as const,providerId:id,code:null};},
 };
 const mailer={async sendMail(){emails++;return {accepted:['fixture@stagelink.test'],rejected:[],response:'250 fixture accepted',envelope:{from:'noreply@stagelink.test',to:['fixture@stagelink.test']},messageId:'fixture-'+randomUUID(),envelopeTime:0,messageTime:0,messageSize:0};}};
 await app.listen(0,'127.0.0.1');const root=(await app.getUrl())+'/api/v1/';
 async function actor(){
  const user=await deps.db.authUser.create({data:{email:randomUUID()+'@stagelink.test',displayName:'Notification clock fixture',roles:['customer'],passwordHash:'unused',emailVerifiedAt:new ActualDate()}});users.push(user.id);
  const session=await deps.db.authSession.create({data:{userId:user.id,activeRole:'customer',expiresAt:new ActualDate(ActualDate.now()+48*3600000)}});
  return{id:user.id,sessionId:session.id};
 }
 type Actor=Awaited<ReturnType<typeof actor>>;
 async function call(a:Actor,path:string,body?:unknown){
  // JWT issue/validation share the simulated API clock; the notification deadline must not.
  const token=await new SignJWT({sid:a.sessionId}).setProtectedHeader({alg:'HS256',typ:'JWT'}).setIssuer('stagelink-api').setAudience('stagelink-web').setSubject(a.id).setIssuedAt().setExpirationTime('10m').sign(Buffer.from(config.AUTH_JWT_SECRET,'hex'));
  const response=await fetch(root+path,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+token,Origin:config.WEB_ORIGIN,'Content-Type':'application/json','X-CSRF-Token':csrfFor(config.AUTH_JWT_SECRET,a.sessionId)},...(body===undefined?{}:{body:JSON.stringify(body)})});
  return{status:response.status,data:await response.json() as any};
 }
 async function contact(a:Actor){await deps.db.smsContact.create({data:{userId:a.id,sealedNumber:sealSmsNumber(config,a.id,number),last4:'4567',verifiedAt:new ActualDate(),bookingConsent:true}});}
 async function booking(a:Actor,provider:Actor,hours:number){
  const startsAt=new ActualDate(ActualDate.now()+hours*3600000);
  const row=await deps.db.booking.create({data:{customerId:a.id,providerId:provider.id,requestKey:randomUUID(),requestDigest:'0'.repeat(64),targetKind:'gig',targetId:randomUUID(),targetVersion:1,snapshot:{},startsAt,endsAt:new ActualDate(startsAt.getTime()+3600000),holdExpiresAt:startsAt,agreedAt:new ActualDate()}});bookings.push(row.id);
  await deps.db.paymentOrder.create({data:{bookingId:row.id,purpose:'advance',amountMinor:150001,status:'paid'}});return row;
 }
 async function pending(a:Actor,expiresAt:Date,status:'queued'|'accepted'='queued'){
  const id=randomUUID(),code='123456';
  await deps.db.smsVerification.create({data:{id,userId:a.id,targetDigest,last4:'4567',codeDigest:smsDigest(config,id+':'+code),sealedPayload:seal(config.AUTH_MAIL_KEY,{number,message:'Code is '+code},payloadContext(id)),expiresAt,status,...(status==='accepted'?{sendingAt:new ActualDate(),providerId:'expired-'+id}: {})}});
  await deps.db.smsContact.upsert({where:{userId:a.id},create:{userId:a.id,pendingId:id},update:{pendingId:id}});return id;
 }
 try{
  const a=await actor(),provider=await actor();await contact(a);
  await deps.db.notificationPreference.create({data:{userId:provider.id,bookingReminderEmail:false}});
  for(const skew of [10*3600000,-10*3600000]){
   const due=await booking(a,provider,1),future=await booking(a,provider,26);
   const beforeSms=smsSends,beforeEmails=emails;
   await serverClock(skew,async()=>{await processBookingSmsReminders(deps.db,config,transport);await processBookingReminders(deps.db,config,mailer);});
   assert.equal(smsSends,beforeSms+1,'A due SMS must be claimed independently of host time');
   assert.equal(emails,beforeEmails+1,'A due email must be claimed independently of host time');
   const sms=await deps.db.bookingSmsReminder.findFirstOrThrow({where:{bookingId:due.id,offsetHours:2}});
   const email=await deps.db.bookingReminder.findFirstOrThrow({where:{bookingId:due.id,recipientId:a.id,offsetHours:2}});
   const realNow=await databaseNow(deps.db);
   assert.equal(sms.status,'accepted');assert.equal(email.status,'accepted');
   assert.ok(Math.abs(sms.sendingAt!.getTime()-realNow.getTime())<5000);
   assert.ok(Math.abs(sms.checkedAt!.getTime()-realNow.getTime())<5000);
   assert.ok(Math.abs(email.acceptedAt!.getTime()-realNow.getTime())<5000);
   assert.equal((await deps.db.bookingSmsReminder.findFirstOrThrow({where:{bookingId:future.id,offsetHours:24}})).status,'queued');
   assert.equal((await deps.db.bookingReminder.findFirstOrThrow({where:{bookingId:future.id,recipientId:a.id,offsetHours:24}})).status,'queued');
   // Recent claims survive a fast host clock; genuinely interrupted claims recover on a slow one.
   const sentAt=new ActualDate(ActualDate.now()-(skew>0?0:120000));
   await deps.db.bookingSmsReminder.update({where:{id:sms.id},data:{status:'sending',sendingAt:sentAt,providerId:null}});
   await deps.db.bookingReminder.update({where:{id:email.id},data:{status:'sending',sendingAt:sentAt,acceptedAt:null}});
   await serverClock(skew,async()=>{await processBookingSmsReminders(deps.db,{...config,BOOKING_SMS_REMINDERS:'false'},transport);await processBookingReminders(deps.db,{...config,BOOKING_EMAIL_REMINDERS:'false'},mailer);});
   assert.equal((await deps.db.bookingSmsReminder.findUniqueOrThrow({where:{id:sms.id}})).status,skew>0?'sending':'unknown');
   assert.equal((await deps.db.bookingReminder.findUniqueOrThrow({where:{id:email.id}})).status,skew>0?'sending':'unknown');
   // Mark these test-only claims terminal before processing the next fixture.
   await deps.db.bookingSmsReminder.update({where:{id:sms.id},data:{status:'failed'}});
   await deps.db.bookingReminder.update({where:{id:email.id},data:{status:'failed',sendingAt:null,acceptedAt:null}});
  }
  // No future reminder was submitted by either worker.
  assert.equal(smsSends,2);assert.equal(emails,2);
  const recent=await deps.db.bookingSmsReminder.findFirstOrThrow({where:{status:'queued',recipientId:a.id}});
  await deps.db.bookingSmsReminder.update({where:{id:recent.id},data:{status:'accepted',targetDigest,providerId:'reconcile-recent',sendingAt:new ActualDate(),checkedAt:new ActualDate(ActualDate.now()-60000)}});
  await serverClock(-10*3600000,()=>processBookingSmsReminders(deps.db,config,transport));
  assert.equal(smsReads,1,'A slow host must still reconcile a due receipt');
  assert.equal((await deps.db.bookingSmsReminder.findUniqueOrThrow({where:{id:recent.id}})).status,'delivered');

  const fast=await actor();
  const requested=await serverClock(10*3600000,()=>call(fast,'me/sms-contact/verification',{revision:0,number}));
  assert.equal(requested.status,200,JSON.stringify(requested.data));assert.ok(requested.data.pending);
  const otp=await deps.db.smsVerification.findUniqueOrThrow({where:{id:requested.data.pending.id}});
  assert.ok(Math.abs(otp.expiresAt.getTime()-(await databaseNow(deps.db)).getTime()-600000)<5000);
  await serverClock(10*3600000,()=>processSmsVerifications(deps.db,config,verification));
  assert.equal(verificationSends,1);
  const stored=await deps.db.smsVerification.findUniqueOrThrow({where:{id:otp.id}});
  const message=(unseal(config.AUTH_MAIL_KEY,stored.sealedPayload!,payloadContext(otp.id)) as {message:string}).message;
  const code=/code is (\d{6})/.exec(message)![1]!;
  const confirmed=await serverClock(10*3600000,()=>call(fast,'me/sms-contact/confirm',{challengeId:otp.id,code}));
  assert.equal(confirmed.status,200,JSON.stringify(confirmed.data));
  assert.ok(Math.abs(new ActualDate(confirmed.data.verifiedAt).getTime()-(await databaseNow(deps.db)).getTime())<5000);
  await deps.db.smsVerification.update({where:{id:otp.id},data:{checkedAt:new ActualDate(ActualDate.now()-60000)}});
  await serverClock(-10*3600000,()=>processSmsVerifications(deps.db,config,verification));
  assert.equal(verificationReads,1);
  assert.equal((await deps.db.smsVerification.findUniqueOrThrow({where:{id:otp.id}})).status,'delivered');
  const expired=await actor(),expiredId=await pending(expired,new ActualDate(ActualDate.now()-1000),'accepted');
  assert.equal((await serverClock(-10*3600000,()=>call(expired,'me/sms-contact/confirm',{challengeId:expiredId,code:'123456'}))).status,400);
  assert.equal((await deps.db.smsContact.findUniqueOrThrow({where:{userId:expired.id}})).verifiedAt,null);

  const blocked=await actor();
  let release!:()=>void,entered!:()=>void;
  const unlocked=new Promise<void>(resolve=>{release=resolve;}),locked=new Promise<void>(resolve=>{entered=resolve;});
  const holder=deps.db.$transaction(async tx=>{await tx.$executeRaw`SELECT pg_advisory_xact_lock(176012,17)`;entered();await unlocked;},{timeout:10000});
  await locked;
  const blockedId=await pending(blocked,new ActualDate((await databaseNow(deps.db)).getTime()+1500));
  const beforeBlocked=verificationSends;
  const worker=processSmsVerifications(deps.db,config,verification);
  try{
   let waiting=false;
   for(let i=0;i<30;i++){
    const [row]=await deps.db.$queryRaw<{count:bigint}[]>`SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND classid=176012 AND objid=17 AND NOT granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database())`;
    if(row!.count>0n){waiting=true;break;}await new Promise(resolve=>setTimeout(resolve,20));
   }
   assert.equal(waiting,true,'The verification worker must be waiting on the submission budget');
   await deps.db.$executeRaw`SELECT pg_sleep(1.6)`;
  }finally{release();await holder;await worker;}
  assert.equal((await deps.db.smsVerification.findUniqueOrThrow({where:{id:blockedId}})).status,'cancelled');
  assert.equal(verificationSends,beforeBlocked,'A code expiring while waiting must not be sent');
 }finally{
  globalThis.Date=ActualDate;
  try{
   await deps.db.bookingReminder.deleteMany({where:{bookingId:{in:bookings}}});
   await deps.db.bookingSmsReminder.deleteMany({where:{bookingId:{in:bookings}}});
   await deps.db.paymentOrder.deleteMany({where:{bookingId:{in:bookings}}});
   await deps.db.booking.deleteMany({where:{id:{in:bookings}}});
   await deps.db.authUser.deleteMany({where:{id:{in:users}}});
   assert.equal(await deps.db.authUser.count({where:{id:{in:users}}}),0);
  }finally{await app.close();}
 }
});
