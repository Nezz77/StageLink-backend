import type { Prisma } from '../generated/prisma/client.js';

// Sample after acquiring business locks: transaction-start time can be stale after a wait.
export async function databaseNow(db: Pick<Prisma.TransactionClient, '$queryRaw'>): Promise<Date> {
  const [clock] = await db.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
  if (!clock) throw new Error('DATABASE_CLOCK_UNAVAILABLE');
  return clock.now;
}
