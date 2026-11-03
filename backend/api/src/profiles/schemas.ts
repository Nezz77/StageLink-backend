import { z } from 'zod';
import { emailSchema } from '../auth/schemas.js';
export const providerKind = z.enum(['artist','renter']);
export type ProviderKind = z.infer<typeof providerKind>;
const short = (max: number) => z.string().trim().max(max);
const revision = z.number().int().min(0).max(2147483646);
const coordinates = { latitude: z.number().min(-90).max(90).nullable(), longitude: z.number().min(-180).max(180).nullable() };
export const memberWrite = z.object({ revision, displayName: short(80).min(2), city: short(100),
  phone: short(32).refine(s => !s || /^[+0-9() -]{7,32}$/.test(s), 'Use a valid phone number'),
  organization: short(120), bio: short(2000) }).strict();
export const memberRead = memberWrite.extend({ email: z.string().email(), emailVerified: z.boolean(), updatedAt: z.string().nullable() });
export const artistDetails = z.object({ category: z.enum(['Vocalist','Band','DJ','Dancer','Instrumentalist']),
  genres: z.array(short(40).min(1)).min(1).max(8).refine(a => new Set(a.map(v=>v.toLowerCase())).size===a.length, 'Genres must be unique'),
  experienceYears: z.number().int().min(0).max(80), baseRateMinor: z.number().int().min(0).max(100000000), currency: z.literal('LKR') }).strict();
const time = z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/);
export const dayHours = z.object({ day: z.number().int().min(0).max(6), opens: time.nullable(), closes: time.nullable() }).strict()
  .refine(d => (d.opens===null&&d.closes===null)||Boolean(d.opens&&d.closes&&d.closes>d.opens), 'Use a closing time after opening; both blank means closed');
export const renterDetails = z.object({ equipmentCategories: z.array(z.enum(['Sound','Lighting','Stage','Instruments','Other'])).min(1).max(5)
  .refine(a=>new Set(a).size===a.length,'Categories must be unique'),
  operatingHours: z.array(dayHours).length(7).refine(a=>new Set(a.map(d=>d.day)).size===7,'Include each day once'),
  rentalTerms: short(2000).min(20), deliveryOffered: z.boolean() }).strict();
const providerBase = { revision, displayName: short(120).min(2), bio: short(2000).min(20), city: short(100).min(2),
  serviceRadiusKm: z.number().int().min(1).max(500), address: short(200), ...coordinates };
const pair = (p: {latitude:number|null;longitude:number|null}) => (p.latitude===null)===(p.longitude===null);
export const artistWrite = z.object({ ...providerBase, details: artistDetails }).strict().refine(pair,'Provide both coordinates or leave both blank');
export const renterWrite = z.object({ ...providerBase, details: renterDetails }).strict().refine(pair,'Provide both coordinates or leave both blank');
export type ProviderWrite = z.infer<typeof artistWrite> | z.infer<typeof renterWrite>;
export const providerPublic = z.object({ userId: z.string().uuid(), kind: providerKind, revision, displayName: z.string(), bio: z.string(),
  city: z.string(), serviceRadiusKm: z.number(), details: z.union([artistDetails,renterDetails]) }).strict();
export const providerRead = providerPublic.omit({userId:true}).extend({ address:z.string(), ...coordinates,
  reviewStatus:z.enum(['draft','pending','approved','rejected']), reviewReason:z.string().nullable(), approvedRevision:revision.nullable(), updatedAt:z.string() });
export const providerEnvelope = z.object({ profile:providerRead.nullable() });
export const revisionBody = z.object({revision}).strict();
export const decisionBody = z.object({ revision, approved:z.boolean(), reason:short(2000).min(10) }).strict();
export const payoutDetails = z.object({holder:short(100).min(2),bank:short(100).min(2),branch:short(100).min(2),number:z.string().regex(/^[0-9]{6,18}$/)}).strict();
export const payoutWrite = payoutDetails.extend({revision,password:z.string().min(1).max(128)}).strict();
export const payoutRead = payoutDetails.omit({number:true}).extend({revision,status:z.enum(['pending','approved','rejected']),accountLast4:z.string().length(4),
  reviewReason:z.string().nullable(),updatedAt:z.string(),transfersEnabled:z.literal(false)});
export const payoutEnvelope = z.object({destination:payoutRead.nullable()});
export const emailChangeBody = z.object({email:emailSchema,password:z.string().min(1).max(128)}).strict();
export const emailPending = z.object({pending:z.object({email:z.string().email(),expiresAt:z.string()}).nullable()});
export const reviewQueue = z.object({providers:z.array(providerPublic.extend({updatedAt:z.string()})),payouts:z.array(z.object({userId:z.string().uuid(),displayName:z.string(),destination:payoutRead})),limitPerQueue:z.literal(25)});
export const message = z.object({message:z.string()});
