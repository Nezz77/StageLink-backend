CREATE TABLE stripe_attempts (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL UNIQUE REFERENCES payment_orders(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  session_id varchar(150) UNIQUE,
  checkout_url varchar(2048),
  return_url varchar(2048) NOT NULL,
  created_at timestamptz(3) NOT NULL,
  expires_at timestamptz(3) NOT NULL CHECK (expires_at > created_at),
  journal_id uuid UNIQUE REFERENCES journal_transactions(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CHECK (checkout_url IS NULL OR session_id IS NOT NULL)
);

CREATE TABLE stripe_events (
  id varchar(150) PRIMARY KEY,
  attempt_id uuid NOT NULL REFERENCES stripe_attempts(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  event_type varchar(80) NOT NULL,
  created_at timestamptz(3) NOT NULL,
  received_at timestamptz(3) NOT NULL DEFAULT now()
);

CREATE INDEX stripe_events_attempt_id_idx ON stripe_events(attempt_id);
