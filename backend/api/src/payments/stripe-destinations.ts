import { Body, Controller, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOkResponse, ApiParam, ApiTags } from '@nestjs/swagger';
import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { z } from 'zod';
import type { Prisma, StripePayoutDestinationLink } from '../../../generated/prisma/client.js';
import { stripeAccountId, verifyStripeTestDestination } from '../../../shared/payments/stripe-capabilities.js';
import { PublicError } from '../auth/errors.js';
import type { AuthService, Identity } from '../auth/service.js';
import { assertReviewedDestination, ProfileService } from '../profiles/service.js';
import { parse, schema, uuid } from './orders.js';

const revision = z.number().int().min(1).max(2_147_483_647);
const reason = z.string().trim().min(10).max(500);
const linkCommand = z.object({
  requestKey: uuid, destinationRevision: revision, expectedLinkId: uuid.nullable(), accountId: stripeAccountId, reason,
}).strict();
const revokeCommand = z.object({ expectedLinkId: uuid, reason }).strict();
const linkView = z.object({
  id: uuid, providerId: uuid, destinationRevision: revision, platformAccountId: stripeAccountId, stripeAccountId,
  accountCountry: z.string(), linkedBy: uuid, reason, createdAt: z.iso.datetime(), replacesId: uuid.nullable(),
  endedBy: uuid.nullable(), endedAt: z.iso.datetime().nullable(), endKind: z.enum(['revoke', 'replace']).nullable(),
  endReason: reason.nullable(),
});
const linksView = z.object({
  activeLink: linkView.nullable(), matchesApprovedDestination: z.boolean(), history: z.array(linkView).max(20),
});

function present(link: StripePayoutDestinationLink) {
  const { requestKey: _key, createdAt, endedAt, ...details } = link;
  return { ...details, createdAt: createdAt.toISOString(), endedAt: endedAt?.toISOString() ?? null };
}

function changed() {
  return new PublicError(409, 'STRIPE_DESTINATION_CHANGED', 'Reload the current Stripe destination before making changes.');
}

function activeLink(tx: Prisma.TransactionClient, providerId: string) {
  return tx.stripePayoutDestinationLink.findFirst({ where: { providerId, endedAt: null } });
}

export function makeStripeDestinationsController(auth: AuthService) {
  const db = auth.deps.db;
  const profiles = new ProfileService(auth);

  async function admin(req: Request) {
    const actor = await auth.authenticate(req.get('Authorization'));
    if (actor.session.activeRole !== 'admin') throw new PublicError(403, 'ROLE_FORBIDDEN', 'Administrator access is required.');
    profiles.verified(actor);
    return actor;
  }

  function recent(actor: Identity, providerId: string) {
    if (actor.user.id === providerId) {
      throw new PublicError(403, 'SELF_REVIEW_FORBIDDEN', 'Another administrator must review this destination.');
    }
    if (Date.now() - actor.session.createdAt.getTime() >= 15 * 60_000) {
      throw new PublicError(403, 'RECENT_LOGIN_REQUIRED', 'Sign in again before changing a Stripe destination.');
    }
  }

  async function mutation(req: Request, providerId: string) {
    if (req.get('Origin') !== auth.config.WEB_ORIGIN || req.get('Sec-Fetch-Site') === 'cross-site' || !req.is('application/json')) {
      throw new PublicError(403, 'ORIGIN_REJECTED', 'Open StageLink in its own browser tab and try again.');
    }
    const actor = await admin(req);
    profiles.checkCsrf(actor, req.get('X-CSRF-Token'));
    recent(actor, providerId);
    return actor;
  }

  async function lockedAdmin(tx: Prisma.TransactionClient, actor: Identity, providerId: string) {
    for (const id of [actor.user.id, providerId].sort()) {
      await tx.$queryRaw`SELECT id FROM auth_users WHERE id=${id}::uuid FOR UPDATE`;
    }
    const current = await profiles.actor(tx, actor, undefined, true);
    profiles.verified(current);
    recent(current, providerId);
    return current.user.id;
  }

  async function prior(
    tx: Prisma.TransactionClient, providerId: string, actorId: string, command: z.infer<typeof linkCommand>,
  ) {
    const link = await tx.stripePayoutDestinationLink.findUnique({
      where: { providerId_requestKey: { providerId, requestKey: command.requestKey } },
    });
    if (!link) return null;
    if (link.linkedBy !== actorId || link.stripeAccountId !== command.accountId || link.destinationRevision !== command.destinationRevision ||
      link.replacesId !== command.expectedLinkId || link.reason !== command.reason) {
      throw new PublicError(409, 'REQUEST_KEY_REUSED', 'Use a new request key for a different Stripe destination change.');
    }
    return present(link);
  }

  @ApiTags('Stripe test payout destinations')
  @ApiBearerAuth()
  @Controller('admin/providers/:id/stripe-destination')
  class StripeDestinationsController {
    @Get()
    @ApiParam({ name: 'id', format: 'uuid' })
    @ApiOkResponse({ schema: schema(linksView) })
    async get(@Req() req: Request, @Param('id') rawId: string) {
      await admin(req);
      const providerId = parse(uuid, rawId).toLowerCase();
      return db.$transaction(async tx => {
        const provider = await tx.authUser.findUnique({ where: { id: providerId }, select: {
          disabledAt: true, emailVerifiedAt: true, roles: true, payout: { select: { revision: true, status: true } },
        } });
        if (!provider) throw new PublicError(404, 'PROVIDER_NOT_FOUND', 'This provider is unavailable.');
        const active = await activeLink(tx, providerId);
        const history = await tx.stripePayoutDestinationLink.findMany({
          where: { providerId, endedAt: { not: null } }, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], take: 20,
        });
        const matches = active && provider.payout?.revision === active.destinationRevision && provider.payout.status === 'approved' &&
          !provider.disabledAt && provider.emailVerifiedAt && provider.roles.some(role => role === 'artist' || role === 'renter');
        const approved = matches && await tx.payoutDestinationVersion.findUnique({
          where: { userId_revision: { userId: providerId, revision: active.destinationRevision } }, select: { status: true },
        });
        return { activeLink: active && present(active), matchesApprovedDestination: Boolean(approved && approved.status === 'approved'),
          history: history.map(present) };
      }, { isolationLevel: 'RepeatableRead' });
    }

    @Post()
    @HttpCode(200)
    @ApiParam({ name: 'id', format: 'uuid' })
    @ApiBody({ schema: schema(linkCommand) })
    @ApiOkResponse({ schema: schema(linkView) })
    async link(@Req() req: Request, @Param('id') rawId: string, @Body() raw: unknown) {
      const providerId = parse(uuid, rawId).toLowerCase();
      const actor = await mutation(req, providerId);
      const command = parse(linkCommand, raw);
      command.expectedLinkId = command.expectedLinkId?.toLowerCase() ?? null;
      const replay = await prior(db, providerId, actor.user.id, command);
      if (replay) return replay;

      const key = auth.config.STRIPE_TEST_SECRET_KEY;
      if (!key) throw new PublicError(503, 'STRIPE_UNAVAILABLE', 'Stripe test account verification is unavailable.');
      await auth.limits.check('stripe-capabilities-admin', actor.user.id, 8, 60);
      await auth.limits.check('stripe-capabilities-shared', 'shared', 12, 60);
      const evidence = await verifyStripeTestDestination(key, command.accountId);
      if (!evidence) {
        throw new PublicError(409, 'STRIPE_DESTINATION_UNVERIFIED', 'Verify the connected account under the configured Stripe test platform.');
      }

      return db.$transaction(async tx => {
        const actorId = await lockedAdmin(tx, actor, providerId);
        const duplicate = await prior(tx, providerId, actorId, command);
        if (duplicate) return duplicate;
        const provider = await tx.authUser.findUnique({ where: { id: providerId }, select: { roles: true } });
        if (!provider?.roles.some(role => role === 'artist' || role === 'renter')) {
          throw new PublicError(404, 'PROVIDER_NOT_FOUND', 'This provider is unavailable.');
        }
        await assertReviewedDestination(tx, providerId, command.destinationRevision);
        const previous = await activeLink(tx, providerId);
        if ((previous?.id ?? null) !== command.expectedLinkId) throw changed();
        if (previous) {
          await tx.stripePayoutDestinationLink.update({
            where: { id: previous.id }, data: { endedBy: actorId, endedAt: new Date(), endKind: 'replace', endReason: command.reason },
          });
        }
        const id = randomUUID();
        const wrote = await tx.stripePayoutDestinationLink.createMany({
          data: {
            id, providerId, destinationRevision: command.destinationRevision, linkedBy: actorId,
            requestKey: command.requestKey, replacesId: command.expectedLinkId, reason: command.reason, ...evidence,
          },
          skipDuplicates: true,
        });
        if (!wrote.count) {
          throw new PublicError(409, 'STRIPE_DESTINATION_IN_USE', 'The Stripe connected account is already linked.');
        }
        return present(await tx.stripePayoutDestinationLink.findUniqueOrThrow({ where: { id } }));
      });
    }

    @Post('revoke')
    @HttpCode(200)
    @ApiParam({ name: 'id', format: 'uuid' })
    @ApiBody({ schema: schema(revokeCommand) })
    @ApiOkResponse({ schema: schema(linkView) })
    async revoke(@Req() req: Request, @Param('id') rawId: string, @Body() raw: unknown) {
      const providerId = parse(uuid, rawId).toLowerCase();
      const actor = await mutation(req, providerId);
      const command = parse(revokeCommand, raw);
      return db.$transaction(async tx => {
        const actorId = await lockedAdmin(tx, actor, providerId);
        const link = await tx.stripePayoutDestinationLink.findFirst({ where: { id: command.expectedLinkId, providerId } });
        if (!link) throw changed();
        if (link.endedAt) {
          if (link.endKind === 'revoke' && link.endedBy === actorId && link.endReason === command.reason) return present(link);
          throw changed();
        }
        return present(await tx.stripePayoutDestinationLink.update({
          where: { id: link.id }, data: { endedBy: actorId, endedAt: new Date(), endKind: 'revoke', endReason: command.reason },
        }));
      });
    }
  }
  return StripeDestinationsController;
}
