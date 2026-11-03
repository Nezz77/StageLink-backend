import type {operations} from '../../packages/contracts/src/api';
import {accountClient,AccountError} from './auth';
type Result<K extends keyof operations>=operations[K] extends {responses:{200:{content:{'application/json':infer T}}}}?T:never;
type Input<K extends keyof operations>=operations[K] extends {requestBody:{content:{'application/json':infer T}}}?T:never;
export type Asset=Result<'MediaController_library'>['assets'][number];
export type PortfolioItem=Result<'MediaController_portfolio'>['items'][number];
export type MediaItemInput=Input<'MediaController_createItem'>;
export type MediaDecision=Input<'MediaController_decision'>;
export type Variant='display'|'preview'|'poster';
const api=<T>(path:string,body?:unknown,method?:'GET'|'POST'|'PUT'|'PATCH')=>accountClient.api<T>(path,body,method);
export const mediaClient={
 library:()=>api<Result<'MediaController_library'>>('me/assets'),
 portfolio:()=>api<Result<'MediaController_portfolio'>>('me/portfolio'),
 async upload(file:File,purpose:Asset['purpose'],onStage:(stage:string)=>void){
  const owner=accountClient.snapshot().user?.id;
  const check=()=>{if(!owner||accountClient.snapshot().user?.id!==owner)throw new AccountError('Your account changed. Reload before uploading.',409);};
  check();onStage('Checking file…');const bytes=await file.arrayBuffer();check();const hash=await crypto.subtle.digest('SHA-256',bytes);check();
  const sha256=Array.from(new Uint8Array(hash),b=>b.toString(16).padStart(2,'0')).join('');
  const asset=await api<Asset>('assets/uploads',{purpose,filename:file.name,mime:file.type,bytes:file.size,sha256});check();onStage('Uploading your file…');
  await accountClient.uploadBytes(`assets/${asset.id}/content`,file);check();onStage('Queuing validation…');await api(`assets/${asset.id}/finalize`,{});return asset.id;
 },
 finalize:(id:string)=>api<{message:string}>(`assets/${id}/finalize`,{}),
 remove:(id:string)=>api<{message:string}>(`assets/${id}/remove`,{}),
 avatar:(assetId:string|null)=>api<{message:string}>('me/avatar',{assetId},'PUT'),
 access:(id:string,variant:Variant)=>api<{url:string;expiresIn:60}>(`assets/${id}/access`,{variant}),
 saveItem:(input:MediaItemInput,id?:string,revision?:number)=>api<Result<'MediaController_portfolio'>>(id?`me/portfolio/${id}`:'me/portfolio',id?{...input,revision}:input,id?'PATCH':'POST'),
 itemAction:(id:string,revision:number,action:'submit'|'remove')=>api<Result<'MediaController_portfolio'>>(`me/portfolio/${id}/${action}`,{revision}),
 queue:()=>api<Result<'MediaController_queue'>>('admin/media'),
 review:(id:string,input:MediaDecision)=>api<{message:string}>(`admin/media/${id}/decision`,input),
 publicPortfolio:(userId:string,kind:'artist'|'renter')=>api<Result<'MediaContentController_publicPortfolio'>>(`public/providers/${userId}/${kind}/media`),
 publicAccess:(id:string,variant:Variant)=>api<{url:string;expiresIn:60}>(`public/media/${id}/access?variant=${variant}`),
};
