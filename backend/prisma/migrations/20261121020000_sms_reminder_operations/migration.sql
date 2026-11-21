CREATE TABLE sms_reminder_cancellations (
  reminder_id uuid PRIMARY KEY REFERENCES booking_sms_reminders(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  actor_id uuid NOT NULL REFERENCES auth_users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  reason varchar(500) NOT NULL CHECK (length(btrim(reason)) BETWEEN 10 AND 500),
  created_at timestamptz(3) NOT NULL DEFAULT now()
);
CREATE INDEX sms_reminder_cancellations_actor_id_created_at_idx ON sms_reminder_cancellations(actor_id, created_at);
