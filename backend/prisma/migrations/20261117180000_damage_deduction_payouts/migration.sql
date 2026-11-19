ALTER TABLE payout_orders
  ADD COLUMN damage_claim_id uuid UNIQUE REFERENCES damage_claims(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT payout_orders_damage_deduction_fee CHECK (damage_claim_id IS NULL OR platform_fee_minor = 0),
  DROP CONSTRAINT payout_orders_booking_id_key;

CREATE UNIQUE INDEX payout_orders_one_service_payout ON payout_orders(booking_id) WHERE damage_claim_id IS NULL;
CREATE INDEX payout_orders_booking_id_idx ON payout_orders(booking_id);
