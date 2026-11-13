CREATE TABLE booking_payout_holds (
  booking_id uuid NOT NULL REFERENCES bookings(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  revision integer NOT NULL CHECK (revision > 0),
  held boolean NOT NULL,
  reason varchar(500) NOT NULL CHECK (length(trim(reason)) > 0),
  actor_id uuid NOT NULL REFERENCES auth_users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  created_at timestamptz(3) NOT NULL,
  PRIMARY KEY (booking_id, revision)
);

CREATE TABLE payout_orders (
  id uuid PRIMARY KEY,
  booking_id uuid NOT NULL UNIQUE REFERENCES bookings(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  provider_id uuid NOT NULL,
  destination_revision integer NOT NULL,
  created_by uuid NOT NULL REFERENCES auth_users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  created_at timestamptz(3) NOT NULL,
  gross_minor integer NOT NULL CHECK (gross_minor > 0),
  platform_fee_minor integer NOT NULL CHECK (platform_fee_minor >= 0),
  net_minor integer NOT NULL CHECK (net_minor > 0),
  reservation_id uuid NOT NULL UNIQUE REFERENCES journal_transactions(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT payout_orders_destination_fkey FOREIGN KEY (provider_id, destination_revision)
    REFERENCES payout_destination_versions(user_id, revision) ON DELETE RESTRICT ON UPDATE CASCADE,
  CHECK (net_minor::bigint + platform_fee_minor = gross_minor)
);

CREATE INDEX payout_orders_provider_id_idx ON payout_orders(provider_id);
