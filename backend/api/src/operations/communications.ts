import { Body, Controller, Get, HttpCode, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import { checkSmtp, communicationState, smtpCheckResult, transportSecurity } from '../../../shared/communications.js';
import { databaseNow } from '../../../shared/database-clock.js';
import type { AuthService } from '../auth/service.js';
import { PublicError } from '../auth/errors.js';
import { ProfileService } from '../profiles/service.js';
import { parse, schema } from '../payments/orders.js';
const empty = z.object({}).strict();
export function makeCommunicationsController(auth: AuthService) {
    const profiles = new ProfileService(auth), db = auth.deps.db, config = auth.config;
    async function admin(req: Request) {
        const actor = await auth.authenticate(req.get('Authorization'));
        if (actor.session.activeRole !== 'admin')
            throw new PublicError(403, 'ROLE_FORBIDDEN', 'Administrator access is required.');
        profiles.verified(actor);
        return actor;
    }
    @ApiTags('Communication readiness')
    @ApiBearerAuth()
    @Controller('admin/communications')
    class CommunicationsController {
        @Get()
        @ApiOkResponse({ schema: schema(communicationState) })
        async status(
        @Req()
        req: Request) {
            await admin(req);
            return { checkedAt: (await databaseNow(db)).toISOString(),
                email: { bookingRemindersEnabled: config.BOOKING_EMAIL_REMINDERS === 'true', promotionalEnabled: config.PROMOTIONAL_EMAIL_DELIVERY === 'true',
                    security: transportSecurity(config), authenticationConfigured: Boolean(config.SMTP_USER) },
                sms: { providerConfigured: Boolean(config.TEXTLK_TOKEN && config.TEXTLK_SENDER), verificationEnabled: config.SMS_VERIFICATION_ENABLED === 'true', bookingRemindersEnabled: config.BOOKING_SMS_REMINDERS === 'true', promotionalEnabled: config.PROMOTIONAL_SMS_DELIVERY === 'true', hourlyLimit: config.SMS_HOURLY_LIMIT } };
        }
        @Post('smtp-check')
        @HttpCode(200)
        @ApiBody({ schema: schema(empty) })
        @ApiOkResponse({ schema: schema(smtpCheckResult) })
        async smtp(
        @Req()
        req: Request,
        @Body()
        raw: unknown) {
            if (req.get('Origin') !== config.WEB_ORIGIN || req.get('Sec-Fetch-Site') === 'cross-site' || !req.is('application/json'))
                throw new PublicError(403, 'ORIGIN_REJECTED', 'Open StageLink in its own browser tab and try again.');
            parse(empty, raw);
            const actor = await admin(req);
            profiles.checkCsrf(actor, req.get('X-CSRF-Token'));
            await db.$transaction(async (tx) => {
                const current = await profiles.actor(tx, actor, undefined, true);
                profiles.verified(current);
                if (current.session.createdAt.getTime() < (await databaseNow(tx)).getTime() - 15 * 60000)
                    throw new PublicError(403, 'RECENT_LOGIN_REQUIRED', 'Sign in again before checking the mail connection.');
            });
            await auth.limits.check('smtp-check-user', actor.user.id, 3, 300);
            await auth.limits.check('smtp-check-global', 'configured-relay', 20, 60);
            const result = await checkSmtp(config);
            return { ...result, checkedAt: (await databaseNow(db)).toISOString() };
        }
    }
    return CommunicationsController;
}
