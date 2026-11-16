CREATE TABLE stripe_payout_transfer_events (
  id varchar(150) PRIMARY KEY,
  transfer_id uuid NOT NULL REFERENCES stripe_payout_transfers(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  event_type varchar(80) NOT NULL CHECK (event_type IN ('transfer.created', 'transfer.reversed')),
  observed_reversed_minor integer NOT NULL CHECK (observed_reversed_minor >= 0),
  created_at timestamptz(3) NOT NULL,
  received_at timestamptz(3) NOT NULL DEFAULT now()
);

CREATE INDEX stripe_payout_transfer_events_transfer_id_idx ON stripe_payout_transfer_events (transfer_id);
