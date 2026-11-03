import type { operations } from '../../packages/contracts/src/api';
import { accountClient } from './auth';
type Result<K extends keyof operations> = operations[K] extends {responses:{200:{content:{'application/json':infer T}}}} ? T : never;
type Input<K extends keyof operations> = operations[K] extends {requestBody:{content:{'application/json':infer T}}} ? T : never;
export type WorkspaceTab = 'profile'|'provider'|'payout'|'review'|'media';
export type ProviderKind = 'artist'|'renter';
export type MemberProfile = Result<'ProfilesController_profile'>;
export type MemberInput = Input<'ProfilesController_saveProfile'>;
export type Provider = NonNullable<Result<'ProfilesController_provider'>['profile']>;
export type ProviderInput = Input<'ProfilesController_saveProvider'>;
export type Destination = NonNullable<Result<'ProfilesController_payout'>['destination']>;
export type ReviewQueue = Result<'ProfilesController_queue'>;
export type Decision = Input<'ProfilesController_reviewPayout'>;
export type PublicProvider = Result<'PublicProfilesController_publicProfile'>;
const api = <T>(path:string,body?:unknown,method?:'GET'|'POST'|'PUT') => accountClient.api<T>(path,body,method);
export const profileClient = {
  member:()=>api<MemberProfile>('me/profile'),
  async saveMember(data:MemberInput){const saved=await api<MemberProfile>('me/profile',data,'PUT');await accountClient.me();return saved;},
  provider:(kind:ProviderKind)=>api<{profile:Provider|null}>('me/providers/'+kind),
  saveProvider:(kind:ProviderKind,data:ProviderInput)=>api<{profile:Provider|null}>('me/providers/'+kind,data,'PUT'),
  submitProvider:(kind:ProviderKind,revision:number)=>api<{profile:Provider|null}>(`me/providers/${kind}/submit`,{revision}),
  publicProvider:(userId:string,kind:ProviderKind)=>api<PublicProvider>(`public/providers/${userId}/${kind}`),
  payout:()=>api<{destination:Destination|null}>('me/payout-destination'),
  savePayout:(data:Input<'ProfilesController_savePayout'>)=>api<{destination:Destination|null}>('me/payout-destination',data,'PUT'),
  pendingEmail:()=>api<Result<'ProfilesController_emailChange'>>('me/email-change'),
  requestEmail:(email:string,password:string)=>api<{message:string}>('me/email-change',{email,password}),
  cancelEmail:()=>api<{message:string}>('me/email-change/cancel',{}),
  queue:()=>api<ReviewQueue>('admin/onboarding'),
  reviewProvider:(userId:string,kind:ProviderKind,decision:Decision)=>api<{message:string}>(`admin/providers/${userId}/${kind}/decision`,decision),
  reviewPayout:(userId:string,decision:Decision)=>api<{message:string}>(`admin/payout-destinations/${userId}/decision`,decision),
};
export {lkrToMinor} from '../lib/profileMoney';
