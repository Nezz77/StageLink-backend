CREATE TYPE "ArbitrationMode" AS ENUM ('refund', 'provider', 'split');
CREATE TABLE booking_disputes (
  id uuid PRIMARY KEY,
  booking_id uuid NOT NULL UNIQUE REFERENCES bookings(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  opened_by uuid NOT NULL REFERENCES auth_users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  subject varchar(140) NOT NULL CHECK (length(trim(subject)) >= 3),
  body varchar(2000) NOT NULL CHECK (length(trim(body)) >= 20),
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  dismissed_at timestamptz(3),
  dismissed_by uuid REFERENCES auth_users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  dismissal_reason varchar(2000),
  CHECK ((dismissed_at IS NULL AND dismissed_by IS NULL AND dismissal_reason IS NULL)
    OR (dismissed_at IS NOT NULL AND dismissed_by IS NOT NULL AND dismissal_reason IS NOT NULL
        AND length(trim(dismissal_reason)) >= 10))
);

CREATE TABLE booking_dispute_attachments (
  dispute_id uuid NOT NULL REFERENCES booking_disputes(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  asset_id uuid NOT NULL REFERENCES assets(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  position integer NOT NULL CHECK (position BETWEEN 0 AND 4),
  PRIMARY KEY (dispute_id, asset_id),
  UNIQUE (dispute_id, position)
);
CREATE INDEX booking_dispute_attachments_asset_id_idx ON booking_dispute_attachments(asset_id);

CREATE TABLE arbitration_decisions (
  id uuid PRIMARY KEY,
  dispute_id uuid NOT NULL UNIQUE REFERENCES booking_disputes(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  decided_by uuid NOT NULL REFERENCES auth_users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  provider_id uuid NOT NULL REFERENCES auth_users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  destination_revision integer,
  mode "ArbitrationMode" NOT NULL,
  held_minor integer NOT NULL CHECK (held_minor > 0),
  refund_minor integer NOT NULL CHECK (refund_minor >= 0),
  fee_minor integer NOT NULL CHECK (fee_minor >= 0),
  payout_minor integer NOT NULL CHECK (payout_minor >= 0),
  reason varchar(2000) NOT NULL CHECK (length(trim(reason)) >= 10),
  reservation_id uuid NOT NULL UNIQUE REFERENCES journal_transactions(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT arbitration_decisions_destination_fkey FOREIGN KEY (provider_id, destination_revision)
    REFERENCES payout_destination_versions(user_id, revision) ON DELETE RESTRICT ON UPDATE CASCADE,
  CHECK (held_minor::bigint = refund_minor::bigint + fee_minor + payout_minor),
  CHECK ((payout_minor > 0) = (destination_revision IS NOT NULL)),
  CHECK (
    (mode = 'refund' AND refund_minor = held_minor)
    OR (mode = 'provider' AND refund_minor = 0)
    OR (mode = 'split' AND refund_minor > 0 AND refund_minor < held_minor)
  )
);

CREATE TABLE arbitration_sources (
  decision_id uuid NOT NULL REFERENCES arbitration_decisions(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  order_id uuid NOT NULL UNIQUE REFERENCES payment_orders(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  captured_minor integer NOT NULL CHECK (captured_minor > 0),
  refund_minor integer NOT NULL CHECK (refund_minor BETWEEN 0 AND captured_minor),
  PRIMARY KEY (decision_id, order_id)
);
