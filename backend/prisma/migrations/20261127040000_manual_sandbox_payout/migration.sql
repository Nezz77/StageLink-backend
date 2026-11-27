CREATE TABLE manual_sandbox_payouts (
  id uuid PRIMARY KEY,
  payout_id uuid NOT NULL UNIQUE REFERENCES payout_orders(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  test_reference varchar(80) NOT NULL UNIQUE CHECK (test_reference ~ '^SBX-[A-Z0-9][A-Z0-9-]{3,75}$'),
  amount_minor integer NOT NULL CHECK (amount_minor > 0),
  destination_revision integer NOT NULL CHECK (destination_revision > 0),
  recorded_by uuid NOT NULL REFERENCES auth_users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  record_reason varchar(500) NOT NULL,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  reviewed_by uuid REFERENCES auth_users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  review_reason varchar(500),
  reviewed_at timestamptz(3),
  journal_id uuid UNIQUE REFERENCES journal_transactions(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CHECK (
    (reviewed_by IS NULL AND reviewed_at IS NULL AND review_reason IS NULL AND journal_id IS NULL)
    OR (reviewed_by IS NOT NULL AND reviewed_by <> recorded_by AND reviewed_at IS NOT NULL AND review_reason IS NOT NULL)
  )
);
