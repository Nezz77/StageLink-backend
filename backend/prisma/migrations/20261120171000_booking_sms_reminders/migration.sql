CREATE TYPE "SmsReminderStatus" AS ENUM ('queued', 'sending', 'accepted', 'delivered', 'failed', 'unknown', 'cancelled');

CREATE TABLE booking_sms_reminders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid NOT NULL REFERENCES bookings(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  recipient_id uuid NOT NULL REFERENCES auth_users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  starts_at timestamptz(3) NOT NULL,
  due_at timestamptz(3) NOT NULL,
  offset_hours integer NOT NULL CHECK (offset_hours IN (2, 24)),
  status "SmsReminderStatus" NOT NULL DEFAULT 'queued',
  target_digest char(64),
  provider_id varchar(120) UNIQUE,
  sending_at timestamptz(3),
  checked_at timestamptz(3),
  last_code varchar(80),
  CHECK (due_at = starts_at - offset_hours * interval '1 hour'),
  CHECK ((target_digest IS NULL) = (sending_at IS NULL)),
  CHECK (status <> 'sending' OR sending_at IS NOT NULL),
  CHECK (status NOT IN ('accepted', 'delivered') OR (provider_id IS NOT NULL AND sending_at IS NOT NULL)),
  UNIQUE (booking_id, recipient_id, starts_at, offset_hours)
);

CREATE INDEX booking_sms_reminders_status_due_at_idx ON booking_sms_reminders(status, due_at);
CREATE INDEX booking_sms_reminders_recipient_id_due_at_idx ON booking_sms_reminders(recipient_id, due_at);
CREATE INDEX booking_sms_reminders_sending_at_idx ON booking_sms_reminders(sending_at);
