CREATE TYPE "ReminderStatus" AS ENUM ('queued', 'sending', 'accepted', 'failed', 'unknown', 'cancelled');
CREATE TABLE booking_reminders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid NOT NULL REFERENCES bookings(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  recipient_id uuid NOT NULL REFERENCES auth_users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  starts_at timestamptz(3) NOT NULL,
  due_at timestamptz(3) NOT NULL,
  offset_hours integer NOT NULL CHECK (offset_hours IN (2, 24)),
  status "ReminderStatus" NOT NULL DEFAULT 'queued',
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
  sending_at timestamptz(3),
  accepted_at timestamptz(3),
  last_code varchar(60),
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  CHECK (due_at = starts_at - offset_hours * interval '1 hour'),
  CHECK ((status = 'sending') = (sending_at IS NOT NULL)),
  CHECK ((status = 'accepted') = (accepted_at IS NOT NULL)),
  UNIQUE (booking_id, recipient_id, starts_at, offset_hours)
);
CREATE INDEX booking_reminders_status_due_at_idx ON booking_reminders(status, due_at);
CREATE INDEX bookings_reminder_schedule_idx ON bookings(starts_at) WHERE agreed_at IS NOT NULL AND cancelled_at IS NULL;

CREATE TABLE reminder_admin_actions (
  id uuid PRIMARY KEY,
  reminder_id uuid NOT NULL REFERENCES booking_reminders(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  actor_id uuid NOT NULL REFERENCES auth_users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  action varchar(12) NOT NULL CHECK (action IN ('retry','cancel')),
  reason varchar(500) NOT NULL CHECK (length(trim(reason)) >= 10),
  created_at timestamptz(3) NOT NULL DEFAULT now()
);
CREATE INDEX reminder_admin_actions_reminder_id_idx ON reminder_admin_actions(reminder_id);
