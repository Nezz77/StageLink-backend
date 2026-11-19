ALTER TABLE payout_orders
  ADD COLUMN arbitration_id uuid UNIQUE REFERENCES arbitration_decisions(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT payout_orders_one_allocation CHECK (num_nonnulls(damage_claim_id, arbitration_id) <= 1);

DROP INDEX payout_orders_one_service_payout;
CREATE UNIQUE INDEX payout_orders_one_service_payout ON payout_orders(booking_id)
  WHERE damage_claim_id IS NULL AND arbitration_id IS NULL;
