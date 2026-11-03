import type { operations } from '../../packages/contracts/src/api';
export type Account = operations['AuthController_me']['responses'][200]['content']['application/json'];
export type AccountRole = Account['activeRole'];
export type AuthState = { status: 'checking' | 'anonymous' | 'authenticated' | 'unavailable'; user: Account | null; error: string };
type Session = operations['AuthController_login']['responses'][200]['content']['application/json'];
export class AccountError extends Error { readonly status: number; constructor(message: string, status = 503) { super(message); this.status = status; } }
export class AccountClient {
  private token = '';
  private csrf = '';
  private epoch = 0;
  private sessionQueue: Promise<unknown> = Promise.resolve();
  private restoring: Promise<void> | null = null;
  private renewing: Promise<void> | null = null;
  private listeners = new Set<() => void>();
  private channel = typeof window !== 'undefined' && typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('stagelink-account') : null;
  state: AuthState = { status: 'checking', user: null, error: '' };
  constructor() { this.channel?.addEventListener('message', () => { this.epoch++; this.token = ''; this.csrf = ''; void Promise.resolve(this.restoring).then(() => this.restore()); }); }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = () => this.state;
  private update(state: AuthState) { this.state = state; this.listeners.forEach(listener => listener()); }
  private async locked<T>(work: () => Promise<T>): Promise<T> {
    const task = this.sessionQueue.then(async (): Promise<T> => {
      if (typeof navigator !== 'undefined' && navigator.locks) return await navigator.locks.request('stagelink-account-session', work);
      return await work();
    });
    this.sessionQueue = task.catch(() => undefined);
    return task;
  }
  private async request<T>(path: string, body?: unknown, authorized = false, retried = false, method?: 'GET'|'POST'|'PUT'|'PATCH'): Promise<T> {
    if (authorized && !this.token) await this.refresh();
    let response: Response;
    try { response = await fetch('/api/v1/' + path, { credentials: 'include', method: method ?? (body === undefined ? 'GET' : 'POST'),
      headers: { 'Content-Type': 'application/json', ...(this.csrf ? { 'X-CSRF-Token': this.csrf } : {}), ...(authorized && this.token ? { Authorization: 'Bearer ' + this.token } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }); } catch { throw new AccountError('Account services are unavailable. Please try again.'); }
    if (response.status === 401 && authorized && !retried) { await this.refresh(); return this.request(path, body, authorized, true, method); }
    const text = await response.text();
    let data: any;
    try { data = text ? JSON.parse(text) : null; } catch { throw new AccountError('Account services are unavailable. Please try again.'); }
    if (!response.ok) throw new AccountError(typeof data?.message === 'string' ? data.message : 'The request could not be completed.', response.status);
    return data as T;
  }
  private accept(session: Session, epoch: number) {
    if (epoch !== this.epoch) throw new AccountError('Your session changed. Please try again.', 409);
    this.token = session.accessToken; this.csrf = session.csrfToken;
    this.update({ status: 'authenticated', user: session.user, error: '' });
  }
  async restore() {
    if (this.restoring) return this.restoring;
    this.restoring = this.locked(async () => {
      const epoch = this.epoch;
      this.update({ status: 'checking', user: null, error: '' });
      try {
        const csrf = await this.request<{ csrfToken: string }>('auth/csrf'); this.csrf = csrf.csrfToken;
        const session = await this.request<Session>('auth/refresh', {}); this.accept(session, epoch);
      } catch (error) {
        if (epoch !== this.epoch) return;
        this.token = ''; this.csrf = '';
        const anonymous = error instanceof AccountError && error.status === 401;
        this.update({ status: anonymous ? 'anonymous' : 'unavailable', user: null, error: anonymous ? '' : 'Account services are unavailable. Please try again.' });
      }
    }).finally(() => { this.restoring = null; });
    return this.restoring;
  }
  private refresh() {
    if (this.renewing) return this.renewing;
    this.renewing = this.locked(async () => {
      const epoch = this.epoch;
      try {
        this.csrf = (await this.request<{ csrfToken: string }>('auth/csrf')).csrfToken;
        this.accept(await this.request<Session>('auth/refresh', {}), epoch);
      } catch (error) {
        if (epoch === this.epoch && error instanceof AccountError && error.status === 401) {
          this.token = ''; this.csrf = ''; this.update({ status: 'anonymous', user: null, error: 'Your session ended. Sign in again.' });
        }
        throw error;
      }
    }).finally(() => { this.renewing = null; });
    return this.renewing;
  }
  async login(email: string, password: string) {
    return this.locked(async () => {
      const epoch = ++this.epoch;
      const session = await this.request<Session>('auth/login', { email, password });
      this.accept(session, epoch); this.channel?.postMessage('changed');
      return session.user;
    });
  }
  register(displayName: string, email: string, password: string, role: 'customer' | 'artist' | 'renter') {
    return this.request<{ message: string }>('auth/register', { displayName, email, password, role });
  }
  async logout() {
    return this.locked(async () => {
      // GET obtains a valid CSRF value even when the in-memory access token expired.
      try {
        try { this.csrf = (await this.request<{ csrfToken: string }>('auth/csrf')).csrfToken; }
        catch (error) { if (!(error instanceof AccountError && error.status === 401 && this.token && this.csrf)) throw error; }
        // Already under the session lock: do not start a nested refresh on a 401.
        await this.request('auth/logout', {}, Boolean(this.token), true);
      } catch (error) { if (!(error instanceof AccountError && error.status === 401)) throw error; }
      this.epoch++; this.token = ''; this.csrf = '';
      this.update({ status: 'anonymous', user: null, error: '' }); this.channel?.postMessage('changed');
    });
  }
  async selectRole(role: AccountRole) {
    const epoch = this.epoch;
    const user = await this.request<Account>('me/active-role', { role }, true);
    if (epoch === this.epoch) this.update({ status: 'authenticated', user, error: '' });
    this.channel?.postMessage('changed');
  }
  async me() {
    const epoch = this.epoch, user = await this.request<Account>('me', undefined, true);
    if (epoch === this.epoch) this.update({ status: 'authenticated', user, error: '' });
  }
  requestVerification() { return this.request('auth/email-verification', {}, true); }
  async confirmEmail(token: string) { await this.request('auth/email-verification/confirm', { token }); await this.restore(); }
  requestReset(email: string) { return this.request('auth/password-reset', { email }); }
  async api<T>(path: string, body?: unknown, method?: 'GET'|'POST'|'PUT'|'PATCH'): Promise<T> {
    const epoch = this.epoch, result = await this.request<T>(path, body, true, false, method);
    if (epoch !== this.epoch) throw new AccountError('Your account changed. Reload this page before continuing.', 409);
    return result;
  }
  async confirmEmailChange(token: string) { await this.request('auth/email-change/confirm', { token }); await this.restore(); }
  verifyReset(token: string) { return this.request<{ grant: string; expiresIn: number }>('auth/password-reset/verify', { token }); }
  async completeReset(grant: string, password: string) {
    await this.request('auth/password-reset/complete', { grant, password });
    this.epoch++; this.token = ''; this.csrf = ''; this.channel?.postMessage('changed'); await this.restore();
  }
}
export const accountClient = new AccountClient();
