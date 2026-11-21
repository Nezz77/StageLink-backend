import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { createMailer } from '../shared/auth-mail.js';
import { smtpFailureState } from '../shared/booking-reminders.js';
import { readConfig } from '../shared/config.js';

async function main() {
  const recipient = z.email().max(254).parse(process.stdin.isTTY ? null : readFileSync(0, 'utf8').trim());
  const config = readConfig();
  const probeId = randomUUID();
  const mailer = createMailer(config);
  let status: 'accepted' | 'failed' | 'unknown';
  try {
    const result = await mailer.sendMail({
      from: config.SMTP_FROM,
      to: recipient,
      messageId: `<${probeId}@${config.SMTP_FROM.split('@')[1]}>`,
      subject: `StageLink SMTP smoke ${probeId}`,
      text: `Synthetic StageLink SMTP delivery probe ${probeId}.`,
    });
    status = result.accepted?.length === 1 ? 'accepted' : 'unknown';
  } catch (error) {
    status = smtpFailureState(error);
  } finally {
    mailer.close();
  }
  console.log(JSON.stringify({ probeId, status }));
  if (status !== 'accepted') process.exitCode = 1;
}

main().catch(() => {
  console.error('Load the staging worker configuration and pipe one controlled test inbox address through stdin.');
  process.exitCode = 1;
});
