ALTER TABLE payhere_events
  ADD COLUMN source varchar(12) NOT NULL DEFAULT 'webhook',
  ADD CONSTRAINT payhere_events_source_check CHECK (
    source = 'webhook' OR (source = 'retrieval' AND status_code = '2' AND journal_id IS NOT NULL)
  );

CREATE TABLE payment_recovery_actions (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES payment_orders(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  actor_id uuid NOT NULL REFERENCES auth_users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  request_key uuid NOT NULL,
  gateway varchar(7) NOT NULL CHECK (gateway IN ('stripe', 'payhere')),
  attempt_id uuid NOT NULL,
  provider_reference varchar(150) NOT NULL,
  reason varchar(500) NOT NULL CHECK (length(trim(reason)) >= 10),
  previous_status "PaymentOrderStatus" NOT NULL,
  outcome varchar(8) NOT NULL CHECK (outcome IN ('captured', 'expired')),
  journal_id uuid UNIQUE REFERENCES journal_transactions(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  observed_at timestamptz(3) NOT NULL,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  UNIQUE (order_id, request_key),
  CHECK ((outcome = 'captured' AND journal_id IS NOT NULL)
    OR (gateway = 'stripe' AND outcome = 'expired' AND journal_id IS NULL))
);
