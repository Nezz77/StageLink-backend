import { z } from 'zod';
import { createMailer } from './auth-mail.js';
import type { Config } from './config.js';
export const communicationSecurity = z.enum(['implicit_tls', 'starttls_required', 'development']);
export const communicationState = z.object({
    checkedAt: z.iso.datetime(),
    email: z.object({ bookingRemindersEnabled: z.boolean(), promotionalEnabled: z.boolean(), security: communicationSecurity, authenticationConfigured: z.boolean() }),
    sms: z.object({ providerConfigured: z.boolean(), verificationEnabled: z.boolean(), bookingRemindersEnabled: z.boolean(), promotionalEnabled: z.boolean(), hourlyLimit: z.number().int().positive() }),
});
export const smtpCheckResult = z.object({ connection: z.enum(['ready', 'unavailable']), security: communicationSecurity, latencyMs: z.number().int().nonnegative(), messageSent: z.literal(false), code: z.string().nullable(), checkedAt: z.iso.datetime() });
export const transportSecurity = (config: Config) => config.SMTP_SECURE === 'true' ? 'implicit_tls' as const : config.NODE_ENV === 'production' ? 'starttls_required' as const : 'development' as const;
type SmtpConnection = {
    verify: () => Promise<boolean>;
    close: () => void;
};
// SMTP verification negotiates/authenticates a connection; it never submits a message.
export async function checkSmtp(config: Config, factory: (config: Config) => SmtpConnection = createMailer) {
    const started = performance.now();
    let transport: SmtpConnection | undefined;
    let ready = false;
    try {
        transport = factory(config);
        ready = await transport.verify();
    }
    catch {
        // Provider errors may contain host names, credentials or private server replies.
    }
    finally {
        try {
            transport?.close();
        }
        catch {
            ready = false;
        }
    }
    return { connection: ready ? 'ready' as const : 'unavailable' as const,
        security: transportSecurity(config), latencyMs: Math.max(0, Math.round(performance.now() - started)), messageSent: false as const,
        code: ready ? null : 'SMTP_CONNECTION_UNAVAILABLE' };
}
