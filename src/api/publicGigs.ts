import type { operations } from '../../packages/contracts/src/api';

type Result<K extends 'list' | 'detail'> = operations[`PublicGigsController_${K}`]['responses'][200]['content']['application/json'];
export type PublicGig = Result<'detail'>;
export type PublicGigPage = Result<'list'>;

async function read<T>(path: string, signal: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch('/api/v1/listings' + path, { credentials: 'omit', signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]) });
  } catch {
    throw new Error('Could not connect to the artist catalog. Please try again.');
  }
  if (response.status === 404) throw new Error('This gig is no longer available.');
  if (!response.ok) throw new Error('Could not load the artist catalog. Please try again.');
  try {
    return await response.json() as T;
  } catch {
    throw new Error('Could not read the artist catalog. Please try again.');
  }
}

export const publicGigClient = {
  list: (cursor: string | null, signal: AbortSignal) =>
    read<PublicGigPage>(cursor ? '?cursor=' + encodeURIComponent(cursor) : '', signal),
  detail: (id: string, signal: AbortSignal) =>
    read<PublicGig>('/' + encodeURIComponent(id), signal),
};
