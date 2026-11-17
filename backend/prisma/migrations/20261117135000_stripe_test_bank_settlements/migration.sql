CREATE TABLE stripe_bank_payout_settlements (
  id uuid PRIMARY KEY,
  transfer_id uuid NOT NULL REFERENCES stripe_payout_transfers(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  bank_payout_id varchar(150) NOT NULL CHECK (bank_payout_id ~ '^po_[A-Za-z0-9_]+$'),
  balance_transaction_id varchar(150) CHECK (balance_transaction_id ~ '^txn_[A-Za-z0-9_]+$'),
  journal_id uuid UNIQUE REFERENCES journal_transactions(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  reversal_journal_id uuid UNIQUE REFERENCES journal_transactions(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  actor_id uuid NOT NULL REFERENCES auth_users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  review_actor_id uuid REFERENCES auth_users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  review_reason varchar(30),
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  UNIQUE (transfer_id, bank_payout_id),
  CHECK ((journal_id IS NULL) = (balance_transaction_id IS NULL)),
  CHECK (
    (review_reason IS NULL AND review_actor_id IS NULL AND journal_id IS NOT NULL AND reversal_journal_id IS NULL)
    OR (review_reason IS NOT NULL
      AND (review_reason = 'bank_payout_failed' AND review_actor_id IS NOT NULL
        OR review_reason = 'transfer_reversed' AND journal_id IS NOT NULL)
      AND (journal_id IS NULL) = (reversal_journal_id IS NULL))
  )
);

CREATE UNIQUE INDEX stripe_bank_payout_settlements_active_transfer
  ON stripe_bank_payout_settlements (transfer_id) WHERE review_reason IS NULL;
CREATE UNIQUE INDEX stripe_bank_payout_settlements_active_balance_transaction
  ON stripe_bank_payout_settlements (balance_transaction_id) WHERE review_reason IS NULL;
