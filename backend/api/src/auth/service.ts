import { randomUUID } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { Prisma, type AuthUser, type AuthSession } from '../../../generated/prisma/client.js';
import type { Config } from '../../../shared/config.js';
import type { Resources } from '../../../shared/resources.js';
import { AuthRateLimit } from './rate-limit.js';
import { csrfFor, digest, equal, hashPassword, opaqueToken, passwordMatches, seal, tokenPattern } from './security.js';
import { PublicError, unauthorized } from './errors.js';
import type { AccountRole, Registration } from './schemas.js';

type Tx = Prisma.TransactionClient;
export type Identity = { user: AuthUser; session: AuthSession };
export class AuthService {
  readonly limits: AuthRateLimit;
  constructor(readonly config: Config, readonly deps: Resources) {
    this.limits = new AuthRateLimit(deps.redis, config.AUTH_RATE_PREFIX, config.AUTH_JWT_SECRET);
  }
  publicAccount({ user, session }: Identity) {
    return { id: user.id, email: user.email, displayName: user.displayName,
      roles: [...user.roles], activeRole: session.activeRole,
      emailVerified: Boolean(user.emailVerifiedAt), createdAt: user.createdAt.toISOString() };
  }
  async register(data: Registration, ip: string) {
    await this.limits.check('register-ip', ip, 10, 3600);
    await this.limits.check('register-email', data.email, 3, 3600);
    const passwordHash = await hashPassword(data.password);
    // Uniform response for existing and new email addresses; never overwrite an account.
    try {
      await this.deps.db.$transaction(async tx => {
        const existing = await tx.authUser.findUnique({ where: { email: data.email } });
        if (existing) return;
        const roles: AccountRole[] = data.role === 'customer' ? ['customer'] : ['customer', data.role];
        const user = await tx.authUser.create({ data: { email: data.email, displayName: data.displayName, passwordHash, roles } });
        await this.issueMailToken(tx, user, 'verify_email');
      });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') || !await this.deps.db.authUser.findUnique({ where: { email: data.email } })) throw error;
    }
  }
  async login(email: string, password: string, ip: string) {
    await this.limits.check('login-ip', ip, 25, 900);
    await this.limits.check('login-email', email, 10, 900);
    const user = await this.deps.db.authUser.findUnique({ where: { email } });
    const valid = await passwordMatches(password, user?.passwordHash);
    if (!user || !valid || user.disabledAt) throw new PublicError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.');
    const identity = await this.deps.db.$transaction(async tx => {
      await this.lockUser(tx, user.id);
      const current = await tx.authUser.findUniqueOrThrow({ where: { id: user.id } });
      // Password reset cannot race a slow successful check and leave an old-password session.
      if (current.disabledAt || current.passwordHash !== user.passwordHash) throw unauthorized();
      const activeRole = current.roles.includes('admin') ? 'admin' : current.roles.includes('artist') ? 'artist' : current.roles.includes('renter') ? 'renter' : 'customer';
      const session = await tx.authSession.create({ data: { userId: user.id, activeRole, expiresAt: new Date(Date.now() + 30 * 86400000) } });
      const credential = await this.newRefresh(tx, session);
      return { user: current, session, ...credential };
    });
    return this.sessionResult(identity);
  }
  private async newRefresh(tx: Tx, session: AuthSession) {
    const secret = opaqueToken();
    const credential = await tx.authRefresh.create({ data: { sessionId: session.id, secretDigest: digest(secret), expiresAt: session.expiresAt } });
    return { refreshToken: credential.id + '.' + secret };
  }
  private async sessionResult(identity: Identity & { refreshToken: string }) {
    const token = await new SignJWT({ sid: identity.session.id }).setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer('stagelink-api').setAudience('stagelink-web').setSubject(identity.user.id)
      .setIssuedAt().setExpirationTime('10m').sign(Buffer.from(this.config.AUTH_JWT_SECRET, 'hex'));
    return { refreshToken: identity.refreshToken, sessionExpiresAt: identity.session.expiresAt,
      accessToken: token, expiresIn: 600, csrfToken: csrfFor(this.config.AUTH_JWT_SECRET, identity.session.id), user: this.publicAccount(identity) };
  }
  private parseRefresh(raw: string | undefined) {
    const [id, secret, extra] = (raw ?? '').split('.');
    if (!id || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id) || !secret || !tokenPattern.test(secret) || extra) throw unauthorized();
    return { id, secret };
  }
  private checkCsrf(sessionId: string, csrf: string | undefined) {
    if (!csrf || !equal(csrfFor(this.config.AUTH_JWT_SECRET, sessionId), csrf)) throw new PublicError(403, 'CSRF_REJECTED', 'Refresh this page and try again.');
  }
  async cookieIdentity(raw: string | undefined) {
    const { id, secret } = this.parseRefresh(raw);
    const credential = await this.deps.db.authRefresh.findUnique({ where: { id }, include: { session: { include: { user: true } } } });
    if (!credential || !equal(digest(secret), credential.secretDigest) || credential.consumedAt || credential.expiresAt <= new Date() ||
      credential.session.revokedAt || credential.session.expiresAt <= new Date() || credential.session.user.disabledAt) throw unauthorized();
    return { user: credential.session.user, session: credential.session };
  }
  async csrf(raw: string | undefined) {
    const identity = await this.cookieIdentity(raw);
    return { csrfToken: csrfFor(this.config.AUTH_JWT_SECRET, identity.session.id) };
  }
  async refresh(raw: string | undefined, csrf: string | undefined, ip: string) {
    await this.limits.check('refresh-ip', ip, 120, 60);
    const { id, secret } = this.parseRefresh(raw);
    const found = await this.deps.db.authRefresh.findUnique({ where: { id } });
    if (!found || !equal(digest(secret), found.secretDigest)) throw unauthorized();
    this.checkCsrf(found.sessionId, csrf);
    const result = await this.deps.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM auth_sessions WHERE id = ${found.sessionId}::uuid FOR UPDATE`;
      const credential = await tx.authRefresh.findUniqueOrThrow({ where: { id } });
      const session = await tx.authSession.findUniqueOrThrow({ where: { id: credential.sessionId }, include: { user: true } });
      if (credential.consumedAt) {
        await tx.authSession.update({ where: { id: session.id }, data: { revokedAt: new Date() } });
        // Return rather than throw: replay revocation must commit.
        return null;
      }
      if (credential.expiresAt <= new Date() || session.revokedAt || session.expiresAt <= new Date() || session.user.disabledAt) return null;
      await tx.authRefresh.update({ where: { id }, data: { consumedAt: new Date() } });
      return { user: session.user, session, ...await this.newRefresh(tx, session) };
    });
    if (!result) throw unauthorized();
    return this.sessionResult(result);
  }
  async authenticate(bearer: string | undefined): Promise<Identity> {
    if (!bearer?.startsWith('Bearer ')) throw unauthorized();
    let sub: string | undefined, sid: unknown;
    try {
      const { payload } = await jwtVerify(bearer.slice(7), Buffer.from(this.config.AUTH_JWT_SECRET, 'hex'), {
        issuer: 'stagelink-api', audience: 'stagelink-web', algorithms: ['HS256'], typ: 'JWT', maxTokenAge: '10m',
      });
      sub = payload.sub; sid = payload.sid;
    } catch { throw unauthorized(); }
    if (!sub || typeof sid !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sid)) throw unauthorized();
    const session = await this.deps.db.authSession.findUnique({ where: { id: sid }, include: { user: true } });
    if (!session || session.userId !== sub || session.revokedAt || session.expiresAt <= new Date() || session.user.disabledAt || !session.user.roles.includes(session.activeRole)) throw unauthorized();
    return { user: session.user, session };
  }
  async logout(raw: string | undefined, csrf: string | undefined, bearer?: string) {
    if (!raw && !bearer) return;
    let identity: Identity;
    try { identity = await this.cookieIdentity(raw); }
    catch (error) { if (!(error instanceof PublicError && error.getStatus() === 401) || !bearer) throw error; identity = await this.authenticate(bearer); }
    this.checkCsrf(identity.session.id, csrf);
    await this.deps.db.authSession.update({ where: { id: identity.session.id }, data: { revokedAt: new Date() } });
  }
  async activeRole(identity: Identity, role: AccountRole, csrf: string | undefined) {
    this.checkCsrf(identity.session.id, csrf);
    const changed = await this.deps.db.authSession.updateMany({ where: { id: identity.session.id, revokedAt: null,
      expiresAt: { gt: new Date() }, user: { disabledAt: null, roles: { has: role } } }, data: { activeRole: role } });
    if (!changed.count) throw new PublicError(403, 'ROLE_FORBIDDEN', 'This role is not available on your account.');
    return this.publicAccount({ ...identity, session: { ...identity.session, activeRole: role } });
  }
  async requestVerification(identity: Identity, csrf: string | undefined) {
    this.checkCsrf(identity.session.id, csrf);
    await this.limits.check('verify-user', identity.user.id, 3, 3600);
    await this.limits.check('verify-cooldown', identity.user.id, 1, 60);
    if (identity.user.emailVerifiedAt) return;
    await this.deps.db.$transaction(async tx => {
      await this.lockUser(tx, identity.user.id);
      const current = await tx.authUser.findUniqueOrThrow({ where: { id: identity.user.id } });
      if (!current.emailVerifiedAt && !current.disabledAt) await this.issueMailToken(tx, current, 'verify_email');
    });
  }
  async requestReset(email: string, ip: string) {
    await this.limits.check('reset-ip', ip, 10, 3600);
    await this.limits.check('reset-email', email, 3, 3600);
    await this.limits.check('reset-cooldown', email, 1, 60);
    await this.deps.db.$transaction(async tx => {
      const user = await tx.authUser.findUnique({ where: { email } });
      if (user && !user.disabledAt) {
        await this.lockUser(tx, user.id);
        await this.issueMailToken(tx, user, 'password_reset');
      }
    });
  }
  private async lockUser(tx: Tx, userId: string) {
    await tx.$queryRaw`SELECT id FROM auth_users WHERE id = ${userId}::uuid FOR UPDATE`;
  }
  private async issueMailToken(tx: Tx, user: AuthUser, purpose: 'verify_email' | 'password_reset') {
    const token = opaqueToken(), expiresAt = new Date(Date.now() + (purpose === 'verify_email' ? 86400000 : 900000));
    await tx.authToken.updateMany({ where: { userId: user.id, purpose, usedAt: null }, data: { usedAt: new Date() } });
    await tx.authToken.create({ data: { userId: user.id, purpose, digest: digest(token), email: user.email, expiresAt } });
    await tx.authMail.create({ data: { userId: user.id, expiresAt,
      sealedPayload: seal(this.config.AUTH_MAIL_KEY, { to: user.email, token, purpose }) } });
  }
  private async useToken(tx: Tx, raw: string, purpose: string) {
    const token = await tx.authToken.findUnique({ where: { digest: digest(raw) } });
    if (!token || token.purpose !== purpose || token.usedAt || token.expiresAt <= new Date()) throw new PublicError(401, 'TOKEN_INVALID', 'This link or code is invalid or expired. Request another.');
    await this.lockUser(tx, token.userId);
    const user = await tx.authUser.findUniqueOrThrow({ where: { id: token.userId } });
    if (user.disabledAt || user.email !== token.email) throw unauthorized();
    const consumed = await tx.authToken.updateMany({ where: { id: token.id, usedAt: null, expiresAt: { gt: new Date() } }, data: { usedAt: new Date() } });
    if (consumed.count !== 1) throw new PublicError(401, 'TOKEN_INVALID', 'This link or code has already been used.');
    return user;
  }
  async confirmEmail(token: string, ip: string) {
    await this.limits.check('token-ip', ip, 30, 900);
    await this.deps.db.$transaction(async tx => {
      const user = await this.useToken(tx, token, 'verify_email');
      await tx.authUser.update({ where: { id: user.id }, data: { emailVerifiedAt: new Date() } });
    });
  }
  async verifyReset(token: string, ip: string) {
    await this.limits.check('token-ip', ip, 30, 900);
    const grant = opaqueToken();
    await this.deps.db.$transaction(async tx => {
      const user = await this.useToken(tx, token, 'password_reset');
      await tx.authToken.create({ data: { userId: user.id, email: user.email, purpose: 'password_reset_grant', digest: digest(grant), expiresAt: new Date(Date.now() + 300000) } });
    });
    return { grant, expiresIn: 300 };
  }
  async completeReset(grant: string, password: string, ip: string) {
    await this.limits.check('complete-reset-ip', ip, 10, 900);
    const passwordHash = await hashPassword(password);
    await this.deps.db.$transaction(async tx => {
      const user = await this.useToken(tx, grant, 'password_reset_grant');
      await tx.authUser.update({ where: { id: user.id }, data: { passwordHash } });
      await tx.authSession.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } });
      await tx.authToken.updateMany({ where: { userId: user.id, usedAt: null }, data: { usedAt: new Date() } });
      await tx.pendingEmailChange.deleteMany({where:{userId:user.id}});
    });
  }
}
