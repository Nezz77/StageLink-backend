import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

export const opaqueToken = () => randomBytes(32).toString('base64url');
export const digest = (token: string) => createHash('sha256').update(token).digest('hex');
export const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
export function equal(a: string, b: string) {
  const first = Buffer.from(a), second = Buffer.from(b);
  return first.length === second.length && timingSafeEqual(first, second);
}
export const csrfFor = (key: string, session: string) =>
  createHmac('sha256', Buffer.from(key, 'hex')).update('csrf-v1:' + session).digest('base64url');

// OWASP scrypt alternative: N=2^15, r=8, p=3; 32 MiB. Bounded work, no password truncation.
function derive(password: string, salt: string) {
  return new Promise<Buffer>((resolve, reject) => scrypt(password, salt, 32,
    { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 },
    (error, result) => error ? reject(error) : resolve(result)));
}
export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString('hex');
  return `scrypt-v1$${salt}$${(await derive(password, salt)).toString('hex')}`;
}
export async function verifyPassword(password: string, stored: string) {
  const [version, salt, expected] = stored.split('$');
  if (version !== 'scrypt-v1' || !salt || !expected || !/^[0-9a-f]{32}$/.test(salt) || !/^[0-9a-f]{64}$/.test(expected)) return false;
  return equal((await derive(password, salt)).toString('hex'), expected);
}
let dummy: Promise<string> | undefined;
export async function passwordMatches(password: string, stored?: string) {
  dummy ??= hashPassword(opaqueToken());
  const matches = await verifyPassword(password, stored ?? await dummy);
  return Boolean(stored && matches);
}
export function seal(key: string, data: unknown, context = 'stagelink-auth-mail-v1') {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'hex'), iv);
  cipher.setAAD(Buffer.from(context));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(data)), cipher.final()]);
  return [iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join('.');
}
export function unseal(key: string, value: string, context = 'stagelink-auth-mail-v1'): unknown {
  const [iv, tag, payload, extra] = value.split('.');
  if (!iv || !tag || !payload || extra) throw new Error('INVALID_MAIL_PAYLOAD');
  const cipher = createDecipheriv('aes-256-gcm', Buffer.from(key, 'hex'), Buffer.from(iv, 'base64url'));
  cipher.setAAD(Buffer.from(context));
  cipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return JSON.parse(Buffer.concat([cipher.update(Buffer.from(payload, 'base64url')), cipher.final()]).toString());
}
