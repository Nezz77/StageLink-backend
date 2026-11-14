import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ApiBody, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { PublicError } from '../auth/errors.js';
import { artistDetails } from '../profiles/schemas.js';
import { schema } from '../payments/orders.js';

const input = z.object({ query: z.string().trim().min(1).max(240) }).strict();
const artistCategory = artistDetails.shape.category;
const result = z.object({
  filters: z.object({
    city: z.string().max(100).optional(),
    genre: z.string().max(40).optional(),
    category: artistCategory.optional(),
    maxPriceMinor: z.number().int().min(0).max(100_000_000).optional(),
    q: z.string().max(120).optional(),
  }),
  unparsed: z.string().nullable(),
});

const genreNames = [
  'Acoustic', 'Blues', 'Classical', 'Country', 'EDM', 'Folk', 'Fusion', 'Hip Hop', 'Jazz',
  'Pop', 'R&B', 'Reggae', 'Rock', 'Soul',
];
const categoryAliases = new Map<string, z.infer<typeof artistCategory>>([
  ['vocalist', 'Vocalist'], ['singer', 'Vocalist'], ['band', 'Band'], ['dj', 'DJ'],
  ['dancer', 'Dancer'], ['instrumentalist', 'Instrumentalist'],
]);
const budget = /(?:^|\s)(under|below|up to|at most|within) (?:lkr|rs\.?)\s*((?:\d{1,3}(?:,\d{3})+|\d+))(?:\.(\d{1,2}))?$/i;
const location = /(?:^|\s)in (["“][^"“”]+["”]|[\p{L}\p{M}][\p{L}\p{M}'’.-]*(?:[ -][\p{L}\p{M}][\p{L}\p{M}'’.-]*){0,3})$/iu;
const nonLocationWords = /\b(?:or|and|not|except|tomorrow|today|tonight|next|near|for|on|days?|weeks?|months?|years?)\b/i;
const requestPrefix = /^(?:(?:please )?(?:find(?: me)?|show me|looking for|i(?:'m| am) looking for|i (?:need|want)) )?(?:an? )?/i;

export function parseDiscoveryIntent(query: string): z.infer<typeof result> {
  const filters: z.infer<typeof result>['filters'] = {};
  const normalized = query.replace(/\s+/gu, ' ').trim();
  let remaining = normalized.replace(/[.!?]+$/, '').trim() || normalized;

  const amount = budget.exec(remaining);
  if (amount) {
    const total = Number(amount[2]!.replaceAll(',', '')) * 100 + Number((amount[3] ?? '').padEnd(2, '0'));
    const max = /^(under|below)$/i.test(amount[1]!) ? total - 1 : total;
    if (max >= 0 && max <= 100_000_000) {
      filters.maxPriceMinor = max;
      remaining = remaining.slice(0, amount.index).trimEnd();
    }
  }

  const city = location.exec(remaining);
  if (city) {
    const value = city[1]!;
    const quotedCity = /^["“]/u.test(value);
    const name = value.replace(/^["“]|["”]$/g, '').trim();
    // Keep ambiguous phrases such as "in Colombo or Kandy" available for review.
    if (name && name.length <= 100 && (quotedCity || !nonLocationWords.test(name))) {
      filters.city = name;
      remaining = remaining.slice(0, city.index).trimEnd();
    }
  }

  const act = remaining.replace(requestPrefix, '');
  const quoted = /^["“]([^"“”]{1,120})["”]$/u.exec(act)?.[1]?.trim();
  if (quoted) return { filters: { ...filters, q: quoted }, unparsed: null };

  const lastSpace = act.lastIndexOf(' ');
  const category = categoryAliases.get(act.slice(lastSpace + 1).toLowerCase());
  const genreText = category ? act.slice(0, Math.max(0, lastSpace)) : act;
  const genre = genreNames.find(name => name.toLowerCase() === genreText.toLowerCase());
  if ((category && !genreText) || genre) {
    if (category) filters.category = category;
    if (genre) filters.genre = genre;
    return { filters, unparsed: null };
  }
  return { filters, unparsed: remaining || null };
}

@ApiTags('Public catalog')
@Controller('discovery')
export class DiscoveryIntentController {
  @Post('intent')
  @HttpCode(200)
  @ApiBody({ schema: schema(input) })
  @ApiOkResponse({ schema: schema(result), description: 'Suggested filters for GET /listings and any text the parser could not use.' })
  parse(@Body() body: unknown) {
    const parsed = input.safeParse(body);
    if (!parsed.success) throw new PublicError(400, 'INVALID_DISCOVERY_INTENT', 'Enter a search phrase of up to 240 characters.');
    return parseDiscoveryIntent(parsed.data.query);
  }
}
