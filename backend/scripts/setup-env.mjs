import { randomBytes } from 'node:crypto';
import { readFile, writeFile, chmod } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
async function existing(name) {
  try { const text = await readFile(resolve(root, name), 'utf8'); return { text, values: parseEnv(text) }; }
  catch (error) { if (error.code === 'ENOENT') return { text: '', values: {} }; throw error; }
}
const infra = await existing('infra/.env'), backend = await existing('backend/.env');
const validKey = value => /^[0-9a-f]{64}$/.test(value ?? '');
const key = name => [infra.values[name], backend.values[name]].find(validKey) ?? randomBytes(32).toString('hex');
const jwt = key('AUTH_JWT_SECRET'), mail = key('AUTH_MAIL_KEY'), payout = key('PAYOUT_DATA_KEY');
const shared = { AUTH_JWT_SECRET: jwt, AUTH_MAIL_KEY: mail, PAYOUT_DATA_KEY: payout };
const defaults = {
  'infra/.env': { POSTGRES_USER:'stagelink', POSTGRES_PASSWORD:'local-development-only', POSTGRES_DB:'stagelink_dev', WEB_ORIGIN:'http://localhost:3000', ...shared },
  'backend/.env': { NODE_ENV:'development', DATABASE_URL:'postgresql://stagelink:local-development-only@127.0.0.1:55432/stagelink_dev?connect_timeout=3', REDIS_URL:'redis://127.0.0.1:56379', PORT:'4000', WEB_ORIGIN:'http://localhost:3000', ...shared, SMTP_HOST:'127.0.0.1', SMTP_PORT:'1025', SMTP_FROM:'noreply@stagelink.local' },
  '.env.local': { VITE_AUTH_MODE:'api', VITE_API_PROXY_TARGET:'http://127.0.0.1:4000' },
};
for (const [name, values] of Object.entries(defaults)) {
  const current = await existing(name); let text = current.text; const changed = [];
  for (const [field, value] of Object.entries(values)) {
    if (current.values[field] && (!Object.hasOwn(shared, field) || validKey(current.values[field]))) continue;
    const line = `${field}='${value}'`;
    const match = new RegExp(`^${field}=.*$`, 'm');
    text = match.test(text) ? text.replace(match, line) : text + (text && !text.endsWith('\n') ? '\n' : '') + line + '\n';
    changed.push(field);
  }
  if (changed.length) { await writeFile(resolve(root, name), text, { mode: 0o600 }); await chmod(resolve(root, name), 0o600); }
  console.log(changed.length ? `Prepared ${name}: ${changed.join(', ')}` : `Kept existing ${name}`);
}
for (const field of Object.keys(shared)) {
  if (validKey(infra.values[field]) && validKey(backend.values[field]) && infra.values[field] !== backend.values[field]) console.log(`Existing ${field} differs between configurations; select matching configuration for your deployment.`);
}
// Keys are never displayed. Valid existing keys are never rotated by this script.
