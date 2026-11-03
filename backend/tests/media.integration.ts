import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {spawn,type ChildProcess,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {once} from 'node:events';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import sharp from 'sharp';
import {SignJWT} from 'jose';
import {createApp} from '../api/src/app.js';
import {readConfig} from '../shared/config.js';
import {resources} from '../shared/resources.js';
import {hashPassword} from '../api/src/auth/security.js';
import {MediaStore,originalKey,derivativeKey} from '../shared/media-store.js';
import {processMediaBatch,cleanupMediaBatch,holdAsset} from '../shared/media-processing.js';
const exec=promisify(execFile),config=readConfig({...process.env,AUTH_RATE_PREFIX:'media-test-'+randomUUID()});
if(config.NODE_ENV!=='test'||!new URL(config.DATABASE_URL).pathname.endsWith('_test')||!config.S3_BUCKET.endsWith('-test'))throw Error('Media integration requires isolated test storage and database');
test('persistent private uploads, real derivatives, publication, capabilities, retention and worker restart',{timeout:180000},async()=>{
 const deps=resources(config),store=new MediaStore(config),{app}=await createApp(config,deps);await app.listen(0,'127.0.0.1');const base=await app.getUrl(),suffix=randomUUID(),ids:string[]=[],dir=await mkdtemp(join(tmpdir(),'stagelink-media-test-'));
 const password='A private fixture password 12!';type Login={accessToken:string;csrfToken:string;user:{id:string};cookie:string};let worker:ChildProcess|undefined;
 async function stop(){if(worker&&worker.exitCode===null){const exit=once(worker,'exit');worker.kill('SIGTERM');await exit;}worker=undefined;}
 async function until(check:()=>Promise<boolean>){const end=Date.now()+60000;while(Date.now()<end){if(await check())return;await new Promise(r=>setTimeout(r,150));}throw Error('Media integration condition timed out');}
 async function start(){worker=spawn(process.execPath,['dist/worker/src/main.js'],{env:{...process.env,WORKER_HEALTH_PORT:'14002'},stdio:'ignore'});await until(async()=>{try{return(await fetch('http://127.0.0.1:14002/health/ready')).ok;}catch{return false;}});}
 async function call(path:string,body?:unknown,auth?:Login,method?:string,headers:Record<string,string>={}){const r=await fetch(base+'/api/v1/'+path,{method:method??(body===undefined?'GET':'POST'),headers:{'Content-Type':'application/json',Origin:config.WEB_ORIGIN,...(auth?{Authorization:'Bearer '+auth.accessToken,'X-CSRF-Token':auth.csrfToken,Cookie:auth.cookie}:{}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});const t=await r.text();return{status:r.status,data:t?JSON.parse(t):null,headers:r.headers};}
 async function fixture(label:string,roles:('customer'|'artist'|'renter'|'admin')[]){const u=await deps.db.authUser.create({data:{email:`${label}-${suffix}@stagelink.test`,displayName:label,passwordHash:await hashPassword(password),roles,emailVerifiedAt:new Date()}});ids.push(u.id);const r=await call('auth/login',{email:u.email,password});assert.equal(r.status,200);return{...r.data,cookie:r.headers.get('set-cookie')!.split(';')[0]!}as Login;}
 const image=await sharp({create:{width:100,height:80,channels:3,background:'#7c3aed'}}).png().toBuffer();
 async function intent(bytes:Buffer,mime='image/png',purpose='portfolio',a?:Login){const r=await call('assets/uploads',{filename:'fixture.'+(mime==='image/png'?'png':mime==='audio/wav'?'wav':'mp4'),bytes:bytes.length,mime,purpose,sha256:createHash('sha256').update(bytes).digest('hex')},a);assert.equal(r.status,200,JSON.stringify(r.data));return r.data.id as string;}
 async function send(id:string,bytes:Buffer,a:Login,headers:Record<string,string>={}){return fetch(base+`/api/v1/assets/${id}/content`,{method:'PUT',headers:{Origin:config.WEB_ORIGIN,'Content-Type':'application/octet-stream',Authorization:'Bearer '+a.accessToken,'X-CSRF-Token':a.csrfToken,...headers},body:new Uint8Array(bytes)});}
 async function upload(bytes:Buffer,a:Login,mime='image/png',purpose='portfolio'){const id=await intent(bytes,mime,purpose,a);assert.equal((await send(id,bytes,a)).status,200);assert.equal((await call(`assets/${id}/finalize`,{},a)).status,200);return id;}
 try{
  await store.ready();const a=await fixture('artist',['customer','artist']),b=await fixture('other',['customer','artist']),admin=await fixture('admin',['admin']),renter=await fixture('renter',['customer','renter']);
  assert.equal((await call('me/assets',undefined,a)).data.assets.length,0);assert.equal((await call('me/portfolio',undefined,a)).data.items.length,0);
  assert.equal((await call('assets/uploads',{filename:'evil.svg',bytes:2,mime:'image/svg+xml',purpose:'avatar',sha256:'0'.repeat(64)},a)).status,400);
  assert.equal((await call('assets/uploads',{filename:'../bad.png',bytes:1,mime:'image/png',purpose:'avatar',sha256:'0'.repeat(64)},a)).status,400);
  const id=await intent(image,'image/png','portfolio',a);
  assert.equal((await send(id,image,b)).status,404);assert.equal((await send(id,image,a,{'X-CSRF-Token':'wrong'})).status,403);assert.equal((await send(id,image,a,{Origin:'https://untrusted.example'})).status,403);
  assert.equal((await call(`assets/${id}/finalize`,{},a)).status,409);
  assert.equal((await send(id,image,a)).status,200);assert.equal((await deps.db.asset.findUniqueOrThrow({where:{id}})).status,'staged');
  assert.equal(await processMediaBatch(deps,store),false,'Unfinalized files must not process');assert.equal((await send(id,image,a)).status,409);
  assert.equal((await call(`assets/${id}/access`,{variant:'display'},a)).status,404);
  await deps.db.asset.update({where:{id},data:{availableAt:new Date(Date.now()+3600000)}});
  await call(`assets/${id}/finalize`,{},a);await call(`assets/${id}/finalize`,{},a);
  const claimed=await Promise.all([processMediaBatch(deps,store),processMediaBatch(deps,store)]);assert.equal(claimed.filter(Boolean).length,1);
  const ready=await deps.db.asset.findUniqueOrThrow({where:{id}});assert.equal(ready.status,'ready');assert.equal(ready.attempts,1);assert.equal((ready.metadata as any).width,100);
  const cap=await call(`assets/${id}/access`,{variant:'display'},a);assert.equal(cap.status,200);assert.equal((await call(`assets/${id}/access`,{variant:'display'},b)).status,404);
  const content=await fetch(base+cap.data.url);assert.equal(content.status,200);assert.equal(content.headers.get('Content-Type'),'image/webp');const decoded=await sharp(Buffer.from(await content.arrayBuffer())).metadata();assert.equal(decoded.width,100);assert.equal(decoded.exif,undefined);
  assert.equal((await fetch(base+cap.data.url.replace(id,randomUUID()))).status,401);
  assert.equal((await fetch(base+`/api/v1/media/content/${id}?token=${a.accessToken}`)).status,401,'Access JWT cannot be used as media capability');
  const expired=await new SignJWT({uid:a.user.id,sid:'not-a-session',variant:'display'}).setProtectedHeader({alg:'HS256',typ:'JWT'}).setIssuer('stagelink-media').setAudience('stagelink-media-content').setSubject(id).setIssuedAt(Math.floor(Date.now()/1000)-120).setExpirationTime(Math.floor(Date.now()/1000)-60).sign(Buffer.from(config.AUTH_JWT_SECRET,'hex'));
  assert.equal((await fetch(base+`/api/v1/media/content/${id}?token=${expired}`)).status,401);
  const otherId=await upload(image,b);await processMediaBatch(deps,store);
  assert.equal((await call('me/portfolio',{kind:'artist',assetId:otherId,embedUrl:null,caption:'Foreign file',transcript:'',featured:false},a)).status,404);
  const item={kind:'artist',assetId:id,embedUrl:null,caption:'My real fixture performance photo',transcript:'A purple fixture image for integration testing.',featured:true};
  const saved=await call('me/portfolio',item,a);assert.equal(saved.status,200);const p=saved.data.items[0];
  assert.equal((await call(`assets/${id}/remove`,{},a)).status,409,'Referenced files cannot be deleted');
  assert.equal((await call(`me/portfolio/${p.id}`,{...item,caption:'Forged edit',revision:1},b,'PATCH')).status,404);
  assert.equal((await call(`me/portfolio/${p.id}`,{...item,revision:99},a,'PATCH')).status,409);
  assert.equal((await call('me/portfolio',{...item,assetId:null,embedUrl:'https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ'},a)).status,400);
  const linked=await call('me/portfolio',{...item,assetId:null,embedUrl:'https://youtu.be/dQw4w9WgXcQ',featured:false},a);assert.equal(linked.status,200);assert.ok(linked.data.items.some((p:any)=>p.embedUrl==='https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ'));
  await call(`me/portfolio/${p.id}/submit`,{revision:p.revision},a);const pending=await deps.db.portfolioItem.findUniqueOrThrow({where:{id:p.id}});
  assert.equal((await call('admin/media',undefined,a)).status,403);assert.ok((await call('admin/media',undefined,admin)).data.items.some((x:any)=>x.id===p.id));
  const decision={revision:pending.revision,approved:true,reason:'Integration review checked the submitted fixture media'};
  await deps.db.authUser.update({where:{id:a.user.id},data:{roles:['customer','artist','admin']}});await deps.db.authSession.updateMany({where:{userId:a.user.id},data:{activeRole:'admin'}});
  assert.equal((await call(`admin/media/${p.id}/decision`,decision,a)).status,403);await deps.db.authSession.updateMany({where:{userId:a.user.id},data:{activeRole:'artist'}});
  const decisions=await Promise.all([call(`admin/media/${p.id}/decision`,decision,admin),call(`admin/media/${p.id}/decision`,decision,admin)]);assert.deepEqual(decisions.map(x=>x.status).sort(),[200,409]);
  assert.equal((await call(`public/providers/${a.user.id}/artist/media`)).status,404,'Provider profile must also be approved');
  await deps.db.providerProfile.create({data:{userId:a.user.id,kind:'artist',displayName:'Fixture approved provider',bio:'Fixture',city:'Colombo',serviceRadiusKm:20,address:'private',category:'Singer',genres:[],experienceYears:1,baseRateMinor:0,equipmentCategories:[],operatingHours:[],rentalTerms:'',approvedRevision:1,approvedSnapshot:{}}});
  const publicItems=await call(`public/providers/${a.user.id}/artist/media`);assert.equal(publicItems.status,200);assert.equal(publicItems.data.items.length,1);
  const publicCap=await call(`public/media/${p.id}/access?variant=display`);assert.equal(publicCap.status,200);assert.equal((await fetch(base+publicCap.data.url)).status,200);
  const published=await deps.db.portfolioItem.findUniqueOrThrow({where:{id:p.id}});await call(`me/portfolio/${p.id}`,{...item,caption:'Private revised caption',revision:published.revision},a,'PATCH');
  assert.equal((await fetch(base+publicCap.data.url)).status,404,'Draft edit immediately invalidates public access');assert.equal((await call(`public/providers/${a.user.id}/artist/media`)).data.items.length,0);
  const avatar=await upload(image,a,'image/png','avatar');await processMediaBatch(deps,store);assert.equal((await call('me/avatar',{assetId:avatar},a,'PUT')).status,200);assert.equal((await call('me/assets',undefined,a)).data.avatarAssetId,avatar);assert.equal((await call(`assets/${avatar}/remove`,{},a)).status,409);await call('me/avatar',{assetId:null},a,'PUT');
  await deps.db.$transaction(tx=>holdAsset(tx,a.user.id,avatar,'fixture-case-'+suffix,new Date(Date.now()+86400000)));assert.equal((await call(`assets/${avatar}/remove`,{},a)).status,409);await deps.db.assetHold.deleteMany({where:{assetId:avatar}});
  const bad=await upload(Buffer.from('<script>wrong mime</script>'),a);await processMediaBatch(deps,store);assert.equal((await deps.db.asset.findUniqueOrThrow({where:{id:bad}})).status,'rejected');assert.equal((await call(`assets/${bad}/access`,{variant:'display'},a)).status,404);
  const mismatch=await intent(image,'image/png','avatar',a);assert.equal((await send(mismatch,Buffer.alloc(image.length,0),a)).status,400);assert.equal((await deps.db.asset.findUniqueOrThrow({where:{id:mismatch}})).status,'rejected');
  const equipment=await upload(image,renter,'image/png','equipment');await processMediaBatch(deps,store);assert.equal((await call('me/portfolio',{...item,kind:'renter',assetId:equipment},renter)).status,200);
  const wav=join(dir,'tone.wav'),mp4=join(dir,'motion.mp4');await exec('ffmpeg',['-nostdin','-v','error','-f','lavfi','-i','sine=frequency=440:duration=32','-y',wav]);await exec('ffmpeg',['-nostdin','-v','error','-f','lavfi','-i','color=c=purple:s=160x120:d=2','-c:v','libx264','-pix_fmt','yuv420p','-movflags','+faststart','-y',mp4]);
  const audio=await upload(await readFile(wav),a,'audio/wav'),video=await upload(await readFile(mp4),a,'video/mp4');
  await start();await until(async()=>await deps.db.asset.count({where:{id:{in:[audio,video]},status:'ready'}})===2);await stop();
  const sound=await deps.db.asset.findUniqueOrThrow({where:{id:audio}}),film=await deps.db.asset.findUniqueOrThrow({where:{id:video}});assert.equal((sound.metadata as any).waveform.length,80);assert.ok((sound.metadata as any).waveform.some((n:number)=>n>0));assert.equal((sound.metadata as any).previewDuration,30);assert.ok((film.metadata as any).duration>1);assert.ok('poster'in(film.variants as object));
  const checksum=createHash('sha256').update(await store.get(derivativeKey(audio,'preview'))).digest('hex');await start();await stop();assert.equal(createHash('sha256').update(await store.get(derivativeKey(audio,'preview'))).digest('hex'),checksum);assert.equal((await deps.db.asset.findUniqueOrThrow({where:{id:audio}})).attempts,sound.attempts);
  await deps.db.asset.update({where:{id:audio},data:{status:'processing',leaseOwner:randomUUID(),leaseUntil:new Date(Date.now()-1000)}});await start();await until(async()=>(await deps.db.asset.findUniqueOrThrow({where:{id:audio}})).status==='ready');await stop();
  const broken=new MediaStore({...config,S3_ENDPOINT:'http://127.0.0.1:1'});try{await deps.db.asset.update({where:{id:avatar},data:{status:'uploaded',availableAt:new Date(Date.now()-1000)}});await processMediaBatch(deps,broken);assert.equal((await deps.db.asset.findUniqueOrThrow({where:{id:avatar}})).status,'uploaded');}finally{broken.close();}await deps.db.asset.update({where:{id:avatar},data:{availableAt:new Date(Date.now()-1000)}});await processMediaBatch(deps,store);
  assert.equal((await call(`assets/${avatar}/remove`,{},a)).status,200);await deps.db.asset.update({where:{id:avatar},data:{deleteAfter:new Date(Date.now()-1000)}});await cleanupMediaBatch(deps,store);assert.equal((await deps.db.asset.findUniqueOrThrow({where:{id:avatar}})).status,'purged');await assert.rejects(store.get(originalKey(avatar)));
  await deps.db.asset.update({where:{id:bad},data:{status:'processing',attempts:5,leaseOwner:randomUUID(),leaseUntil:new Date(Date.now()-1000)}});await processMediaBatch(deps,store);assert.equal((await deps.db.asset.findUniqueOrThrow({where:{id:bad}})).status,'rejected','An interrupted final attempt must not remain stuck forever');
  const abandoned=await intent(image,'image/png','avatar',a);await deps.db.asset.update({where:{id:abandoned},data:{expiresAt:new Date(Date.now()-1000)}});await cleanupMediaBatch(deps,store);assert.equal((await deps.db.asset.findUniqueOrThrow({where:{id:abandoned}})).status,'purged');
  const lateCap=await call(`assets/${id}/access`,{variant:'display'},a);await call('auth/logout',{},a);assert.equal((await fetch(base+lateCap.data.url)).status,401,'Revoking a session also revokes its media capabilities');
 }finally{
  await stop();const assets=await deps.db.asset.findMany({where:{ownerId:{in:ids}}});for(const a of assets)for(const key of[originalKey(a.id),...['display','preview','poster'].map(v=>derivativeKey(a.id,v))])await store.remove(key).catch(()=>{});
  await deps.db.$transaction(async tx=>{await tx.profileAudit.deleteMany({where:{targetUserId:{in:ids}}});await tx.assetHold.deleteMany({where:{assetId:{in:assets.map(a=>a.id)}}});await tx.avatarBinding.deleteMany({where:{ownerId:{in:ids}}});await tx.portfolioItem.deleteMany({where:{ownerId:{in:ids}}});await tx.asset.deleteMany({where:{ownerId:{in:ids}}});await tx.authUser.deleteMany({where:{id:{in:ids}}});});
  store.close();await rm(dir,{recursive:true,force:true});await app.close();
 }
});
