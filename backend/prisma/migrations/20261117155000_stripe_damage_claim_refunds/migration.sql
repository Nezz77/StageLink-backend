ALTER TABLE stripe_refund_executions
  ALTER COLUMN request_id DROP NOT NULL,
  ADD COLUMN damage_claim_id uuid UNIQUE REFERENCES damage_claims(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT stripe_refund_executions_one_reservation
    CHECK ((request_id IS NOT NULL) <> (damage_claim_id IS NOT NULL));
