ALTER TABLE bookings
  ADD COLUMN cancelled_at timestamptz(3),
  ADD COLUMN cancellation_reason varchar(500),
  ADD CHECK ((cancelled_at IS NULL) = (cancellation_reason IS NULL));

CREATE TYPE "RefundRequestStatus" AS ENUM ('requested', 'declined', 'approved');

CREATE TABLE refund_requests (
  id uuid PRIMARY KEY,
  booking_id uuid NOT NULL UNIQUE REFERENCES bookings(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  reason varchar(2000) NOT NULL CHECK (length(trim(reason)) >= 10),
  created_at timestamptz(3) NOT NULL,
  status "RefundRequestStatus" NOT NULL DEFAULT 'requested',
  decided_by uuid REFERENCES auth_users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  decided_at timestamptz(3),
  decision_reason varchar(2000),
  CHECK (
    (status = 'requested' AND decided_by IS NULL AND decided_at IS NULL AND decision_reason IS NULL)
    OR (status <> 'requested' AND decided_by IS NOT NULL AND decided_at IS NOT NULL AND decided_at >= created_at
        AND decision_reason IS NOT NULL AND length(trim(decision_reason)) >= 10)
  )
);
CREATE INDEX refund_requests_status_id_idx ON refund_requests(status, id);

CREATE TABLE refund_items (
  request_id uuid NOT NULL REFERENCES refund_requests(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  order_id uuid NOT NULL REFERENCES payment_orders(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  amount_minor integer NOT NULL CHECK (amount_minor > 0),
  reservation_id uuid UNIQUE REFERENCES journal_transactions(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  PRIMARY KEY (request_id, order_id)
);
CREATE INDEX refund_items_order_id_idx ON refund_items(order_id);
