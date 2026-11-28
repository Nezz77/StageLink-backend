BEGIN;

ALTER TABLE manual_sandbox_payout_reversals
  ADD CONSTRAINT manual_sandbox_payout_reversals_id_settlement_id_key UNIQUE (id, settlement_id);

ALTER TABLE manual_sandbox_payouts
  ADD COLUMN superseded_reversal_id uuid CHECK (superseded_reversal_id IS NULL OR journal_id IS NOT NULL),
  ADD CONSTRAINT manual_sandbox_payouts_supersession_fkey
    FOREIGN KEY (superseded_reversal_id, id)
    REFERENCES manual_sandbox_payout_reversals (id, settlement_id)
    ON DELETE NO ACTION ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED;

DROP INDEX manual_sandbox_payouts_one_open_or_settled;
CREATE UNIQUE INDEX manual_sandbox_payouts_one_open_or_settled
ON manual_sandbox_payouts (payout_id)
WHERE reviewed_at IS NULL OR (journal_id IS NOT NULL AND superseded_reversal_id IS NULL);

COMMIT;
