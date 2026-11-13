import {z} from 'zod';
export const mime=z.enum(['image/jpeg','image/png','image/webp','audio/mpeg','audio/wav','video/mp4','video/webm']);
export const purpose=z.enum(['avatar','portfolio','equipment','evidence','chat','review','inspection','verification']);
export const upload=z.object({purpose,filename:z.string().trim().min(1).max(120).regex(/^[^\x00-\x1f\x7f/\\]+$/),mime,bytes:z.number().int().positive().max(40*1024*1024),sha256:z.string().regex(/^[0-9a-f]{64}$/)}).strict().superRefine((v,ctx)=>{
 const limit=v.purpose==='verification'?5:v.mime.startsWith('image/')?8:v.mime.startsWith('audio/')?20:40;
 if(v.bytes>limit*1024*1024)ctx.addIssue({code:'custom',path:['bytes'],message:'File too large'});
 if(['avatar','equipment','evidence','chat','review','inspection','verification'].includes(v.purpose)&&!v.mime.startsWith('image/'))ctx.addIssue({code:'custom',path:['mime'],message:'Images required for this purpose'});
});
export const metadata=z.object({width:z.number().int().positive().optional(),height:z.number().int().positive().optional(),duration:z.number().positive().optional(),previewDuration:z.number().positive().max(30).optional(),waveform:z.array(z.number().min(0).max(1)).max(80).optional()});
export const variant=z.enum(['display','preview','poster']);
export const asset=z.object({id:z.string().uuid(),purpose,status:z.enum(['pending','uploading','staged','uploaded','processing','ready','rejected','deleted','purged']),filename:z.string(),mime,bytes:z.number(),reason:z.string().nullable(),createdAt:z.string(),metadata,variants:z.array(variant)});
export const library=z.object({assets:z.array(asset),avatarAssetId:z.string().uuid().nullable()});
export const message=z.object({message:z.string()});
export const empty=z.object({}).strict();
export const revision=z.object({revision:z.number().int().positive()}).strict();
export const access=z.object({variant}).strict();
export const accessRead=z.object({url:z.string(),expiresIn:z.literal(60)});
export const avatarBody=z.object({assetId:z.string().uuid().nullable()}).strict();
export const itemWrite=z.object({kind:z.enum(['artist','renter']),assetId:z.string().uuid().nullable(),embedUrl:z.string().max(500).nullable(),caption:z.string().trim().min(1).max(240),transcript:z.string().trim().max(4000),featured:z.boolean()}).strict();
export const itemPatch=itemWrite.extend({revision:z.number().int().positive()}).strict();
export const item=z.object({id:z.string().uuid(),kind:z.enum(['artist','renter']),assetId:z.string().uuid().nullable(),embedUrl:z.string().nullable(),caption:z.string(),transcript:z.string(),featured:z.boolean(),revision:z.number(),status:z.enum(['draft','pending','approved','rejected']),reason:z.string().nullable(),updatedAt:z.string(),asset:asset.nullable()});
export const portfolio=z.object({items:z.array(item)});
export const review=z.object({revision:z.number().int().positive(),approved:z.boolean(),reason:z.string().trim().min(10).max(2000)}).strict();
export const reviewQueue=z.object({items:z.array(item.extend({ownerId:z.string().uuid(),ownerName:z.string()}))});
export function canonicalEmbed(raw:string){
 let u:URL;try{u=new URL(raw);}catch{throw Error('Use a YouTube or Vimeo video URL.');}
 if(u.protocol!=='https:'||u.username||u.password||u.port)throw Error('Use an HTTPS YouTube or Vimeo video URL.');
 let id:string|null=null;
 if(['youtube.com','www.youtube.com','m.youtube.com'].includes(u.hostname)&&u.pathname==='/watch')id=u.searchParams.get('v');
 else if(u.hostname==='youtu.be'&&u.pathname.split('/').length===2)id=u.pathname.slice(1);
 if(['www.youtube-nocookie.com'].includes(u.hostname)&&/^\/embed\/[\w-]{11}$/.test(u.pathname))id=u.pathname.split('/')[2]!;
 if(u.hostname==='player.vimeo.com'&&/^\/video\/[0-9]{6,12}$/.test(u.pathname))return 'https://player.vimeo.com'+u.pathname;
 if(id&&/^[\w-]{11}$/.test(id))return 'https://www.youtube-nocookie.com/embed/'+id;
 if(['vimeo.com','www.vimeo.com'].includes(u.hostname)&&/^\/[0-9]{6,12}$/.test(u.pathname))return 'https://player.vimeo.com/video/'+u.pathname.slice(1);
 throw Error('Use a normal YouTube watch/share URL or a Vimeo video URL.');
}
