import { Prisma, type ProviderProfile, type PayoutDestination } from '../../../generated/prisma/client.js';
import type { Identity } from '../auth/service.js';
import { AuthService } from '../auth/service.js';
import { PublicError, unauthorized } from '../auth/errors.js';
import { csrfFor, digest, equal, opaqueToken, passwordMatches, seal, unseal } from '../auth/security.js';
import { artistDetails, renterDetails, payoutDetails, providerPublic, type ProviderKind, type ProviderWrite } from './schemas.js';
import type { z } from 'zod';
import type { memberWrite, payoutWrite, decisionBody } from './schemas.js';
type Tx = Prisma.TransactionClient;
const conflict = () => new PublicError(409,'REVISION_CONFLICT','This record changed. Reload the latest version before saving.');
const missing = () => new PublicError(404,'NOT_FOUND','This record is not available.');
export class ProfileService {
  constructor(readonly auth:AuthService) {}
  get db(){return this.auth.deps.db;}
  async actor(tx:Tx, identity:Identity, csrf?:string, admin=false){
    if(csrf!==undefined&&!equal(csrfFor(this.auth.config.AUTH_JWT_SECRET,identity.session.id),csrf))throw new PublicError(403,'CSRF_REJECTED','Refresh this page and try again.');
    await tx.$queryRaw`SELECT id FROM auth_users WHERE id=${identity.user.id}::uuid FOR UPDATE`;
    const session=await tx.authSession.findUnique({where:{id:identity.session.id},include:{user:true}});
    if(!session||session.revokedAt||session.expiresAt<=new Date()||session.user.disabledAt||!session.user.roles.includes(session.activeRole))throw unauthorized();
    if(admin&&(session.activeRole!=='admin'||!session.user.roles.includes('admin')))throw new PublicError(403,'ROLE_FORBIDDEN','Administrator access is required.');
    return {user:session.user,session};
  }
  checkCsrf(identity:Identity,csrf:string|undefined){if(!csrf||!equal(csrfFor(this.auth.config.AUTH_JWT_SECRET,identity.session.id),csrf))throw new PublicError(403,'CSRF_REJECTED','Refresh this page and try again.');}
  providerRole(identity:Identity,kind?:ProviderKind){if(kind?!identity.user.roles.includes(kind):!identity.user.roles.some(r=>r==='artist'||r==='renter'))throw new PublicError(403,'ROLE_FORBIDDEN','A matching provider membership is required.');}
  verified(identity:Identity){if(!identity.user.emailVerifiedAt)throw new PublicError(403,'EMAIL_VERIFICATION_REQUIRED','Verify your account email before submitting.');}
  async challenge(identity:Identity,password:string){
    await this.auth.limits.check('sensitive-password',identity.user.id,8,900);
    if(!await passwordMatches(password,identity.user.passwordHash))throw new PublicError(403,'PASSWORD_REQUIRED','The current password is incorrect.');
  }
  private audit(tx:Tx,actorId:string,targetUserId:string,entity:string,action:string,revision:number,reason?:string){return tx.profileAudit.create({data:{actorId,targetUserId,entity,action,revision,reason}});}
  async member(identity:Identity){
    const user=await this.db.authUser.findUniqueOrThrow({where:{id:identity.user.id}}),p=await this.db.memberProfile.findUnique({where:{userId:user.id}});
    return {revision:p?.revision??0,displayName:user.displayName,email:user.email,emailVerified:Boolean(user.emailVerifiedAt),city:p?.city??'',phone:p?.phone??'',organization:p?.organization??'',bio:p?.bio??'',updatedAt:p?.updatedAt.toISOString()??null};
  }
  async saveMember(identity:Identity,input:z.infer<typeof memberWrite>,csrf:string|undefined){
    this.checkCsrf(identity,csrf);
    await this.db.$transaction(async tx=>{
      await this.actor(tx,identity);const current=await tx.memberProfile.findUnique({where:{userId:identity.user.id}});
      if((current?.revision??0)!==input.revision)throw conflict();
      const {revision,displayName,...data}=input;
      await tx.authUser.update({where:{id:identity.user.id},data:{displayName}});
      await tx.memberProfile.upsert({where:{userId:identity.user.id},create:{userId:identity.user.id,...data,revision:1},update:{...data,revision:revision+1,updatedAt:new Date()}});
      await this.audit(tx,identity.user.id,identity.user.id,'member','saved',revision+1);
    });return this.member(identity);
  }
  private details(p:ProviderProfile){return p.kind==='artist'?artistDetails.parse({category:p.category,genres:p.genres,experienceYears:p.experienceYears,baseRateMinor:p.baseRateMinor,currency:p.currency}):renterDetails.parse({equipmentCategories:p.equipmentCategories,operatingHours:p.operatingHours,rentalTerms:p.rentalTerms,deliveryOffered:p.deliveryOffered});}
  private publicCandidate(p:ProviderProfile,revision=p.revision){return providerPublic.parse({userId:p.userId,kind:p.kind,revision,displayName:p.displayName,bio:p.bio,city:p.city,serviceRadiusKm:p.serviceRadiusKm,details:this.details(p)});}
  private owner(p:ProviderProfile){const {userId,...safe}=this.publicCandidate(p);return{...safe,address:p.address,latitude:p.latitude?.toNumber()??null,longitude:p.longitude?.toNumber()??null,reviewStatus:p.reviewStatus,reviewReason:p.reviewReason,approvedRevision:p.approvedRevision,updatedAt:p.updatedAt.toISOString()};}
  async provider(identity:Identity,kind:ProviderKind){this.providerRole(identity,kind);const p=await this.db.providerProfile.findUnique({where:{userId_kind:{userId:identity.user.id,kind}}});return{profile:p?this.owner(p):null};}
  async saveProvider(identity:Identity,kind:ProviderKind,input:ProviderWrite,csrf:string|undefined){
    this.checkCsrf(identity,csrf);
    await this.db.$transaction(async tx=>{
      const actor=await this.actor(tx,identity);this.providerRole(actor,kind);
      const where={userId_kind:{userId:actor.user.id,kind}},current=await tx.providerProfile.findUnique({where});
      if((current?.revision??0)!==input.revision)throw conflict();
      const {revision,details,...base}=input;
      const data={...base,category:'',genres:[] as string[],experienceYears:0,baseRateMinor:0,currency:'LKR',equipmentCategories:[] as string[],operatingHours:[] as Prisma.InputJsonValue,rentalTerms:'',deliveryOffered:false,
        ...(kind==='artist'?artistDetails.parse(details):renterDetails.parse(details)),reviewStatus:'draft',reviewReason:null,updatedAt:new Date()};
      const next=await tx.providerProfile.upsert({where,create:{userId:actor.user.id,kind,...data,revision:1},update:{...data,revision:revision+1}});
      await this.audit(tx,actor.user.id,actor.user.id,kind,'saved',next.revision);
    });return this.provider(identity,kind);
  }
  async submitProvider(identity:Identity,kind:ProviderKind,revision:number,csrf:string|undefined){
    this.checkCsrf(identity,csrf);
    await this.db.$transaction(async tx=>{
      const actor=await this.actor(tx,identity);this.providerRole(actor,kind);this.verified(actor);
      const where={userId_kind:{userId:actor.user.id,kind}},p=await tx.providerProfile.findUnique({where});
      if(!p)throw missing();if(p.revision!==revision||!['draft','rejected'].includes(p.reviewStatus))throw conflict();
      if(kind==='renter'&&!renterDetails.parse(this.details(p)).operatingHours.some(d=>d.opens))throw new PublicError(400,'OPERATING_HOURS_REQUIRED','Set at least one opening day before submitting.');
      await tx.providerProfile.update({where,data:{reviewStatus:'pending',reviewReason:null,revision:revision+1,updatedAt:new Date()}});
      await this.audit(tx,actor.user.id,actor.user.id,kind,'submitted',revision+1);
    });return this.provider(identity,kind);
  }
  async publicProvider(userId:string,kind:ProviderKind){
    const p=await this.db.providerProfile.findFirst({where:{userId,kind,approvedRevision:{not:null},user:{disabledAt:null,emailVerifiedAt:{not:null}}}});
    if(!p?.approvedSnapshot)throw missing();return providerPublic.parse(p.approvedSnapshot);
  }
  private payoutContext(userId:string,revision:number){return`stagelink-payout-v1:${userId}:${revision}`;}
  private payoutView(p:PayoutDestination){const {number,...safe}=payoutDetails.parse(unseal(this.auth.config.PAYOUT_DATA_KEY,p.sealedDetails,this.payoutContext(p.userId,p.revision)));
    if(number.slice(-4)!==p.accountLast4)throw new Error('INVALID_DESTINATION');
    return{...safe,accountLast4:p.accountLast4,revision:p.revision,status:p.status,reviewReason:p.reviewReason,updatedAt:p.updatedAt.toISOString(),transfersEnabled:false as const};}
  async payout(identity:Identity){this.providerRole(identity);const p=await this.db.payoutDestination.findUnique({where:{userId:identity.user.id}});return{destination:p?this.payoutView(p):null};}
  async savePayout(identity:Identity,input:z.infer<typeof payoutWrite>,csrf:string|undefined){
    this.checkCsrf(identity,csrf);await this.challenge(identity,input.password);
    await this.db.$transaction(async tx=>{
      const actor=await this.actor(tx,identity);this.providerRole(actor);this.verified(actor);
      if(actor.user.passwordHash!==identity.user.passwordHash)throw unauthorized();
      const current=await tx.payoutDestination.findUnique({where:{userId:actor.user.id}});if((current?.revision??0)!==input.revision)throw conflict();
      const revision=input.revision+1,details=payoutDetails.parse({holder:input.holder,bank:input.bank,branch:input.branch,number:input.number});
      const data={revision,sealedDetails:seal(this.auth.config.PAYOUT_DATA_KEY,details,this.payoutContext(actor.user.id,revision)),accountLast4:details.number.slice(-4),status:'pending',reviewReason:null,updatedAt:new Date()};
      await tx.payoutDestination.upsert({where:{userId:actor.user.id},create:{userId:actor.user.id,...data},update:data});
      await tx.payoutDestinationVersion.create({data:{userId:actor.user.id,revision,sealedDetails:data.sealedDetails,accountLast4:data.accountLast4}});
      await this.audit(tx,actor.user.id,actor.user.id,'payout','submitted',revision);
    });return this.payout(identity);
  }
  async queue(identity:Identity){
    if(identity.session.activeRole!=='admin'||!identity.user.roles.includes('admin'))throw new PublicError(403,'ROLE_FORBIDDEN','Administrator access is required.');
    const [providers,payouts]=await Promise.all([
      this.db.providerProfile.findMany({where:{reviewStatus:'pending',user:{disabledAt:null}},orderBy:[{updatedAt:'asc'},{userId:'asc'},{kind:'asc'}],take:25}),
      this.db.payoutDestination.findMany({where:{status:'pending',user:{disabledAt:null}},include:{user:{select:{displayName:true}}},orderBy:[{updatedAt:'asc'},{userId:'asc'}],take:25})]);
    return{providers:providers.map(p=>({...this.publicCandidate(p),updatedAt:p.updatedAt.toISOString()})),payouts:payouts.map(p=>({userId:p.userId,displayName:p.user.displayName,destination:this.payoutView(p)})),limitPerQueue:25 as const};
  }
  private reviewAllowed(actor:Identity,targetUserId:string){
    this.verified(actor);if(actor.user.id===targetUserId)throw new PublicError(403,'SELF_REVIEW_FORBIDDEN','Another administrator must review your submission.');
    if(actor.session.createdAt.getTime()<Date.now()-15*60000)throw new PublicError(403,'RECENT_LOGIN_REQUIRED','Sign in again before reviewing a submission.');
  }
  async reviewProvider(identity:Identity,userId:string,kind:ProviderKind,input:z.infer<typeof decisionBody>,csrf:string|undefined){
    this.checkCsrf(identity,csrf);
    await this.db.$transaction(async tx=>{
      for(const id of [...new Set([identity.user.id,userId])].sort())await tx.$queryRaw`SELECT id FROM auth_users WHERE id=${id}::uuid FOR UPDATE`;
      const actor=await this.actor(tx,identity,undefined,true);this.reviewAllowed(actor,userId);
      await tx.$queryRaw`SELECT id FROM auth_users WHERE id=${userId}::uuid FOR UPDATE`;
      const where={userId_kind:{userId,kind}},p=await tx.providerProfile.findUnique({where,include:{user:true}});
      if(!p||p.user.disabledAt)throw missing();if(!p.user.emailVerifiedAt)throw new PublicError(409,'EMAIL_VERIFICATION_REQUIRED','The provider must verify their account email first.');
      if(p.revision!==input.revision||p.reviewStatus!=='pending')throw conflict();
      const revision=p.revision+1;
      await tx.providerProfile.update({where,data:{revision,reviewStatus:input.approved?'approved':'rejected',reviewReason:input.reason,updatedAt:new Date(),
        ...(input.approved?{approvedRevision:revision,approvedSnapshot:this.publicCandidate(p,revision),approvedLatitude:p.latitude?.toDecimalPlaces(2)??null,approvedLongitude:p.longitude?.toDecimalPlaces(2)??null}:{})}});
      await this.audit(tx,actor.user.id,userId,kind,input.approved?'approved':'rejected',revision,input.reason);
    });return{message:'Profile review recorded. This does not verify identity or payment eligibility.'};
  }
  async reviewPayout(identity:Identity,userId:string,input:z.infer<typeof decisionBody>,csrf:string|undefined){
    this.checkCsrf(identity,csrf);
    await this.db.$transaction(async tx=>{
      for(const id of [...new Set([identity.user.id,userId])].sort())await tx.$queryRaw`SELECT id FROM auth_users WHERE id=${id}::uuid FOR UPDATE`;
      const actor=await this.actor(tx,identity,undefined,true);this.reviewAllowed(actor,userId);
      await tx.$queryRaw`SELECT id FROM auth_users WHERE id=${userId}::uuid FOR UPDATE`;
      const p=await tx.payoutDestination.findUnique({where:{userId},include:{user:true}});
      if(!p||p.user.disabledAt)throw missing();if(!p.user.emailVerifiedAt)throw new PublicError(409,'EMAIL_VERIFICATION_REQUIRED','The provider must verify their account email first.');
      if(p.revision!==input.revision||p.status!=='pending')throw conflict();
      // A review doesn't change destination revision or ciphertext: that revision identifies exact reviewed bank details.
      await tx.payoutDestination.update({where:{userId},data:{status:input.approved?'approved':'rejected',reviewReason:input.reason,updatedAt:new Date()}});
      await tx.payoutDestinationVersion.update({where:{userId_revision:{userId,revision:p.revision}},data:{status:input.approved?'approved':'rejected',reviewReason:input.reason,reviewerId:actor.user.id,reviewedAt:new Date()}});
      await this.audit(tx,actor.user.id,userId,'payout',input.approved?'approved':'rejected',p.revision,input.reason);
    });return{message:'Destination review recorded. Payment setup and payout authorization remain separate.'};
  }
  async pendingEmail(identity:Identity){const p=await this.db.pendingEmailChange.findUnique({where:{userId:identity.user.id}});return{pending:p&&p.expiresAt>new Date()?{email:p.newEmail,expiresAt:p.expiresAt.toISOString()}:null};}
  async requestEmail(identity:Identity,email:string,password:string,csrf:string|undefined){
    this.checkCsrf(identity,csrf);await this.auth.limits.check('email-change',identity.user.id,3,3600);await this.challenge(identity,password);
    await this.db.$transaction(async tx=>{
      const actor=await this.actor(tx,identity);if(actor.user.passwordHash!==identity.user.passwordHash)throw unauthorized();
      await tx.authToken.updateMany({where:{userId:actor.user.id,purpose:'email_change',usedAt:null},data:{usedAt:new Date()}});
      await tx.pendingEmailChange.deleteMany({where:{userId:actor.user.id}});
      const deliver=email!==actor.user.email&&!await tx.authUser.findUnique({where:{email}});
      const token=opaqueToken(),tokenDigest=digest(token),expiresAt=new Date(Date.now()+900000);
      await tx.pendingEmailChange.create({data:{userId:actor.user.id,fromEmail:actor.user.email,newEmail:email,tokenDigest,expiresAt}});
      await tx.authToken.create({data:{userId:actor.user.id,purpose:'email_change',email,digest:tokenDigest,expiresAt}});
      if(deliver)await tx.authMail.create({data:{userId:actor.user.id,expiresAt,sealedPayload:seal(this.auth.config.AUTH_MAIL_KEY,{to:email,token,purpose:'email_change'})}});
      await this.audit(tx,actor.user.id,actor.user.id,'email','requested',0);
    });return{message:'If this address is available, a confirmation email will arrive. Your current email is unchanged until confirmation.'};
  }
  async cancelEmail(identity:Identity,csrf:string|undefined){this.checkCsrf(identity,csrf);await this.db.$transaction(async tx=>{
    await this.actor(tx,identity);await tx.pendingEmailChange.deleteMany({where:{userId:identity.user.id}});await tx.authToken.updateMany({where:{userId:identity.user.id,purpose:'email_change',usedAt:null},data:{usedAt:new Date()}});
  });return{message:'Pending email change cancelled.'};}
  async confirmEmailChange(raw:string,ip:string){
    await this.auth.limits.check('email-change-confirm',ip,30,900);
    try{await this.db.$transaction(async tx=>{
      const token=await tx.authToken.findUnique({where:{digest:digest(raw)}});if(!token||token.purpose!=='email_change'||token.usedAt||token.expiresAt<=new Date())throw unauthorized();
      await tx.$queryRaw`SELECT id FROM auth_users WHERE id=${token.userId}::uuid FOR UPDATE`;
      const p=await tx.pendingEmailChange.findUnique({where:{userId:token.userId},include:{user:true}});
      if(!p||p.tokenDigest!==token.digest||p.newEmail!==token.email||p.fromEmail!==p.user.email||p.user.disabledAt||p.expiresAt<=new Date())throw unauthorized();
      const consumed=await tx.authToken.updateMany({where:{id:token.id,usedAt:null,expiresAt:{gt:new Date()}},data:{usedAt:new Date()}});if(consumed.count!==1)throw unauthorized();
      await tx.authUser.update({where:{id:p.userId},data:{email:p.newEmail,emailVerifiedAt:new Date()}});
      await tx.authToken.updateMany({where:{userId:p.userId,usedAt:null},data:{usedAt:new Date()}});
      await tx.authSession.updateMany({where:{userId:p.userId,revokedAt:null},data:{revokedAt:new Date()}});
      await tx.pendingEmailChange.delete({where:{userId:p.userId}});
      await this.audit(tx,p.userId,p.userId,'email','confirmed',0);
    });}catch(error){if(error instanceof Prisma.PrismaClientKnownRequestError&&error.code==='P2002')throw new PublicError(409,'EMAIL_CHANGE_UNAVAILABLE','This change is no longer available. Request another.');throw error;}
    return{message:'Email changed and verified. Sign in again with your new email.'};
  }
}

// P12 executors must call this inside their transaction and also enforce financial/KYC eligibility.
// An approved destination is bound to its exact revision, never to a mutable user-only reference.
export async function assertReviewedDestination(tx:Tx,userId:string,revision:number){
  await tx.$queryRaw`SELECT id FROM auth_users WHERE id=${userId}::uuid FOR UPDATE`;
  const p=await tx.payoutDestination.findUnique({where:{userId},include:{user:true}});
  if(!p||p.revision!==revision||p.status!=='approved'||p.user.disabledAt||!p.user.emailVerifiedAt)throw new PublicError(409,'DESTINATION_NOT_APPROVED','The current payout destination needs review.');
  return{userId:p.userId,revision:p.revision};
}
