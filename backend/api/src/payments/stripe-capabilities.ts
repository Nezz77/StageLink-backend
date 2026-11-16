import { Controller, Get, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import { checkStripeCapabilities, stripeAccountId, stripeCapabilities } from '../../../shared/payments/stripe-capabilities.js';
import { PublicError } from '../auth/errors.js';
import type { AuthService } from '../auth/service.js';
import { ProfileService } from '../profiles/service.js';
import { parse, schema } from './orders.js';

const filter = z.object({ connectedAccountId: stripeAccountId.optional() }).strict();

export function makeStripeCapabilitiesController(auth: AuthService) {
  const profiles = new ProfileService(auth);

  async function requireAdmin(req: Request) {
    const actor = await auth.authenticate(req.get('Authorization'));
    if (actor.session.activeRole !== 'admin') throw new PublicError(403, 'ROLE_FORBIDDEN', 'Administrator access is required.');
    profiles.verified(actor);
    return actor;
  }

  @ApiTags('Stripe test capabilities')
  @ApiBearerAuth()
  @Controller('admin/payments/stripe-capabilities')
  class StripeCapabilitiesController {
    @Get()
    @ApiQuery({ name: 'connectedAccountId', required: false, type: String })
    @ApiOkResponse({ schema: schema(stripeCapabilities.extend({ checkedAt: z.iso.datetime() })) })
    async check(@Req() req: Request, @Query() raw: unknown) {
      const actor = await requireAdmin(req);
      const { connectedAccountId } = parse(filter, raw);
      const key = auth.config.STRIPE_TEST_SECRET_KEY;
      if (key) {
        await auth.limits.check('stripe-capabilities-admin', actor.user.id, 8, 60);
        await auth.limits.check('stripe-capabilities-shared', 'shared', 12, 60);
      }
      const evidence = await checkStripeCapabilities(key, connectedAccountId);
      await requireAdmin(req);
      return { ...evidence, checkedAt: new Date().toISOString() };
    }
  }
  return StripeCapabilitiesController;
}
