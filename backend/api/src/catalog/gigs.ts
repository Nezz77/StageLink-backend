import { Body, Controller, Get, HttpCode, Param, Patch, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOkResponse, ApiParam, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import type { ArtistGig, ArtistGigVersion } from '../../../generated/prisma/client.js';
import type { AuthService, Identity } from '../auth/service.js';
import { PublicError } from '../auth/errors.js';
import { ProfileService } from '../profiles/service.js';

const uuid = z.string().uuid();
const revision = z.number().int().positive().max(2_147_483_647);
const gigFields = z.object({
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(2000),
  priceMinor: z.number().int().positive().max(100_000_000),
}).strict();
const editFields = gigFields.extend({ revision });
const transitionFields = z.object({ revision, action: z.enum(['publish', 'pause', 'archive']) }).strict();
const publicGig = gigFields.extend({ id: uuid, ownerId: uuid, version: revision, currency: z.literal('LKR') });
const ownerGig = publicGig.extend({
  revision, status: z.enum(['draft', 'published', 'paused', 'archived']),
  publishedVersion: revision.nullable(),
});
const schema = (value: z.ZodType) => z.toJSONSchema(value, { target: 'openapi-3.0' }) as import('@nestjs/swagger').SchemaObject;
const missing = () => new PublicError(404, 'GIG_NOT_FOUND', 'This gig is not available.');

function parse<T>(type: z.ZodType<T>, value: unknown): T {
  const result = type.safeParse(value);
  if (!result.success) throw new PublicError(400, 'INVALID_GIG_INPUT', 'Check the gig details and try again.');
  return result.data;
}

function present(gig: ArtistGig, version: ArtistGigVersion) {
  return {
    id: gig.id, ownerId: gig.ownerId, version: version.version, currency: 'LKR' as const,
    title: version.title, description: version.description, priceMinor: version.priceMinor,
  };
}

export function makeGigControllers(auth: AuthService) {
  const profiles = new ProfileService(auth);
  const db = auth.deps.db;
  const actor = (req: Request) => auth.authenticate(req.get('Authorization'));

  async function mutation(req: Request) {
    if (req.get('Origin') !== auth.config.WEB_ORIGIN || req.get('Sec-Fetch-Site') === 'cross-site' || !req.is('application/json')) {
      throw new PublicError(403, 'ORIGIN_REJECTED', 'Open StageLink in its own browser tab and try again.');
    }
    const identity = await actor(req);
    profiles.checkCsrf(identity, req.get('X-CSRF-Token'));
    return identity;
  }

  function ownerView(gig: ArtistGig, version: ArtistGigVersion) {
    return { ...present(gig, version), revision: gig.revision, status: gig.status, publishedVersion: gig.publishedVersion };
  }

  async function change(identity: Identity, id: string, input: z.infer<typeof editFields> | z.infer<typeof transitionFields>) {
    return db.$transaction(async tx => {
      const current = await profiles.actor(tx, identity);
      profiles.providerRole(current, 'artist');
      const gig = await tx.artistGig.findFirst({
        where: { id, ownerId: current.user.id },
        include: { versions: { orderBy: { version: 'desc' }, take: 1 } },
      });
      if (!gig) throw missing();
      if (gig.revision !== input.revision) throw new PublicError(409, 'REVISION_CONFLICT', 'Reload the latest gig before saving.');
      if (gig.status === 'archived') throw new PublicError(409, 'GIG_ARCHIVED', 'Archived gigs cannot be changed.');

      const nextRevision = gig.revision + 1;
      let [version] = gig.versions;
      if (!version) throw new Error('Gig version is missing.');
      const data: Partial<Pick<ArtistGig, 'status' | 'publishedVersion'>> = {};
      if ('action' in input) {
        switch (input.action) {
          case 'publish': {
            profiles.verified(current);
            const profile = await tx.providerProfile.findUnique({ where: { userId_kind: { userId: current.user.id, kind: 'artist' } } });
            if (!profile?.approvedRevision || !profile.approvedSnapshot) {
              throw new PublicError(409, 'ARTIST_PROFILE_NOT_APPROVED', 'An approved artist profile is required to publish.');
            }
            data.status = 'published';
            data.publishedVersion = version.version;
            break;
          }
          case 'pause':
            if (gig.status !== 'published') throw new PublicError(409, 'GIG_NOT_PUBLISHED', 'Only published gigs can be paused.');
            data.status = 'paused';
            break;
          case 'archive':
            data.status = 'archived';
            break;
        }
      } else {
        const { revision: _revision, ...fields } = input;
        version = await tx.artistGigVersion.create({ data: { gigId: id, version: nextRevision, ...fields } });
      }
      const updated = await tx.artistGig.update({
        where: { id }, data: { ...data, revision: nextRevision, updatedAt: new Date() },
      });
      return ownerView(updated, version);
    });
  }

  @ApiTags('Artist gigs')
  @ApiBearerAuth()
  @Controller('me/gigs')
  class GigsController {
    @Get()
    @ApiOkResponse({ schema: schema(z.array(ownerGig)) })
    async list(@Req() req: Request) {
      const identity = await actor(req);
      profiles.providerRole(identity, 'artist');
      const gigs = await db.artistGig.findMany({
        where: { ownerId: identity.user.id, status: { not: 'archived' } },
        include: { versions: { orderBy: { version: 'desc' }, take: 1 } },
        orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
      });
      return gigs.map(gig => {        const [version] = gig.versions;        if (!version) throw new Error('Gig version is missing.');        return ownerView(gig, version);      });
    }

    @Post()
    @HttpCode(200)
    @ApiBody({ schema: schema(gigFields) })
    @ApiOkResponse({ schema: schema(ownerGig) })
    async create(@Req() req: Request, @Body() body: unknown) {
      const identity = await mutation(req);
      const fields = parse(gigFields, body);
      return db.$transaction(async tx => {
        const current = await profiles.actor(tx, identity);
        profiles.providerRole(current, 'artist');
        const gig = await tx.artistGig.create({ data: { ownerId: current.user.id } });
        const version = await tx.artistGigVersion.create({ data: { gigId: gig.id, version: 1, ...fields } });
        return ownerView(gig, version);
      });
    }

    @Patch(':id')
    @ApiParam({ name: 'id', format: 'uuid' })
    @ApiBody({ schema: schema(editFields) })
    @ApiOkResponse({ schema: schema(ownerGig) })
    async edit(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
      return change(await mutation(req), parse(uuid, id), parse(editFields, body));
    }

    @Post(':id/status')
    @HttpCode(200)
    @ApiParam({ name: 'id', format: 'uuid' })
    @ApiBody({ schema: schema(transitionFields) })
    @ApiOkResponse({ schema: schema(ownerGig) })
    async transition(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
      return change(await mutation(req), parse(uuid, id), parse(transitionFields, body));
    }
  }

  @ApiTags('Public catalog')
  @Controller('listings')
  class PublicGigsController {
    @Get(':id')
    @ApiParam({ name: 'id', format: 'uuid' })
    @ApiOkResponse({ schema: schema(publicGig) })
    async detail(@Param('id') id: string) {
      const gig = await db.artistGig.findFirst({
        where: {
          id: parse(uuid, id), status: 'published',
          owner: {
            disabledAt: null, emailVerifiedAt: { not: null }, roles: { has: 'artist' },
            providers: { some: { kind: 'artist', approvedRevision: { not: null } } },
          },
        },
        include: { publication: true },
      });
      if (!gig?.publication) throw missing();
      return present(gig, gig.publication);
    }
  }

  return [GigsController, PublicGigsController];
}
