ALTER TABLE payhere_refund_executions
  ADD COLUMN arbitration_id uuid,
  ADD CONSTRAINT payhere_refund_executions_arbitration_source_fkey
    FOREIGN KEY (arbitration_id, order_id) REFERENCES arbitration_sources(decision_id, order_id)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT payhere_refund_executions_arbitration_id_order_id_key UNIQUE (arbitration_id, order_id),
  DROP CONSTRAINT payhere_refund_executions_one_reservation,
  ADD CONSTRAINT payhere_refund_executions_one_reservation
    CHECK (num_nonnulls(request_id, damage_claim_id, arbitration_id) = 1);
