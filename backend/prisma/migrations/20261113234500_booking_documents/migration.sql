CREATE TYPE "BookingDocumentKind" AS ENUM ('invoice', 'receipt', 'settlement');
CREATE TYPE "BookingDocumentStatus" AS ENUM ('pending', 'ready', 'failed');

CREATE TABLE booking_documents (
  id uuid PRIMARY KEY,
  booking_id uuid NOT NULL REFERENCES bookings(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  kind "BookingDocumentKind" NOT NULL,
  source_id uuid NOT NULL,
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  status "BookingDocumentStatus" NOT NULL DEFAULT 'pending',
  render_id uuid,
  lease_id uuid,
  lease_until timestamptz(3),
  CHECK ((lease_id IS NULL) = (lease_until IS NULL)),
  CHECK (status = 'pending' OR lease_id IS NULL),
  CHECK ((status = 'ready') = (render_id IS NOT NULL)),
  UNIQUE (booking_id, kind, source_id)
);

CREATE INDEX booking_documents_status_created_at_idx ON booking_documents(status, created_at);

INSERT INTO booking_documents (id, booking_id, kind, source_id, snapshot)
SELECT gen_random_uuid(), a.booking_id, 'invoice', a.id, jsonb_build_object(
  'version', 1, 'kind', 'invoice', 'issuedAt', to_char(a.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'totalMinor', a.artifact::jsonb->'totalMinor', 'advanceMinor', a.artifact::jsonb->'serviceAdvanceMinor',
  'depositMinor', a.artifact::jsonb->'depositMinor', 'agreementDigest', a.digest,
  'startsAt', to_char(b.starts_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'endsAt', to_char(b.ends_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
)
FROM booking_agreements a JOIN bookings b ON b.id = a.booking_id;

WITH captures AS (
  SELECT a.order_id, e.journal_id, 'PayHere' AS gateway
  FROM payhere_attempts a JOIN payhere_events e ON a.id = e.attempt_id
  WHERE e.status_code = '2' AND e.journal_id IS NOT NULL
  UNION ALL
  SELECT order_id, journal_id, 'Stripe' FROM stripe_attempts WHERE journal_id IS NOT NULL
)
INSERT INTO booking_documents (id, booking_id, kind, source_id, snapshot)
SELECT gen_random_uuid(), o.booking_id, 'receipt', c.journal_id, jsonb_build_object(
  'version', 1, 'kind', 'receipt', 'issuedAt', to_char(j.posted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'purpose', o.purpose, 'amountMinor', o.amount_minor, 'gateway', c.gateway, 'orderId', o.id,
  'disposition', CASE WHEN a.scope = 'sandbox:booking:' || o.booking_id THEN 'captured' ELSE 'review' END
)
FROM captures c
JOIN payment_orders o ON o.id = c.order_id
JOIN journal_transactions j ON j.id = c.journal_id
JOIN journal_entries e ON e.transaction_id = j.id AND e.amount_minor > 0
JOIN financial_accounts a ON a.id = e.account_id;

INSERT INTO booking_documents (id, booking_id, kind, source_id, snapshot)
SELECT gen_random_uuid(), booking_id, 'settlement', id, jsonb_build_object(
  'version', 1, 'kind', 'settlement', 'issuedAt', to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'grossMinor', gross_minor, 'platformFeeMinor', platform_fee_minor, 'netMinor', net_minor,
  'destinationRevision', destination_revision
)
FROM payout_orders;
