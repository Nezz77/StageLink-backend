BEGIN;

ALTER TABLE manual_sandbox_payouts
  ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  DROP CONSTRAINT manual_sandbox_payouts_payout_id_key,
  ADD CONSTRAINT manual_sandbox_payouts_payout_id_revision_key UNIQUE (payout_id, revision);

-- Flagged evidence remains in history. Reserve one slot for the active or settled revision.
CREATE UNIQUE INDEX manual_sandbox_payouts_one_open_or_settled
ON manual_sandbox_payouts (payout_id)
WHERE reviewed_at IS NULL OR journal_id IS NOT NULL;

COMMIT;
