import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseEnv } from 'node:util';

test('local setup fills missing keys, preserves valid settings and never prints secrets', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'stagelink-env-'));
  try {
    await mkdir(resolve(root, 'backend/scripts'), { recursive: true });
    await mkdir(resolve(root, 'infra'));
    const script = resolve(root, 'backend/scripts/setup-env.mjs');
    await copyFile(resolve('scripts/setup-env.mjs'), script);
    const run = () => execFileSync(process.execPath, [script], { encoding: 'utf8' });
    const read = (file: string) => readFile(resolve(root, file), 'utf8');
    const output = run();
    await assert.rejects(stat(resolve(root, '.env.local')), { code: 'ENOENT' });
    const first = await read('infra/.env'), host = parseEnv(await read('backend/.env'));
    const keys = parseEnv(first);
    for (const name of ['AUTH_JWT_SECRET', 'AUTH_MAIL_KEY', 'PAYOUT_DATA_KEY']) {
      assert.match(keys[name]!, /^[0-9a-f]{64}$/);
      assert.equal(keys[name], host[name]);
      assert.ok(!output.includes(keys[name]!));
    }
    assert.notEqual(keys.AUTH_JWT_SECRET, keys.AUTH_MAIL_KEY);
    assert.equal((await stat(resolve(root, 'infra/.env'))).mode & 0o777, 0o600);
    run();
    assert.equal(await read('infra/.env'), first);
    // Upgrade an old configuration without replacing credentials or custom settings.
    await writeFile(resolve(root, 'backend/.env'), "WEB_ORIGIN='http://localhost:8443'\nAUTH_JWT_SECRET=\nAUTH_MAIL_KEY=\nCUSTOM_SETTING=keep-me\n");
    run();
    const upgraded = parseEnv(await read('backend/.env'));
    assert.equal(upgraded.WEB_ORIGIN, 'http://localhost:8443');
    assert.equal(upgraded.CUSTOM_SETTING, 'keep-me');
    assert.equal(upgraded.AUTH_JWT_SECRET, keys.AUTH_JWT_SECRET);
    // Existing mismatches are reported without silently rotating either side.
    const different = 'ab'.repeat(32);
    await writeFile(resolve(root, 'backend/.env'), (await read('backend/.env')).replace(keys.AUTH_JWT_SECRET!, different));
    const warning = run();
    assert.match(warning, /differs between configurations/);
    assert.ok(!warning.includes(different));
    assert.equal(parseEnv(await read('backend/.env')).AUTH_JWT_SECRET, different);
    assert.equal(parseEnv(await read('infra/.env')).AUTH_JWT_SECRET, keys.AUTH_JWT_SECRET);
  } finally { await rm(root, { recursive: true, force: true }); }
});
