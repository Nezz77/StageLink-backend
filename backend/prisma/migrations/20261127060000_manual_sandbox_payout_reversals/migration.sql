CREATE TABLE manual_sandbox_payout_reversals (
  id uuid PRIMARY KEY,
  settlement_id uuid NOT NULL UNIQUE REFERENCES manual_sandbox_payouts(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  request_key uuid NOT NULL,
  actor_id uuid NOT NULL REFERENCES auth_users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  reason varchar(500) NOT NULL,
  journal_id uuid NOT NULL UNIQUE REFERENCES journal_transactions(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  created_at timestamptz(3) NOT NULL DEFAULT now()
);
