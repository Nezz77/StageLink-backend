import type { operations } from '../../packages/contracts/src/api';
import { accountClient } from './auth';

type Create = operations['GigsController_create'];
type Fields = Create['requestBody']['content']['application/json'];
export type Gig = Create['responses'][200]['content']['application/json'];

export const gigClient = {
  list: () => accountClient.api<Gig[]>('me/gigs'),
  create: (fields: Fields) => accountClient.api<Gig>('me/gigs', fields),
  edit: (id: string, revision: number, fields: Fields) =>
    accountClient.api<Gig>(`me/gigs/${id}`, { ...fields, revision }, 'PATCH'),
  transition: (id: string, revision: number, action: 'publish' | 'pause' | 'archive') =>
    accountClient.api<Gig>(`me/gigs/${id}/status`, { revision, action }),
};
