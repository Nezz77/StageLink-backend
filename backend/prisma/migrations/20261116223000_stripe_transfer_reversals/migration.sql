ALTER TABLE stripe_payout_transfers
  ADD COLUMN reversed_minor integer NOT NULL DEFAULT 0,
  ADD CONSTRAINT stripe_payout_transfers_reversed_minor_check CHECK (
    reversed_minor BETWEEN 0 AND amount_minor
    AND (reversed_minor = 0 OR (status = 'review_required' AND journal_id IS NOT NULL))
  );
