import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiCookieAuth, ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { AuthService } from './service.js';
import { parse, PublicError } from './errors.js';
import { activeRoleSchema, emailRequestSchema, loginSchema, registerSchema, resetSchema, tokenSchema } from './schemas.js';
const messageSchema = { type: 'object' as const, required: ['message'], properties: { message: { type: 'string' as const } } };
const errorSchema = { type: 'object' as const, required: ['statusCode','code','message','requestId'], properties: { statusCode: { type: 'integer' as const }, code: { type: 'string' as const }, message: { type: 'string' as const }, requestId: { type: 'string' as const } } };
const accepted = { message: 'If this address is eligible, an email will arrive shortly.' };
const string = { type: 'string' as const };
const account = { type: 'object' as const, required: ['id', 'email', 'displayName', 'roles', 'activeRole', 'emailVerified', 'createdAt'], properties: {
  id: { ...string, format: 'uuid' }, email: { ...string, format: 'email' }, displayName: string,
  roles: { type: 'array' as const, items: { ...string, enum: ['customer', 'artist', 'renter', 'admin'] } },
  activeRole: { ...string, enum: ['customer', 'artist', 'renter', 'admin'] }, emailVerified: { type: 'boolean' as const }, createdAt: { ...string, format: 'date-time' },
} };
const authResponse = { type: 'object' as const, required: ['accessToken', 'expiresIn', 'csrfToken', 'user'], properties: {
  accessToken: string, expiresIn: { type: 'integer' as const }, csrfToken: string, user: account,
} };
const body = (properties: Record<string, any>) => ({ schema: { type: 'object' as const, required: Object.keys(properties), additionalProperties: false, properties } });
export function makeAuthController(auth: AuthService) {
  const cookieName = auth.config.NODE_ENV === 'production' ? '__Host-stagelink_refresh' : 'stagelink_refresh';
  const cookieOptions = { httpOnly: true, secure: auth.config.NODE_ENV === 'production', sameSite: 'strict' as const, path: '/' };
  const cookie = (req: Request) => (req.headers.cookie ?? '').split(';').map(value => value.trim()).find(value => value.startsWith(cookieName + '='))?.slice(cookieName.length + 1);
  const csrf = (req: Request) => req.get('X-CSRF-Token');
  const ip = (req: Request) => req.ip ?? req.socket.remoteAddress ?? 'unknown';
  function origin(req: Request) {
    if (req.get('Origin') !== auth.config.WEB_ORIGIN || !req.is('application/json') || req.get('Sec-Fetch-Site') === 'cross-site') {
      throw new PublicError(403, 'ORIGIN_REJECTED', 'Open StageLink in its own browser tab and try again.');
    }
  }
  function sendSession(res: Response, result: Awaited<ReturnType<AuthService['login']>>) {
    const { refreshToken, sessionExpiresAt, ...data } = result;
    res.cookie(cookieName, refreshToken, { ...cookieOptions, maxAge: Math.max(0, sessionExpiresAt.getTime() - Date.now()) });
    return data;
  }
  @ApiTags('Accounts')
  @ApiHeader({ name: 'X-CSRF-Token', required: false, description: 'Required for refresh, logout, role changes and verification requests. Obtain from login or GET /auth/csrf.' })
  @ApiHeader({ name: 'Origin', required: false, description: 'Must match the configured web origin for every state-changing request.' })
  @ApiResponse({ status: 400, schema: errorSchema })
  @ApiResponse({ status: 401, schema: errorSchema })
  @ApiResponse({ status: 403, schema: errorSchema })
  @ApiResponse({ status: 429, schema: errorSchema })
  @ApiResponse({ status: 500, schema: errorSchema })
  @ApiResponse({ status: 503, schema: errorSchema })
  @Controller()
  class AuthController {
    @Post('auth/register') @HttpCode(202) @ApiResponse({ status: 202, schema: messageSchema })
    @ApiOperation({ summary: 'Create a public account; uniform response for an existing email' })
    @ApiBody(body({ displayName: string, email: string, password: { ...string, minLength: 12, maxLength: 128 }, role: { ...string, enum: ['customer', 'artist', 'renter'] } }))
    async register(@Req() req: Request, @Body() input: unknown) { origin(req); await auth.register(parse(registerSchema, input), ip(req)); return accepted; }

    @Post('auth/login') @HttpCode(200)
    @ApiBody(body({ email: string, password: string })) @ApiResponse({ status: 200, schema: authResponse })
    async login(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Body() input: unknown) {
      origin(req); const data = parse(loginSchema, input); return sendSession(res, await auth.login(data.email, data.password, ip(req)));
    }
    @Get('auth/csrf') @ApiCookieAuth()
    @ApiResponse({ status: 200, schema: { type: 'object', required: ['csrfToken'], properties: { csrfToken: string } } })
    async csrf(@Req() req: Request) { return auth.csrf(cookie(req)); }

    @Post('auth/refresh') @HttpCode(200) @ApiCookieAuth()
    @ApiResponse({ status: 200, schema: authResponse })
    async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
      origin(req); return sendSession(res, await auth.refresh(cookie(req), csrf(req), ip(req)));
    }
    @Post('auth/logout') @HttpCode(204) @ApiCookieAuth()
    async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
      origin(req); await auth.logout(cookie(req), csrf(req), req.get('Authorization')); res.clearCookie(cookieName, cookieOptions);
    }
    @Get('me') @ApiBearerAuth() @ApiResponse({ status: 200, schema: account })
    async me(@Req() req: Request) { return auth.publicAccount(await auth.authenticate(req.get('Authorization'))); }

    @Post('me/active-role') @HttpCode(200) @ApiBearerAuth()
    @ApiBody(body({ role: { ...string, enum: ['customer', 'artist', 'renter', 'admin'] } }))
    @ApiResponse({ status: 200, schema: account })
    async role(@Req() req: Request, @Body() input: unknown) {
      origin(req); const data = parse(activeRoleSchema, input);
      return auth.activeRole(await auth.authenticate(req.get('Authorization')), data.role, csrf(req));
    }
    @Get('admin/access') @ApiBearerAuth() @ApiResponse({ status: 200, schema: { type: 'object', required: ['authorized'], properties: { authorized: { type: 'boolean' } } } })
    async admin(@Req() req: Request) {
      const actor = await auth.authenticate(req.get('Authorization'));
      if (actor.session.activeRole !== 'admin' || !actor.user.roles.includes('admin')) throw new PublicError(403, 'ROLE_FORBIDDEN', 'Administrator access is required.');
      return { authorized: true };
    }
    @Post('auth/email-verification') @HttpCode(202) @ApiResponse({ status: 202, schema: messageSchema }) @ApiBearerAuth()
    async requestVerification(@Req() req: Request) {
      origin(req); await auth.requestVerification(await auth.authenticate(req.get('Authorization')), csrf(req)); return accepted;
    }
    @Post('auth/email-verification/confirm') @HttpCode(200) @ApiResponse({ status: 200, schema: messageSchema })
    @ApiBody(body({ token: string }))
    async confirm(@Req() req: Request, @Body() input: unknown) {
      origin(req); await auth.confirmEmail(parse(tokenSchema, input).token, ip(req)); return { message: 'Email verified.' };
    }
    @Post('auth/password-reset') @HttpCode(202) @ApiResponse({ status: 202, schema: messageSchema }) @ApiBody(body({ email: string }))
    async reset(@Req() req: Request, @Body() input: unknown) {
      origin(req); await auth.requestReset(parse(emailRequestSchema, input).email, ip(req)); return accepted;
    }
    @Post('auth/password-reset/verify') @HttpCode(200) @ApiBody(body({ token: string }))
    @ApiResponse({ status: 200, schema: { type: 'object', required: ['grant', 'expiresIn'], properties: { grant: string, expiresIn: { type: 'integer' } } } })
    async verifyReset(@Req() req: Request, @Body() input: unknown) {
      origin(req); return auth.verifyReset(parse(tokenSchema, input).token, ip(req));
    }
    @Post('auth/password-reset/complete') @HttpCode(200) @ApiResponse({ status: 200, schema: messageSchema }) @ApiBody(body({ grant: string, password: string }))
    async complete(@Req() req: Request, @Body() input: unknown) {
      origin(req); const data = parse(resetSchema, input); await auth.completeReset(data.grant, data.password, ip(req)); return { message: 'Password changed. Sign in with your new password.' };
    }
  }
  return AuthController;
}
