import { useSyncExternalStore } from 'react';
import { accountClient } from './auth';
export function useAccount() {
  const state = useSyncExternalStore(accountClient.subscribe, accountClient.snapshot);
  return state;
}
