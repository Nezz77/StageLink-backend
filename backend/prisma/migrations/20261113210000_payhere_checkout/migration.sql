CREATE TABLE payhere_attempts (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL UNIQUE REFERENCES payment_orders(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  created_at timestamptz(3) NOT NULL,
  expires_at timestamptz(3) NOT NULL CHECK (expires_at > created_at)
);

CREATE TABLE payhere_events (
  attempt_id uuid NOT NULL REFERENCES payhere_attempts(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  status_code varchar(2) NOT NULL CHECK (status_code IN ('2','0','-1','-2','-3')),
  reported_payment_id varchar(120) NOT NULL,
  received_at timestamptz(3) NOT NULL DEFAULT now(),
  journal_id uuid UNIQUE REFERENCES journal_transactions(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  PRIMARY KEY (attempt_id, status_code)
);
