CREATE TABLE booking_check_ins (
  booking_id uuid PRIMARY KEY REFERENCES bookings(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  recorded_by uuid NOT NULL REFERENCES auth_users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  recorded_at timestamptz(3) NOT NULL
);

CREATE TABLE overtime_proposals (
  id uuid PRIMARY KEY,
  booking_id uuid NOT NULL REFERENCES bookings(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  request_key uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  proposed_by uuid NOT NULL REFERENCES auth_users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  minutes integer NOT NULL CHECK (minutes BETWEEN 1 AND 1440),
  amount_minor integer NOT NULL CHECK (amount_minor BETWEEN 100 AND 100000000),
  created_at timestamptz(3) NOT NULL,
  decision varchar(8),
  decided_by uuid REFERENCES auth_users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  decided_at timestamptz(3),
  UNIQUE (booking_id, request_key),
  UNIQUE (booking_id, version),
  CHECK (
    (decision IS NULL AND decided_by IS NULL AND decided_at IS NULL)
    OR (decision IS NOT NULL AND decision IN ('accepted', 'declined') AND decided_by IS NOT NULL
        AND decided_by <> proposed_by AND decided_at IS NOT NULL AND decided_at >= created_at)
  )
);
CREATE UNIQUE INDEX overtime_one_pending_per_booking ON overtime_proposals(booking_id) WHERE decision IS NULL;

CREATE TABLE booking_completions (
  booking_id uuid PRIMARY KEY REFERENCES bookings(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  reported_by uuid NOT NULL REFERENCES auth_users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  reported_at timestamptz(3) NOT NULL,
  original_minor integer NOT NULL CHECK (original_minor > 0),
  advance_minor integer NOT NULL CHECK (advance_minor > 0 AND advance_minor <= original_minor),
  overtime_minor integer NOT NULL CHECK (overtime_minor >= 0),
  overtime_minutes integer NOT NULL CHECK (overtime_minutes BETWEEN 0 AND 1440),
  balance_minor integer NOT NULL CHECK (balance_minor >= 0),
  platform_fee_minor integer NOT NULL CHECK (platform_fee_minor >= 0),
  verified_by uuid REFERENCES auth_users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  verified_at timestamptz(3),
  verification_reason varchar(500),
  CHECK (balance_minor::bigint = original_minor::bigint - advance_minor + overtime_minor),
  CHECK (platform_fee_minor = (original_minor::bigint * 5 + 50) / 100),
  CHECK (
    (verified_by IS NULL AND verified_at IS NULL AND verification_reason IS NULL)
    OR (verified_by IS NOT NULL AND verified_by <> reported_by AND verified_at IS NOT NULL
        AND verified_at >= reported_at AND verification_reason IS NOT NULL AND length(trim(verification_reason)) > 0)
  )
);
