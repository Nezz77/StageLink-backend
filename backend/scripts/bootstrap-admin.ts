import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { readConfig } from '../shared/config.js';
import { createDb } from '../shared/resources.js';
import { hashPassword } from '../api/src/auth/security.js';
import { emailSchema, passwordSchema } from '../api/src/auth/schemas.js';
async function main() {
  const { values } = parseArgs({ options: { email: { type: 'string' }, name: { type: 'string' } }, strict: true });
  const email = emailSchema.parse(values.email), displayName = z.string().trim().min(2).max(80).parse(values.name);
  if (process.stdin.isTTY) throw new Error('Provide password through a protected stdin pipe');
  const password = passwordSchema.parse(readFileSync(0, 'utf8').replace(/\r?\n$/, ''));
  const db = createDb(readConfig());
  try {
    if (await db.authUser.findUnique({ where: { email } })) throw new Error('Existing account cannot be overwritten by bootstrap');
    const passwordHash = await hashPassword(password);
    const user = await db.authUser.create({ data: { email, displayName, passwordHash, roles: ['admin'] } });
    console.log(JSON.stringify({ created: true, userId: user.id }));
  } finally { await db.$disconnect(); }
}
main().catch(() => { console.error('Admin creation failed. Supply a new email, name, and a 12–128 character password through stdin. Existing accounts are never overwritten.'); process.exitCode = 1; });
