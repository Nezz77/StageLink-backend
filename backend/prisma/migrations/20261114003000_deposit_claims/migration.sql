CREATE TYPE "DamageClaimResponse" AS ENUM ('accepted', 'disputed');

CREATE TABLE damage_claims (
  id uuid PRIMARY KEY,
  booking_id uuid NOT NULL UNIQUE REFERENCES bookings(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  inspection_id uuid NOT NULL,
  report_revision integer NOT NULL,
  deposit_order_id uuid UNIQUE REFERENCES payment_orders(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  deposit_minor integer NOT NULL CHECK (deposit_minor >= 0),
  proposed_minor integer NOT NULL CHECK (proposed_minor >= 0 AND proposed_minor <= deposit_minor),
  reason varchar(2000) NOT NULL CHECK (length(trim(reason)) >= 10),
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  response "DamageClaimResponse",
  response_reason varchar(2000),
  responded_at timestamptz(3),
  deduction_minor integer CHECK (deduction_minor IN (0, proposed_minor)),
  refund_minor integer,
  resolved_at timestamptz(3),
  resolved_by uuid REFERENCES auth_users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  resolution_reason varchar(2000),
  reservation_id uuid UNIQUE REFERENCES journal_transactions(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT damage_claims_report_fkey FOREIGN KEY (inspection_id, report_revision)
    REFERENCES equipment_inspection_reports(inspection_id, revision) ON DELETE RESTRICT ON UPDATE CASCADE,
  CHECK ((deposit_minor = 0) = (deposit_order_id IS NULL)),
  CHECK ((response IS NULL) = (responded_at IS NULL) AND (response IS NULL) = (response_reason IS NULL)),
  CHECK (response IS DISTINCT FROM 'disputed' OR length(trim(response_reason)) >= 10),
  CHECK (
    (resolved_at IS NULL AND deduction_minor IS NULL AND refund_minor IS NULL
     AND resolved_by IS NULL AND resolution_reason IS NULL AND reservation_id IS NULL)
    OR (resolved_at IS NOT NULL AND response IS NOT NULL AND resolved_at >= responded_at
        AND deduction_minor IS NOT NULL AND refund_minor IS NOT NULL AND refund_minor = deposit_minor - deduction_minor
        AND resolved_by IS NOT NULL AND resolution_reason IS NOT NULL AND length(trim(resolution_reason)) >= 10
        AND ((deposit_minor = 0) = (reservation_id IS NULL)))
  )
);
