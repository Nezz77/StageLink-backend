import type { Resources } from '../../../shared/resources.js';
import { createHmac } from 'node:crypto';
import { PublicError } from './errors.js';
const LUA = `local count = redis.call('INCR', KEYS[1]); if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]); end; return count`;
export class AuthRateLimit {
  constructor(private redis: Resources['redis'], private namespace: string, private key: string) {}
  async check(scope: string, identity: string, max: number, seconds: number) {
    let count: number;
    try {
      if (this.redis.status === 'wait' || this.redis.status === 'end') await this.redis.connect();
      count = Number(await this.redis.eval(LUA, 1, `${this.namespace}:${scope}:${createHmac('sha256', Buffer.from(this.key, 'hex')).update(identity).digest('hex')}`, seconds));
    } catch { throw new PublicError(503, 'AUTH_UNAVAILABLE', 'Account services are unavailable. Please try again.'); }
    if (count > max) throw new PublicError(429, 'RATE_LIMITED', 'Too many attempts. Please wait before trying again.');
  }
}
