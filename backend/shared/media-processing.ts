import sharp from 'sharp';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import type {Resources} from './resources.js';
import type {Asset,Prisma} from '../generated/prisma/client.js';
import {MediaStore,originalKey,derivativeKey} from './media-store.js';
const exec=promisify(execFile);
export class InvalidMedia extends Error {}
export type Derived={variants:Record<string,{mime:string;bytes:Buffer}>;metadata:Record<string,number|number[]>};
function magic(b:Buffer,mime:string){
 if(mime==='image/jpeg')return b.subarray(0,3).equals(Buffer.from([255,216,255]));
 if(mime==='image/png')return b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
 if(mime==='image/webp')return b.toString('ascii',0,4)==='RIFF'&&b.toString('ascii',8,12)==='WEBP';
 if(mime==='audio/wav')return b.toString('ascii',0,4)==='RIFF'&&b.toString('ascii',8,12)==='WAVE';
 if(mime==='audio/mpeg')return b.toString('ascii',0,3)==='ID3'||(b[0]===255&&(b[1]!&224)===224);
 if(mime==='video/mp4')return b.toString('ascii',4,8)==='ftyp';
 if(mime==='video/webm')return b.subarray(0,4).equals(Buffer.from([26,69,223,163]));
 return false;
}
async function mediaCommand(program:string,args:string[],timeout=45000,maxBuffer=1024*1024){
 try{return await exec(program,args,{timeout,maxBuffer,windowsHide:true,env:{PATH:process.env.PATH,HOME:tmpdir()}});}catch{throw new InvalidMedia('The media could not be decoded within processing limits.');}
}
export async function deriveMedia(input:Buffer,mime:string):Promise<Derived>{
 if(!magic(input,mime))throw new InvalidMedia('File contents do not match the selected file type.');
 if(mime.startsWith('image/')){
  try{
   const image=sharp(input,{limitInputPixels:16_000_000,failOn:'warning'}).timeout({seconds:5}),meta=await image.metadata();
   if(meta.pages&&meta.pages!==1)throw Error();
   if(meta.format!==({'image/jpeg':'jpeg','image/png':'png','image/webp':'webp'}as Record<string,string>)[mime])throw Error();
   const display=await image.rotate().resize(1600,1600,{fit:'inside',withoutEnlargement:true}).webp({quality:82}).toBuffer({resolveWithObject:true});
   const poster=await sharp(display.data).resize(360,360,{fit:'inside',withoutEnlargement:true}).webp({quality:75}).toBuffer();
   return{metadata:{width:display.info.width,height:display.info.height},variants:{display:{mime:'image/webp',bytes:display.data},poster:{mime:'image/webp',bytes:poster}}};
  }catch{throw new InvalidMedia('Use a single JPEG, PNG or WebP image of at most 16 megapixels.');}
 }
 const dir=await mkdtemp(join(tmpdir(),'stagelink-media-'));
 try{
  const file=join(dir,'input'),video=mime.startsWith('video/');await writeFile(file,input,{mode:0o600});
  const demux=mime==='audio/wav'?'wav':mime==='audio/mpeg'?'mp3':mime==='video/mp4'?'mov':'matroska';
  const inputArgs=['-protocol_whitelist','file,pipe','-f',demux,...(demux==='mov'?['-enable_drefs','0','-use_absolute_path','0']:[])];
  const probe=JSON.parse((await mediaCommand('ffprobe',['-v','error',...inputArgs,'-show_format','-show_streams','-of','json',file],10000)).stdout);
  const duration=Number(probe.format?.duration),streams=probe.streams as any[];
  if(!Number.isFinite(duration)||duration<=0||duration>600||!Array.isArray(streams)||streams.length>8)throw new InvalidMedia('Use media with a readable duration of at most 10 minutes.');
  const stream=streams.find(s=>s.codec_type===(video?'video':'audio'));
  if(!stream||video&&(!stream.width||!stream.height||stream.width*stream.height>9_000_000))throw new InvalidMedia('Unsupported media dimensions or track.');
  const output=join(dir,video?'preview.mp4':'preview.mp3');
  const common=['-nostdin','-v','error','-threads','2',...inputArgs,'-i',file,'-t','30','-map_metadata','-1','-map_chapters','-1','-threads','2'];
  await mediaCommand('ffmpeg',[...common,...(video?['-map','0:v:0','-map','0:a:0?','-vf',"scale='min(640,iw)':-2",'-filter_threads','1','-r','25','-c:v','libx264','-preset','veryfast','-crf','26','-c:a','aac','-b:a','96k','-movflags','+faststart']:['-map','0:a:0','-ac','2','-ar','44100','-c:a','libmp3lame','-b:a','128k']),'-fs','8388608','-y',output]);
  const preview=await readFile(output);const p=JSON.parse((await mediaCommand('ffprobe',['-v','error','-show_format','-of','json',output],10000)).stdout);const previewDuration=Number(p.format?.duration);
  if(!Number.isFinite(previewDuration)||previewDuration<=0||previewDuration>30.2)throw new InvalidMedia('The preview could not be generated.');
  const variants:Derived['variants']={preview:{mime:video?'video/mp4':'audio/mpeg',bytes:preview}},metadata:Derived['metadata']={duration,previewDuration:Math.min(30,previewDuration)};
  if(video){const posterFile=join(dir,'poster.png');await mediaCommand('ffmpeg',['-nostdin','-v','error','-threads','2','-protocol_whitelist','file,pipe','-i',output,'-frames:v','1','-threads','1','-y',posterFile],10000);variants.poster={mime:'image/webp',bytes:await sharp(await readFile(posterFile)).webp({quality:75}).toBuffer()};metadata.width=stream.width;metadata.height=stream.height;}
  else{
   const pcmFile=join(dir,'samples');await mediaCommand('ffmpeg',['-nostdin','-v','error','-threads','2','-protocol_whitelist','file,pipe','-i',output,'-t','30','-map','0:a:0','-ac','1','-ar','8000','-f','s16le','-y',pcmFile],10000);
   const pcm=await readFile(pcmFile),count=Math.floor(pcm.length/2),waveform:number[]=[];
   for(let bin=0;bin<80;bin++){let peak=0;for(let i=Math.floor(bin*count/80);i<Math.floor((bin+1)*count/80);i++)peak=Math.max(peak,Math.abs(pcm.readInt16LE(i*2))/32768);waveform.push(Math.round(peak*1000)/1000);}metadata.waveform=waveform;
  }
  return{variants,metadata};
 }finally{await rm(dir,{recursive:true,force:true});}
}
export async function processMediaBatch(deps:Resources,store:MediaStore){
 await deps.db.$executeRaw`UPDATE assets SET status='rejected', reason='Processing was interrupted too many times. Upload the file again.', lease_owner=NULL, lease_until=NULL, delete_after=now()+interval '24 hours' WHERE status='processing' AND attempts>=5 AND lease_until<now()`;
 const lease=randomUUID();const clock=await deps.db.$queryRaw<Array<{now:Date}>>`SELECT clock_timestamp() AS now`;const now=clock[0]!.now;
 const rows=await deps.db.$queryRaw<Asset[]>`UPDATE assets SET status='processing',lease_owner=${lease}::uuid,lease_until=now()+interval '3 minutes',attempts=attempts+1 WHERE id=(SELECT id FROM assets WHERE (status='uploaded' OR (status='processing' AND lease_until<now())) AND available_at<=now() AND attempts<5 ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING id`;
 if(!rows[0])return false;const asset=await deps.db.asset.findUniqueOrThrow({where:{id:rows[0].id}});
 try{
  const original=await store.get(originalKey(asset.id));
  if(original.length!==asset.bytes||createHash('sha256').update(original).digest('hex')!==asset.sha256)throw new InvalidMedia('Stored file integrity check failed.');
  const derived=await deriveMedia(original,asset.mime),variants:Record<string,{mime:string;bytes:number}>={};
  for(const [key,value]of Object.entries(derived.variants)){await store.put(derivativeKey(asset.id,key),value.bytes,value.mime);variants[key]={mime:value.mime,bytes:value.bytes.length};}
  await deps.db.asset.updateMany({where:{id:asset.id,status:'processing',leaseOwner:lease},data:{status:'ready',variants,metadata:derived.metadata,leaseOwner:null,leaseUntil:null,reason:null}});
 }catch(error){
  const rejected=error instanceof InvalidMedia||asset.attempts>=5;
  await deps.db.asset.updateMany({where:{id:asset.id,status:'processing',leaseOwner:lease},data:{status:rejected?'rejected':'uploaded',reason:error instanceof InvalidMedia?error.message:rejected?'Storage processing failed. Upload the file again.':null,availableAt:new Date(now.getTime()+Math.min(60000,1000*2**asset.attempts)),leaseOwner:null,leaseUntil:null,...(rejected?{deleteAfter:new Date(Date.now()+86400000)}:{})}});
 }
 return true;
}
// An internal caller must first authorize the owning business record, then hold in the same transaction.
export async function holdAsset(tx:Prisma.TransactionClient,ownerId:string,assetId:string,reference:string,until:Date){
 await tx.$queryRaw`SELECT id FROM assets WHERE id=${assetId}::uuid FOR UPDATE`;
 const asset=await tx.asset.findUnique({where:{id:assetId}});if(!asset||asset.ownerId!==ownerId||asset.status!=='ready'||until<=new Date())throw Error('Asset cannot be retained');
 return tx.assetHold.create({data:{assetId,reference,until}});
}
export async function cleanupMediaBatch(deps:Resources,store:MediaStore){
 const candidates=await deps.db.asset.findMany({where:{OR:[{status:{in:['pending','uploading','staged']},expiresAt:{lt:new Date()}},{status:{in:['deleted','rejected']},deleteAfter:{lt:new Date()}}]},take:5,orderBy:{createdAt:'asc'}});
 for(const candidate of candidates)await deps.db.$transaction(async tx=>{
  await tx.$queryRaw`SELECT id FROM assets WHERE id=${candidate.id}::uuid FOR UPDATE`;
  const a=await tx.asset.findUniqueOrThrow({where:{id:candidate.id}});
  if(!(['pending','uploading','staged'].includes(a.status)&&a.expiresAt<new Date()||['deleted','rejected'].includes(a.status)&&a.deleteAfter&&a.deleteAfter<new Date()))return;
  if(await tx.assetHold.count({where:{assetId:a.id,until:{gt:new Date()}}})||await tx.portfolioItem.count({where:{assetId:a.id}})||await tx.avatarBinding.count({where:{assetId:a.id}})||await tx.bookingMessageAttachment.count({where:{assetId:a.id}})||await tx.bookingDisputeAttachment.count({where:{assetId:a.id}})||await tx.supportAttachment.count({where:{assetId:a.id}})||await tx.verificationDocument.count({where:{assetId:a.id}})||await tx.equipmentInspectionPhoto.count({where:{assetId:a.id}})||await tx.bookingReviewPhoto.count({where:{assetId:a.id}}))return;
  for(const keyofasset of [originalKey(a.id),...['display','preview','poster'].map(v=>derivativeKey(a.id,v))])await store.remove(keyofasset);
  await tx.asset.update({where:{id:a.id},data:{status:'purged',variants:{},metadata:{},reason:null,leaseOwner:null,leaseUntil:null}});
 },{timeout:60000});
}
