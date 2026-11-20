CREATE TABLE payhere_refund_recoveries (
  id uuid PRIMARY KEY,
  execution_id uuid NOT NULL UNIQUE REFERENCES payhere_refund_executions(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  request_key uuid NOT NULL,
  actor_id uuid NOT NULL REFERENCES auth_users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  reason varchar(500) NOT NULL CHECK (length(trim(reason)) >= 10),
  attempt_id uuid NOT NULL,
  payment_id varchar(120) NOT NULL,
  amount_minor integer NOT NULL CHECK (amount_minor > 0),
  previous_updated_at timestamptz(3) NOT NULL,
  observed_at timestamptz(3) NOT NULL,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  journal_id uuid NOT NULL UNIQUE REFERENCES journal_transactions(id) ON DELETE RESTRICT ON UPDATE CASCADE
);
