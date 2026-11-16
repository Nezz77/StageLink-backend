CREATE TABLE payout_destination_repairs (
  id uuid PRIMARY KEY,
  payout_id uuid NOT NULL REFERENCES payout_orders(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  request_key uuid NOT NULL,
  previous_destination_revision integer NOT NULL CHECK (previous_destination_revision > 0),
  destination_revision integer NOT NULL CHECK (destination_revision > previous_destination_revision),
  actor_id uuid NOT NULL REFERENCES auth_users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  reason varchar(500) NOT NULL CHECK (length(trim(reason)) >= 10),
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  UNIQUE (payout_id, request_key),
  UNIQUE (payout_id, destination_revision)
);
