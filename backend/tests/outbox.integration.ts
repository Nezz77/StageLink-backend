import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { createApp } from '../api/src/app.js';
import { checkReleaseReadiness, releaseReadinessConfig } from '../scripts/release-readiness-check.js';
import { readConfig } from '../shared/config.js';
import { resources, closeResources, MIGRATION, readiness } from '../shared/resources.js';
import { consume, dispatchBatch, insertPing, QUEUE } from '../shared/outbox.js';

const config = readConfig();
if (config.NODE_ENV !== 'test' || !new URL(config.DATABASE_URL).pathname.endsWith('_test')) {
  throw new Error('Integration tests require NODE_ENV=test and a dedicated *_test database');
}
async function until(check: () => Promise<boolean>, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await new Promise(r => setTimeout(r, 100)); }
  throw new Error('Timed out waiting for integration condition');
}
test('database readiness requires the built schema and blocks an unfinished migration until rollback', async () => {
  const deps = resources(config);
  const failedId = randomUUID();
  const newerId = randomUUID();
  const migration = '29991231235959_readiness_fixture';
  const checksum = '0'.repeat(64);
  const ready = { status: 'ready', dependencies: { postgres: 'up', redis: 'up' }, schemaVersion: MIGRATION };
  const unavailable = { status: 'unavailable', dependencies: { postgres: 'down', redis: 'up' }, schemaVersion: null };
  try {
    assert.deepEqual(await readiness(deps), ready);
    await deps.db.$executeRaw`
      INSERT INTO _prisma_migrations (id, checksum, migration_name, logs)
      VALUES (${failedId}, ${checksum}, ${migration}, 'Synthetic migration failure')
    `;
    assert.deepEqual(await readiness(deps), unavailable);

    await deps.db.$executeRaw`
      UPDATE _prisma_migrations SET rolled_back_at = clock_timestamp() WHERE id = ${failedId}
    `;
    assert.deepEqual(await readiness(deps), ready);

    await deps.db.$executeRaw`
      INSERT INTO _prisma_migrations (id, checksum, migration_name, finished_at)
      VALUES (${newerId}, ${checksum}, ${migration}, clock_timestamp())
    `;
    assert.deepEqual(await readiness(deps), unavailable);
  } finally {
    try {
      await deps.db.$executeRaw`DELETE FROM _prisma_migrations WHERE id IN (${failedId}, ${newerId})`;
    } finally { await closeResources(deps); }
  }
});

test('migrations, transactional outbox, recovery, duplicate delivery and actual worker restart', { timeout: 90000 }, async () => {
  const deps = resources(config);
  const connection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 1 });
  const queue = new Queue(QUEUE, { connection, defaultJobOptions: { removeOnComplete: true, removeOnFail: true } });
  const ids: string[] = [];
  let worker: ChildProcess | undefined;
  let app: Awaited<ReturnType<typeof createApp>>['app'] | undefined;
  async function stopWorker() {
    if (worker && worker.exitCode === null) {
      const exited = once(worker, 'exit'); worker.kill('SIGTERM'); await exited;
    }
    worker = undefined;
  }
  const healthUrl = `http://127.0.0.1:${process.env.WORKER_HEALTH_PORT ?? '14001'}`;
  async function startWorker(healthPath = 'ready') {
    worker = spawn(process.execPath, ['dist/worker/src/main.js'], {
      env: { ...process.env, WORKER_HEALTH_PORT: process.env.WORKER_HEALTH_PORT ?? '14001' }, stdio: 'ignore',
    });
    await until(async () => {
      try { return (await fetch(`${healthUrl}/health/${healthPath}`)).status === 200; }
      catch { return false; }
    });
  }
  try {
    assert.equal((await readiness(deps)).status, 'ready');
    // Check actual refused connections, not only mocked health responses.
    for (const failure of ['postgres', 'redis'] as const) {
      const broken = resources({ ...config,
        DATABASE_URL: failure === 'postgres' ? 'postgresql://unused:unused@127.0.0.1:1/unavailable' : config.DATABASE_URL,
        REDIS_URL: failure === 'redis' ? 'redis://127.0.0.1:1' : config.REDIS_URL,
      });
      try {
        const result = await readiness(broken);
        assert.equal(result.status, 'unavailable');
        assert.equal(result.dependencies[failure], 'down');
        assert.equal(result.dependencies[failure === 'postgres' ? 'redis' : 'postgres'], 'up');
      } finally { await closeResources(broken); }
    }
    const rolledBack = randomUUID();
    await assert.rejects(deps.db.$transaction(async tx => {
      await tx.outboxEvent.create({ data: { id: rolledBack, topic: 'foundation.ping.v1', payload: { version: 1 } } });
      throw new Error('roll back');
    }));
    assert.equal(await deps.db.outboxEvent.count({ where: { id: rolledBack } }), 0);

    const first = await deps.db.$transaction(insertPing); ids.push(first.id);
    await until(async () => {
      await dispatchBatch(deps.db, { add: async () => { throw new Error('queue offline'); } });
      return (await deps.db.outboxEvent.findUniqueOrThrow({ where: { id: first.id } })).lastErrorCode === 'QUEUE_UNAVAILABLE';
    });
    assert.equal((await deps.db.outboxEvent.findUniqueOrThrow({ where: { id: first.id } })).processedAt, null);
    await deps.db.outboxEvent.update({ where: { id: first.id }, data: { lockedUntil: null } });
    // Delivery is asynchronous; allow timestamp precision and normal relay scheduling.
    await until(async () => {
      await dispatchBatch(deps.db, queue);
      return Boolean(await queue.getJob(first.id));
    });
    assert.ok(await queue.getJob(first.id));
    // Simulate Redis loss after publication. DB remains authority and republishes.
    await (await queue.getJob(first.id))!.remove();
    await deps.db.outboxEvent.update({ where: { id: first.id }, data: { lockedUntil: null } });
    // Delivery is asynchronous; allow timestamp precision and normal relay scheduling.
    await until(async () => {
      await dispatchBatch(deps.db, queue);
      return Boolean(await queue.getJob(first.id));
    });
    await startWorker();
    await until(async () => (await deps.db.foundationReceipt.count({ where: { eventId: first.id } })) === 1);
    app = (await createApp(config)).app;
    await app.listen(0, '127.0.0.1');
    const releaseConfig = releaseReadinessConfig({
      STAGELINK_RELEASE_API_ORIGIN: await app.getUrl(),
      STAGELINK_RELEASE_WORKER_ORIGIN: `http://127.0.0.1:${process.env.WORKER_HEALTH_PORT ?? '14001'}`,
    });
    assert.equal((await checkReleaseReadiness(releaseConfig)).passed, true);
    const driftId = randomUUID();
    try {
      await deps.db.$executeRaw`
        INSERT INTO _prisma_migrations (id, checksum, migration_name, logs)
        VALUES (${driftId}, ${'0'.repeat(64)}, '29991231235959_release_fixture', 'Synthetic release test')
      `;
      const blocked = await checkReleaseReadiness(releaseConfig);
      assert.equal(blocked.passed, false);
      assert.deepEqual(blocked.checks.map(row => row.httpStatus), [503, 503]);
    } finally {
      await deps.db.$executeRaw`DELETE FROM _prisma_migrations WHERE id = ${driftId}`;
    }
    assert.equal((await checkReleaseReadiness(releaseConfig)).passed, true);
    await stopWorker();

    // Commit while worker is stopped; persisted event is consumed after process restart.
    const second = await deps.db.$transaction(insertPing); ids.push(second.id);
    await startWorker();
    await until(async () => (await deps.db.foundationReceipt.count({ where: { eventId: second.id } })) === 1);
    await stopWorker();
    await Promise.all(Array.from({ length: 8 }, () => consume(deps.db, second.id)));
    assert.equal(await deps.db.foundationReceipt.count({ where: { eventId: second.id } }), 1);
    assert.equal(await deps.db.consumedEvent.count({ where: { eventId: second.id } }), 1);

    // Competing first deliveries, before any worker has consumed this event.
    const concurrent = await deps.db.$transaction(insertPing); ids.push(concurrent.id);
    await Promise.all(Array.from({ length: 8 }, () => consume(deps.db, concurrent.id)));
    assert.equal(await deps.db.foundationReceipt.count({ where: { eventId: concurrent.id } }), 1);
    assert.equal(await deps.db.consumedEvent.count({ where: { eventId: concurrent.id } }), 1);


    const invalid = await deps.db.outboxEvent.create({ data: { topic: 'unknown.v1', payload: {} } }); ids.push(invalid.id);
    await consume(deps.db, invalid.id);
    const rejected = await deps.db.outboxEvent.findUniqueOrThrow({ where: { id: invalid.id } });
    assert.ok(rejected.deadLetteredAt); assert.equal(rejected.processedAt, null);
    assert.equal(await deps.db.foundationReceipt.count({ where: { eventId: invalid.id } }), 0);

    const blockedSchema = randomUUID();
    const redisJob = await deps.db.$transaction(insertPing); ids.push(redisJob.id);
    const scheduled = await deps.db.$transaction(insertPing); ids.push(scheduled.id);
    const guardedIds = [redisJob.id, scheduled.id];
    try {
      await deps.db.$executeRaw`
        INSERT INTO _prisma_migrations (id, checksum, migration_name, logs)
        VALUES (${blockedSchema}, ${'0'.repeat(64)}, '29991231235959_worker_fixture', 'Synthetic worker migration failure')
      `;
      await queue.add('deliver', { eventId: redisJob.id }, { jobId: redisJob.id, attempts: 1 });
      await startWorker('live');
      await until(async () => {
        const queued = await queue.getJob(redisJob.id);
        return Boolean(queued && queued.attemptsStarted >= 2 && await queued.getState() === 'delayed');
      });
      assert.equal((await fetch(healthUrl + '/health/ready')).status, 503);
      assert.equal((await queue.getJob(redisJob.id))?.attemptsMade, 0);
      assert.equal(await queue.getJob(scheduled.id), undefined);
      assert.equal(await deps.db.foundationReceipt.count({ where: { eventId: { in: guardedIds } } }), 0);
    } finally {
      await deps.db.$executeRaw`DELETE FROM _prisma_migrations WHERE id = ${blockedSchema}`;
    }
    await until(async () => (await deps.db.foundationReceipt.count({ where: { eventId: { in: guardedIds } } })) === 2);
    await until(async () => (await fetch(healthUrl + '/health/ready')).status === 200);
  } finally {
    await stopWorker();
    await app?.close();
    // Only remove this test's records; never flush a shared Redis or DB.
    for (const id of ids) { const job = await queue.getJob(id); if (job) await job.remove(); }
    await deps.db.foundationReceipt.deleteMany({ where: { eventId: { in: ids } } });
    await deps.db.consumedEvent.deleteMany({ where: { eventId: { in: ids } } });
    await deps.db.outboxEvent.deleteMany({ where: { id: { in: ids } } });
    await queue.close(); await connection.quit(); await closeResources(deps);
  }
});
