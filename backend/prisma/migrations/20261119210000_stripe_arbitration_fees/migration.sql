CREATE TABLE stripe_arbitration_fee_settlements (
  arbitration_id uuid PRIMARY KEY REFERENCES arbitration_decisions(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  amount_minor integer NOT NULL CHECK (amount_minor > 0),
  actor_id uuid NOT NULL REFERENCES auth_users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  journal_id uuid NOT NULL UNIQUE REFERENCES journal_transactions(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  reversal_journal_id uuid UNIQUE REFERENCES journal_transactions(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  review_actor_id uuid REFERENCES auth_users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  CHECK ((reversal_journal_id IS NULL) = (review_actor_id IS NULL))
);
