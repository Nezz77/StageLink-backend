import { z } from 'zod';

const networkUrl = (protocols: string[]) => z.string().url().refine(value =>
  { try { return protocols.includes(new URL(value).protocol); } catch { return false; } }, 'Unsupported protocol');
const optionalSetting = <T extends z.ZodType>(type: T) => z.preprocess(value => value === '' ? undefined : value, type.optional());
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  AUTH_JWT_SECRET: z.string().regex(/^[0-9a-f]{64}$/),
  AUTH_MAIL_KEY: z.string().regex(/^[0-9a-f]{64}$/),
  PAYOUT_DATA_KEY: z.string().regex(/^[0-9a-f]{64}$/),
  AUTH_RATE_PREFIX: z.string().regex(/^[a-zA-Z0-9:_-]{1,96}$/).default('stagelink-auth-v1'),
  PROMOTIONAL_EMAIL_DELIVERY: z.enum(['true', 'false']).default('false'),
  PROMOTIONAL_EMAIL_HOURLY_LIMIT: z.coerce.number().int().min(1).max(1000).default(100),
  PROMOTIONAL_UNSUBSCRIBE_ORIGIN: optionalSetting(z.url({ protocol: /^https$/ }).refine(value => {
    try { return new URL(value).origin === value; } catch { return false; }
  }, 'Must be an HTTPS origin without a trailing slash or path')),
  BOOKING_EMAIL_REMINDERS: z.enum(['true','false']).default('false'),
  SMTP_HOST: z.string().min(1).max(253).default('127.0.0.1'),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(1025),
  SMTP_SECURE: z.enum(['true','false']).default('false'),
  SMTP_FROM: z.string().email().default('noreply@stagelink.local'),
  SMTP_USER: z.string().optional(), SMTP_PASSWORD: z.string().optional(),

  MEDIA_DRIVER: z.enum(['local-s3','aws']).default('local-s3'),
  S3_REGION: z.string().regex(/^[a-z0-9-]{3,40}$/).default('us-east-1'),
  S3_BUCKET: z.string().regex(/^[a-z0-9][a-z0-9-]{2,62}$/).default('stagelink-media'),
  S3_ENDPOINT: networkUrl(['http:', 'https:']).default('http://127.0.0.1:59090'),

  DATABASE_URL: networkUrl(['postgresql:', 'postgres:']),
  REDIS_URL: networkUrl(['redis:', 'rediss:']),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  AI_SERVICE_ORIGIN: optionalSetting(z.url().refine(value => {
    try {
      const url = new URL(value);
      return ['http:', 'https:'].includes(url.protocol) && url.origin === value;
    } catch { return false; }
  })),
  AI_INTERNAL_TOKEN: optionalSetting(z.string().regex(/^[a-f0-9]{64}$/)),
  AI_GENERATION_DAILY_LIMIT: z.coerce.number().int().min(1).max(500).default(20),
  AI_EMBEDDING_MODEL: optionalSetting(z.enum(['text-embedding-3-small', 'text-embedding-3-large'])),
  AI_EMBEDDING_DAILY_LIMIT: z.coerce.number().int().min(1).max(500).default(20),
  AI_SEMANTIC_RECOMMENDATIONS: z.enum(['true', 'false']).default('false'),
  AI_SEMANTIC_DAILY_LIMIT: z.coerce.number().int().min(1).max(500).default(20),
  AI_PREVIEW_DAILY_LIMIT: z.coerce.number().int().min(1).max(200).default(20),
  WORKER_HEALTH_PORT: z.coerce.number().int().min(1).max(65535).default(4001),
  STRIPE_TEST_REFUND_EXECUTION: z.enum(['true', 'false']).default('false'),
  STRIPE_TEST_SECRET_KEY: optionalSetting(z.string().regex(/^sk_test_[A-Za-z0-9_]{1,250}$/)),
  STRIPE_TEST_WEBHOOK_SECRET: optionalSetting(z.string().regex(/^whsec_[A-Za-z0-9_]{1,250}$/)),
  PAYHERE_SANDBOX_MERCHANT_ID: optionalSetting(z.string().regex(/^\d{1,30}$/)),
  PAYHERE_SANDBOX_MERCHANT_SECRET: optionalSetting(z.string().min(1).max(256)),
  PAYHERE_SANDBOX_RETRIEVAL_APP_ID: optionalSetting(z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)),
  PAYHERE_SANDBOX_RETRIEVAL_APP_SECRET: optionalSetting(z.string().regex(/^[A-Za-z0-9_-]{1,256}$/)),
  PAYHERE_SANDBOX_NOTIFY_URL: optionalSetting(z.url({ protocol: /^https$/ }).refine(value => {
    const url = new URL(value);
    return !url.username && !url.password && !url.search && !url.hash &&
      url.pathname === '/api/v1/payments/webhooks/payhere';
  })),
  WEB_ORIGIN: z.string().url().default('http://localhost:3000').refine(value => {
    try {
      const url = new URL(value);
      return ['http:', 'https:'].includes(url.protocol) && url.origin === value;
    } catch { return false; }
  }, 'Must be an HTTP origin without a trailing slash or path'),
}).superRefine((config, ctx) => {
  if (Boolean(config.STRIPE_TEST_SECRET_KEY) !== Boolean(config.STRIPE_TEST_WEBHOOK_SECRET)) {
    ctx.addIssue({ code: 'custom', path: ['STRIPE_TEST_SECRET_KEY'], message: 'Configure both Stripe test settings together.' });
  }
  if (Boolean(config.PAYHERE_SANDBOX_RETRIEVAL_APP_ID) !== Boolean(config.PAYHERE_SANDBOX_RETRIEVAL_APP_SECRET)) {
    ctx.addIssue({ code: 'custom', path: ['PAYHERE_SANDBOX_RETRIEVAL_APP_ID'], message: 'Configure both PayHere retrieval settings together.' });
  }
  if (config.STRIPE_TEST_REFUND_EXECUTION === 'true' && !config.STRIPE_TEST_SECRET_KEY) {
    ctx.addIssue({ code: 'custom', path: ['STRIPE_TEST_REFUND_EXECUTION'], message: 'Configure Stripe test credentials for refund execution.' });
  }
  const payHereSettings = [config.PAYHERE_SANDBOX_MERCHANT_ID, config.PAYHERE_SANDBOX_MERCHANT_SECRET, config.PAYHERE_SANDBOX_NOTIFY_URL];
  if (payHereSettings.some(Boolean) && !payHereSettings.every(Boolean)) {
    ctx.addIssue({ code: 'custom', path: ['PAYHERE_SANDBOX_MERCHANT_ID'], message: 'Configure all PayHere sandbox settings together.' });
  }
  if (new Set([config.AUTH_JWT_SECRET, config.AUTH_MAIL_KEY, config.PAYOUT_DATA_KEY]).size !== 3) ctx.addIssue({ code: 'custom', path: ['AUTH_MAIL_KEY'], message: 'Keys must differ' });
  if (Boolean(config.SMTP_USER) !== Boolean(config.SMTP_PASSWORD)) ctx.addIssue({ code: 'custom', path: ['SMTP_USER'], message: 'SMTP credentials must be paired' });
  if(config.NODE_ENV==='production'&&config.MEDIA_DRIVER!=='aws')ctx.addIssue({code:'custom',path:['MEDIA_DRIVER'],message:'AWS required in production'});
  if (config.NODE_ENV === 'production' && !config.WEB_ORIGIN.startsWith('https://')) ctx.addIssue({ code: 'custom', path: ['WEB_ORIGIN'], message: 'HTTPS required' });
});
export type Config = z.infer<typeof schema>;
export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = schema.safeParse(env);
  // Never include values, passwords or URLs in configuration errors.
  if (!result.success) throw new Error('Invalid configuration: ' +
    [...new Set(result.error.issues.map(issue => issue.path.join('.')))].join(', '));
  return result.data;
}
