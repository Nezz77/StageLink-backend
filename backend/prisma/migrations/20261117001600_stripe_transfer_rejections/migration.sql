ALTER TABLE stripe_payout_transfers
  ADD COLUMN rejection_code varchar(40),
  ADD COLUMN rejection_request_id varchar(150),
  DROP CONSTRAINT stripe_payout_transfers_check1,
  DROP CONSTRAINT stripe_payout_transfers_retry_check,
  ADD CONSTRAINT stripe_payout_transfers_state_check CHECK (
    (status = 'uncertain' AND provider_transfer_id IS NULL AND journal_id IS NULL) OR
    (status = 'transferred' AND provider_transfer_id IS NOT NULL AND journal_id IS NOT NULL) OR
    (status = 'review_required' AND provider_transfer_id IS NOT NULL) OR
    (status = 'rejected' AND provider_transfer_id IS NULL AND journal_id IS NULL AND lease_id IS NULL)
  ),
  ADD CONSTRAINT stripe_payout_transfers_rejection_check CHECK (
    (status = 'rejected' AND rejection_code IS NOT NULL AND rejection_code = 'balance_insufficient'
      AND rejection_request_id IS NOT NULL AND rejection_request_id ~ '^req_[A-Za-z0-9_]+$')
    OR (status <> 'rejected' AND rejection_code IS NULL AND rejection_request_id IS NULL)
  ),
  ADD CONSTRAINT stripe_payout_transfers_retry_check CHECK (
    (retry_authorized_at IS NULL AND retry_authorized_by IS NULL AND retry_reason IS NULL)
    OR (retry_authorized_at IS NOT NULL AND retry_authorized_by IS NOT NULL AND retry_reason IS NOT NULL
      AND length(trim(retry_reason)) >= 10 AND lease_id IS NULL
      AND (status = 'rejected' OR (status = 'review_required' AND reversed_minor = amount_minor AND journal_id IS NOT NULL)))
  );
