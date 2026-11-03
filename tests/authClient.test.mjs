import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountClient } from '../src/api/auth.ts';
const user = id => ({ id, email: id + '@stagelink.test', displayName: id, roles: ['customer'], activeRole: 'customer', emailVerified: false, createdAt: '2026-11-02T00:00:00Z' });
const session = id => ({ accessToken: 'fixture-token-' + id, csrfToken: 'fixture-csrf', expiresIn: 600, user: user(id) });
const response = (data, status = 200) => Response.json(data, { status });
async function mocked(fetcher, run) { const original = globalThis.fetch; globalThis.fetch = fetcher; try { await run(); } finally { globalThis.fetch = original; } }
test('unavailable account services stay unavailable and never create a demo identity', async () => {
  await mocked(async () => { throw new Error('offline'); }, async () => {
    const client = new AccountClient(); await client.restore();
    assert.equal(client.state.status, 'unavailable'); assert.equal(client.state.user, null);
  });
});
test('reload restores one session request even when multiple subscribers initialize together', async () => {
  const paths = [];
  await mocked(async path => { paths.push(path); return response(path.endsWith('/csrf') ? { csrfToken: 'fixture-csrf' } : session('Alice')); }, async () => {
    const client = new AccountClient(); await Promise.all([client.restore(), client.restore()]);
    assert.equal(paths.length, 2); assert.equal(client.state.user.id, 'Alice');
  });
});
test('registration and rejected credentials cannot authenticate a visitor', async () => {
  await mocked(async path => response(path.endsWith('/register') ? { message: 'Check your inbox' } : { message: 'Invalid credentials' }, path.endsWith('/register') ? 202 : 401), async () => {
    const client = new AccountClient(); await client.restore();
    await client.register('Alice', 'alice@stagelink.test', 'fixture password', 'customer');
    assert.equal(client.state.status, 'anonymous');
    await assert.rejects(client.login('alice@stagelink.test', 'wrong'));
    assert.equal(client.state.user, null);
  });
});
test('a slow previous-account response cannot replace a newly signed-in user', async () => {
  let finishMe;
  await mocked(async (path, options) => {
    if (path.endsWith('/login')) return response(session(JSON.parse(options.body).email.startsWith('alice') ? 'Alice' : 'Bob'));
    if (path.endsWith('/me')) return new Promise(resolve => { finishMe = resolve; });
    throw new Error('Unexpected endpoint');
  }, async () => {
    const client = new AccountClient(); await client.login('alice@stagelink.test', 'fixture');
    const old = client.me(); await new Promise(resolve => setTimeout(resolve, 0));
    await client.login('bob@stagelink.test', 'fixture'); finishMe(response(user('Alice'))); await old;
    assert.equal(client.state.user.id, 'Bob');
  });
});
test('a failed logout does not falsely claim the server session ended', async () => {
  await mocked(async path => response(path.endsWith('/login') ? session('Alice') : path.endsWith('/csrf') ? { csrfToken: 'fixture-csrf' } : { message: 'Unavailable' }, path.endsWith('/logout') ? 503 : 200), async () => {
    const client = new AccountClient(); await client.login('alice@stagelink.test', 'fixture');
    await assert.rejects(client.logout()); assert.equal(client.state.status, 'authenticated');
  });
});
test('a protected profile update preserves PUT and credentials after token refresh',async()=>{
 const updates=[];let failed=false;
 await mocked(async(path,options)=>{
  if(path.endsWith('/login')||path.endsWith('/refresh'))return response(session('Alice'));
  if(path.endsWith('/csrf'))return response({csrfToken:'fixture-csrf'});
  updates.push(options);if(!failed){failed=true;return response({message:'Expired'},401);}return response({revision:2});
 },async()=>{const client=new AccountClient();await client.login('alice@stagelink.test','fixture');assert.deepEqual(await client.api('me/profile',{revision:1},'PUT'),{revision:2});assert.equal(updates.length,2);for(const request of updates){assert.equal(request.method,'PUT');assert.equal(request.credentials,'include');assert.equal(request.headers['X-CSRF-Token'],'fixture-csrf');assert.ok(request.headers.Authorization);}});
});
test('a previous account profile response is rejected after switching users',async()=>{
 let finish;
 await mocked(async(path,options)=>path.endsWith('/login')?response(session(JSON.parse(options.body).email.startsWith('alice')?'Alice':'Bob')):new Promise(resolve=>{finish=resolve;}),async()=>{
  const client=new AccountClient();await client.login('alice@stagelink.test','fixture');const old=client.api('me/profile');await new Promise(resolve=>setTimeout(resolve,0));await client.login('bob@stagelink.test','fixture');finish(response({displayName:'Alice private profile'}));await assert.rejects(old,/account changed/);assert.equal(client.state.user.id,'Bob');
 });
});
