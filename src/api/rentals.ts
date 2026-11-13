import type { operations } from '../../packages/contracts/src/api';
import { accountClient } from './auth';

type Create = operations['RentalsController_create'];
export type RentalFields = Create['requestBody']['content']['application/json'];
export type Rental = Create['responses'][200]['content']['application/json'];
export type RentalPage = operations['PublicRentalsController_list']['responses'][200]['content']['application/json'];

export const rentalClient = {
  list: () => accountClient.api<Rental[]>('me/rentals'),
  create: (fields: RentalFields) => accountClient.api<Rental>('me/rentals', fields),
  edit: (id: string, revision: number, fields: RentalFields) =>
    accountClient.api<Rental>(`me/rentals/${id}`, { ...fields, revision }, 'PATCH'),
  transition: (id: string, revision: number, action: 'publish' | 'pause' | 'archive') =>
    accountClient.api<Rental>(`me/rentals/${id}/status`, { revision, action }),
};

export async function readRentals(cursor: string | null, signal: AbortSignal): Promise<RentalPage> {
  const query = cursor ? '?cursor=' + encodeURIComponent(cursor) : '';
  try {
    const response = await fetch('/api/v1/rentals' + query, {
      credentials: 'omit', signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
    });
    if (!response.ok) throw new Error();
    return await response.json() as RentalPage;
  } catch {
    throw new Error('Could not load the equipment catalog. Please try again.');
  }
}
