ALTER TABLE stripe_payout_transfers
  DROP CONSTRAINT stripe_payout_transfers_payout_id_key,
  ADD COLUMN attempt integer NOT NULL DEFAULT 1 CHECK (attempt > 0),
  ADD COLUMN retry_authorized_at timestamptz(3),
  ADD COLUMN retry_authorized_by uuid REFERENCES auth_users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD COLUMN retry_reason varchar(500),
  ADD UNIQUE (payout_id, attempt),
  ADD CONSTRAINT stripe_payout_transfers_retry_check CHECK (
    (retry_authorized_at IS NULL AND retry_authorized_by IS NULL AND retry_reason IS NULL)
    OR (retry_authorized_at IS NOT NULL AND retry_authorized_by IS NOT NULL AND retry_reason IS NOT NULL
      AND length(trim(retry_reason)) >= 10 AND status = 'review_required'
      AND reversed_minor = amount_minor AND journal_id IS NOT NULL AND lease_id IS NULL)
  );

CREATE UNIQUE INDEX stripe_payout_transfers_one_active
  ON stripe_payout_transfers (payout_id) WHERE retry_authorized_at IS NULL;
