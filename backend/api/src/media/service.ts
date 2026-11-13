import {randomUUID,createHash} from 'node:crypto';
import {SignJWT,jwtVerify} from 'jose';
import type {Request} from 'express';
import type {z} from 'zod';
import type {Asset,PortfolioItem,Prisma} from '../../../generated/prisma/client.js';
import {AuthService,type Identity} from '../auth/service.js';
import {ProfileService} from '../profiles/service.js';
import {PublicError,unauthorized} from '../auth/errors.js';
import {MediaStore,originalKey,derivativeKey} from '../../../shared/media-store.js';
import * as S from './schemas.js';
const missing=()=>new PublicError(404,'NOT_FOUND','This media is not available.');
const conflict=()=>new PublicError(409,'MEDIA_CONFLICT','This item changed or is in use. Refresh the library and try again.');
const storageError=()=>new PublicError(503,'MEDIA_STORAGE_UNAVAILABLE','File storage is temporarily unavailable. Try again shortly.');
let activeUploads=0,activeDownloads=0;
export class MediaService {
 readonly profiles:ProfileService;
 constructor(readonly auth:AuthService,readonly store:MediaStore){this.profiles=new ProfileService(auth);}
 get db(){return this.auth.deps.db;}
 view(a:Asset){return S.asset.parse({id:a.id,purpose:a.purpose,filename:a.filename,mime:a.mime,bytes:a.bytes,status:a.status,createdAt:a.createdAt.toISOString(),reason:a.reason,metadata:a.metadata,variants:Object.keys(a.variants as object)});}
 itemView(item:PortfolioItem&{asset:Asset|null}){return S.item.parse({...item,updatedAt:item.updatedAt.toISOString(),asset:item.asset?this.view(item.asset):null});}
 async library(i:Identity){const [assets,avatar]=await Promise.all([this.db.asset.findMany({where:{ownerId:i.user.id,status:{notIn:['deleted','purged']}},orderBy:{createdAt:'desc'},take:100}),this.db.avatarBinding.findUnique({where:{ownerId:i.user.id}})]);return{assets:assets.map(a=>this.view(a)),avatarAssetId:avatar?.assetId??null};}
 async initiate(i:Identity,input:z.infer<typeof S.upload>,csrf:string|undefined){
  this.profiles.checkCsrf(i,csrf);await this.auth.limits.check('media-upload-intent',i.user.id,30,3600);
  if(!i.user.emailVerifiedAt)throw new PublicError(403,'EMAIL_VERIFICATION_REQUIRED','Verify your account email before uploading files.');
  try{await this.store.ready();}catch{throw storageError();}
  const a=await this.db.$transaction(async tx=>{
   const actor=await this.profiles.actor(tx,i);this.profiles.verified(actor);
   if(input.purpose==='verification')this.profiles.providerRole(actor);
   if(['portfolio','equipment','inspection'].includes(input.purpose))this.profiles.providerRole(actor,input.purpose==='portfolio'?undefined:'renter');
   const aggregate=await tx.asset.aggregate({where:{ownerId:i.user.id,status:{not:'purged'}},_count:true,_sum:{bytes:true}});
   if(aggregate._count>=100||(aggregate._sum.bytes??0)+input.bytes>500*1024*1024)throw new PublicError(409,'MEDIA_QUOTA_REACHED','Your media library is full. Remove unused files and allow cleanup to finish.');
   return tx.asset.create({data:{ownerId:i.user.id,...input,expiresAt:new Date(Date.now()+3600000)}});
  });return this.view(a);
 }
 async upload(i:Identity,id:string,req:Request,csrf:string|undefined){
  this.profiles.checkCsrf(i,csrf);
  if(activeUploads>=2)throw new PublicError(429,'UPLOAD_BUSY','Other uploads are in progress. Try again shortly.');
  const lease=randomUUID();let claimed=false;activeUploads++;
  try{
   const a=await this.db.$transaction(async tx=>{await this.profiles.actor(tx,i);await tx.$queryRaw`SELECT id FROM assets WHERE id=${id}::uuid FOR UPDATE`;const a=await tx.asset.findUnique({where:{id}});if(!a||a.ownerId!==i.user.id)throw missing();if(a.status!=='pending'||a.expiresAt<new Date())throw conflict();await tx.asset.update({where:{id},data:{status:'uploading',leaseOwner:lease,expiresAt:new Date(Date.now()+3600000)}});return a;});claimed=true;
   if(Number(req.get('Content-Length'))!==a.bytes)throw new PublicError(400,'UPLOAD_SIZE_MISMATCH','The file size changed. Start a new upload.');
   const chunks:Buffer[]=[];let bytes=0;
   const timeout=setTimeout(()=>req.destroy(),30000);
   try{for await(const raw of req){const b=Buffer.from(raw);bytes+=b.length;if(bytes>a.bytes)throw new PublicError(400,'UPLOAD_SIZE_MISMATCH','The file is larger than expected.');chunks.push(b);}}finally{clearTimeout(timeout);}
   const data=Buffer.concat(chunks);
   if(data.length!==a.bytes||createHash('sha256').update(data).digest('hex')!==a.sha256)throw new PublicError(400,'UPLOAD_INTEGRITY_MISMATCH','The file contents changed. Start a new upload.');
   try{await this.store.put(originalKey(id),data,a.mime);}catch{throw storageError();}
   const result=await this.db.asset.updateMany({where:{id,ownerId:i.user.id,status:'uploading',leaseOwner:lease},data:{status:'staged',leaseOwner:null,leaseUntil:null}});
   if(!result.count)throw conflict();
   return{message:'File received. Finalize the upload to start validation.'};
  }catch(error){if(claimed)await this.db.asset.updateMany({where:{id,status:'uploading',leaseOwner:lease},data:{status:'rejected',reason:'Upload did not complete. Start a new upload.',deleteAfter:new Date(Date.now()+86400000),leaseOwner:null}});throw error;}
  finally{activeUploads--;}
 }
 async finalize(i:Identity,id:string,csrf:string|undefined){this.profiles.checkCsrf(i,csrf);await this.db.$transaction(async tx=>{await this.profiles.actor(tx,i);await tx.$queryRaw`SELECT id FROM assets WHERE id=${id}::uuid FOR UPDATE`;const a=await tx.asset.findUnique({where:{id}});if(!a||a.ownerId!==i.user.id)throw missing();if(!['staged','uploaded','processing','ready'].includes(a.status))throw conflict();if(a.status==='staged'){if(a.expiresAt<new Date())throw conflict();await tx.$executeRaw`UPDATE assets SET status='uploaded', available_at=now() WHERE id=${id}::uuid`;}});return{message:'Validation is queued. This file stays private until it is ready.'};}
 async remove(i:Identity,id:string,csrf:string|undefined){this.profiles.checkCsrf(i,csrf);await this.db.$transaction(async tx=>{
  await this.profiles.actor(tx,i);await tx.$queryRaw`SELECT id FROM assets WHERE id=${id}::uuid FOR UPDATE`;const a=await tx.asset.findUnique({where:{id}});if(!a||a.ownerId!==i.user.id)throw missing();
  if(['uploading','uploaded','processing'].includes(a.status)||await tx.avatarBinding.count({where:{assetId:id}})||await tx.portfolioItem.count({where:{assetId:id}})||await tx.bookingMessageAttachment.count({where:{assetId:id}})||await tx.supportAttachment.count({where:{assetId:id}})||await tx.verificationDocument.count({where:{assetId:id}})||await tx.equipmentInspectionPhoto.count({where:{assetId:id}})||await tx.bookingReviewPhoto.count({where:{assetId:id}})||await tx.assetHold.count({where:{assetId:id,until:{gt:new Date()}}}))throw conflict();
  if(!['deleted','purged'].includes(a.status))await tx.asset.update({where:{id},data:{status:'deleted',deleteAfter:new Date(Date.now()+86400000)}});
 });return{message:'File removed. Unreferenced stored bytes are scheduled for cleanup in 24 hours.'};}
 async avatar(i:Identity,assetId:string|null,csrf:string|undefined){this.profiles.checkCsrf(i,csrf);await this.db.$transaction(async tx=>{await this.profiles.actor(tx,i);if(!assetId){await tx.avatarBinding.deleteMany({where:{ownerId:i.user.id}});return;}await this.readyAsset(tx,i.user.id,assetId,['avatar']);await tx.avatarBinding.upsert({where:{ownerId:i.user.id},create:{ownerId:i.user.id,assetId},update:{assetId}});});return{message:assetId?'Profile photo saved.':'Profile photo removed.'};}
 private async readyAsset(tx:Prisma.TransactionClient,ownerId:string,assetId:string,purposes:string[]){await tx.$queryRaw`SELECT id FROM assets WHERE id=${assetId}::uuid FOR UPDATE`;const a=await tx.asset.findUnique({where:{id:assetId}});if(!a||a.ownerId!==ownerId||a.status!=='ready'||!purposes.includes(a.purpose))throw missing();return a;}
 async portfolio(i:Identity){this.profiles.providerRole(i);return{items:(await this.db.portfolioItem.findMany({where:{ownerId:i.user.id},include:{asset:true},orderBy:[{featured:'desc'},{updatedAt:'desc'}],take:100})).map(p=>this.itemView(p))};}
 async saveItem(i:Identity,input:z.infer<typeof S.itemWrite>|z.infer<typeof S.itemPatch>,id:string|undefined,csrf:string|undefined){
  this.profiles.checkCsrf(i,csrf);let embedUrl:string|null=null;
  if(Boolean(input.assetId)===Boolean(input.embedUrl))throw new PublicError(400,'MEDIA_SOURCE_REQUIRED','Choose one uploaded file or one video link.');
  if(input.embedUrl)try{embedUrl=S.canonicalEmbed(input.embedUrl);}catch(e){throw new PublicError(400,'EMBED_REJECTED',(e as Error).message);}
  await this.db.$transaction(async tx=>{
   const actor=await this.profiles.actor(tx,i);this.profiles.providerRole(actor,input.kind);
   const current=id?await tx.portfolioItem.findUnique({where:{id}}):null;
   if(id&&(!current||current.ownerId!==i.user.id))throw missing();if(current&&(!('revision'in input)||current.revision!==input.revision))throw conflict();
   if(current&&current.kind!==input.kind)throw conflict();
   if(!id&&await tx.portfolioItem.count({where:{ownerId:i.user.id}})>=50)throw new PublicError(409,'PORTFOLIO_LIMIT','Your portfolio can contain up to 50 items.');
   if(input.assetId)await this.readyAsset(tx,i.user.id,input.assetId,[input.kind==='renter'?'equipment':'portfolio']);
   if(input.featured)await tx.portfolioItem.updateMany({where:{ownerId:i.user.id,kind:input.kind,featured:true,...(id?{id:{not:id}}:{})},data:{featured:false,revision:{increment:1},updatedAt:new Date()}});
   const data={kind:input.kind,assetId:input.assetId,embedUrl,caption:input.caption,transcript:input.transcript,featured:input.featured,status:'draft',reason:null,updatedAt:new Date()};
   if(current)await tx.portfolioItem.update({where:{id:current.id},data:{...data,revision:current.revision+1}});else await tx.portfolioItem.create({data:{ownerId:i.user.id,...data}});
  });return this.portfolio(i);
 }
 async itemAction(i:Identity,id:string,revision:number,remove:boolean,csrf:string|undefined){this.profiles.checkCsrf(i,csrf);await this.db.$transaction(async tx=>{const actor=await this.profiles.actor(tx,i);const p=await tx.portfolioItem.findUnique({where:{id}});if(!p||p.ownerId!==i.user.id)throw missing();this.profiles.providerRole(actor,p.kind as 'artist'|'renter');if(p.revision!==revision)throw conflict();if(remove)await tx.portfolioItem.delete({where:{id}});else{this.profiles.verified(actor);if(p.assetId)await this.readyAsset(tx,i.user.id,p.assetId,[p.kind==='renter'?'equipment':'portfolio']);await tx.portfolioItem.update({where:{id},data:{status:'pending',revision:p.revision+1,reason:null,updatedAt:new Date()}});}});return this.portfolio(i);}
 async reviewQueue(i:Identity){if(i.session.activeRole!=='admin')throw new PublicError(403,'ROLE_FORBIDDEN','Administrator access is required.');return{items:(await this.db.portfolioItem.findMany({where:{status:'pending'},include:{asset:true,owner:true},orderBy:{updatedAt:'asc'},take:25})).map(p=>({...this.itemView(p),ownerId:p.ownerId,ownerName:p.owner.displayName}))};}
 async review(i:Identity,id:string,input:z.infer<typeof S.review>,csrf:string|undefined){this.profiles.checkCsrf(i,csrf);await this.db.$transaction(async tx=>{
  const initial=await tx.portfolioItem.findUnique({where:{id}});if(!initial)throw missing();
  for(const userId of [i.user.id,initial.ownerId].sort())await tx.$queryRaw`SELECT id FROM auth_users WHERE id=${userId}::uuid FOR UPDATE`;
  const actor=await this.profiles.actor(tx,i,undefined,true);this.profiles.verified(actor);
  if(actor.session.createdAt<new Date(Date.now()-15*60000))throw new PublicError(403,'RECENT_LOGIN_REQUIRED','Sign in again before reviewing media.');
  if(initial.ownerId===i.user.id)throw new PublicError(403,'SELF_REVIEW_REJECTED','You cannot review your own media.');
  const p=await tx.portfolioItem.findUniqueOrThrow({where:{id}});if(p.status!=='pending'||p.revision!==input.revision)throw conflict();
  if(input.approved&&p.assetId)await this.readyAsset(tx,p.ownerId,p.assetId,[p.kind==='renter'?'equipment':'portfolio']);
  await tx.portfolioItem.update({where:{id},data:{status:input.approved?'approved':'rejected',reason:input.reason,revision:p.revision+1,updatedAt:new Date()}});
  await tx.profileAudit.create({data:{actorId:i.user.id,targetUserId:p.ownerId,entity:'portfolio',action:input.approved?'approved':'rejected',revision:p.revision+1,reason:input.reason}});
 });return{message:'Media review recorded.'};}
 private async isPublic(p:PortfolioItem|null){if(!p||p.status!=='approved')return false;const provider=await this.db.providerProfile.findUnique({where:{userId_kind:{userId:p.ownerId,kind:p.kind}},include:{user:true}});return Boolean(provider?.approvedRevision&&!provider.user.disabledAt&&provider.user.roles.includes(p.kind));}
 async publicPortfolio(ownerId:string,kind:'artist'|'renter'){
  const provider=await this.db.providerProfile.findUnique({where:{userId_kind:{userId:ownerId,kind}},include:{user:true}});if(!provider?.approvedRevision||provider.user.disabledAt||!provider.user.roles.includes(kind))throw missing();
  const items=await this.db.portfolioItem.findMany({where:{ownerId,kind,status:'approved',OR:[{assetId:null},{asset:{status:'ready'}}]},include:{asset:true},orderBy:[{featured:'desc'},{updatedAt:'desc'}],take:50});
  return{items:items.map(p=>this.itemView(p))};
 }
 async capability(i:Identity,id:string,variant:z.infer<typeof S.variant>,csrf:string|undefined){
  this.profiles.checkCsrf(i,csrf);await this.auth.limits.check('media-access',i.user.id,180,60);const a=await this.db.asset.findUnique({where:{id}});if(!a||a.status!=='ready'||!await this.canRead(i,a))throw missing();
  return this.sign(id,variant,{uid:i.user.id,sid:i.session.id});
 }
 private async canRead(i:Identity,a:Asset){
  if(a.ownerId===i.user.id)return true;
  if(a.purpose==='chat'){
   const userId=i.user.id;
   return Boolean(await this.db.bookingMessageAttachment.findFirst({
    where:{assetId:a.id,message:{authorId:a.ownerId,booking:{OR:[{customerId:userId},{providerId:userId}]}}},
    select:{messageId:true},
   }));
  }
  if(a.purpose==='support'){
   return i.session.activeRole==='admin'&&Boolean(i.user.emailVerifiedAt)&&
    await this.db.supportAttachment.count({where:{assetId:a.id}})>0;
  }
  if(a.purpose==='verification'){
   return i.session.activeRole==='admin'&&Boolean(i.user.emailVerifiedAt)&&
    await this.db.verificationDocument.count({where:{assetId:a.id,case:{status:'pending'}}})>0;
  }
  if(a.purpose==='inspection'){
   return Boolean(await this.db.equipmentInspectionPhoto.findFirst({
    where:{assetId:a.id,report:{inspection:{booking:{OR:[{customerId:i.user.id},{providerId:i.user.id}]}}}},
    select:{assetId:true},
   }));
  }
  if(a.purpose==='review'){
   return i.session.activeRole==='admin'&&await this.db.bookingReviewPhoto.count({where:{assetId:a.id}})>0;
  }
  return i.session.activeRole==='admin'&&await this.db.portfolioItem.count({where:{assetId:a.id,status:'pending'}})>0;
 }
 async publicCapability(itemId:string,variant:z.infer<typeof S.variant>,ip:string){await this.auth.limits.check('public-media-access',ip,180,60);const p=await this.db.portfolioItem.findUnique({where:{id:itemId}});if(!p?.assetId||!await this.isPublic(p))throw missing();return this.sign(p.assetId,variant,{pid:p.id,rev:p.revision});}
 private async sign(assetId:string,variant:string,scope:Record<string,unknown>){const a=await this.db.asset.findUnique({where:{id:assetId}});if(!a||a.status!=='ready'||!(variant in(a.variants as object)))throw missing();const token=await new SignJWT({...scope,variant}).setProtectedHeader({alg:'HS256',typ:'JWT'}).setIssuer('stagelink-media').setAudience('stagelink-media-content').setSubject(assetId).setIssuedAt().setExpirationTime('60s').sign(Buffer.from(this.auth.config.AUTH_JWT_SECRET,'hex'));return{url:`/api/v1/media/content/${assetId}?token=${token}`,expiresIn:60 as const};}
 async content(id:string,raw:string,ip:string){
  await this.auth.limits.check('media-download',ip,180,60);let payload;
  try{payload=(await jwtVerify(raw,Buffer.from(this.auth.config.AUTH_JWT_SECRET,'hex'),{issuer:'stagelink-media',audience:'stagelink-media-content',algorithms:['HS256'],typ:'JWT',maxTokenAge:'60s'})).payload;}catch{throw unauthorized();}
  if(payload.sub!==id||!S.variant.safeParse(payload.variant).success)throw unauthorized();
  const a=await this.db.asset.findUnique({where:{id}});if(!a||a.status!=='ready')throw missing();
  if(typeof payload.uid==='string'&&typeof payload.sid==='string'){
   const session=await this.db.authSession.findUnique({where:{id:payload.sid},include:{user:true}});
   if(!session||session.userId!==payload.uid||session.revokedAt||session.expiresAt<=new Date()||session.user.disabledAt||!session.user.roles.includes(session.activeRole)||!await this.canRead({user:session.user,session},a))throw unauthorized();
  }else if(typeof payload.pid==='string'&&typeof payload.rev==='number'){
   const p=await this.db.portfolioItem.findUnique({where:{id:payload.pid}});if(!p||p.assetId!==id||p.revision!==payload.rev||!await this.isPublic(p))throw missing();
  }else throw unauthorized();
  const v=(a.variants as Record<string,{mime:string;bytes:number}>)[String(payload.variant)];if(!v||v.bytes>9*1024*1024)throw missing();
  if(activeDownloads>=4)throw new PublicError(429,'MEDIA_READ_BUSY','Other previews are loading. Try again shortly.');
  activeDownloads++;try{return{mime:v.mime,bytes:await this.store.get(derivativeKey(id,String(payload.variant)),9*1024*1024)};}catch{throw storageError();}finally{activeDownloads--;}
 }
}
