ALTER TABLE bookings ADD COLUMN agreed_at timestamptz(3);
CREATE TABLE booking_quotations (
  id uuid PRIMARY KEY,
  booking_id uuid NOT NULL REFERENCES bookings(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  version integer NOT NULL CHECK (version > 0),
  author_id uuid NOT NULL REFERENCES auth_users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  lines jsonb NOT NULL CHECK (jsonb_typeof(lines) = 'array'),
  terms varchar(4000) NOT NULL,
  total_minor integer NOT NULL CHECK (total_minor > 0),
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  decided_at timestamptz(3),
  decision varchar(8) CHECK (decision IN ('accepted', 'declined')),
  decided_by uuid REFERENCES auth_users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CHECK ((decision IS NULL) = (decided_at IS NULL) AND (decision IS NULL) = (decided_by IS NULL)),
  CONSTRAINT booking_quotations_booking_id_version_key UNIQUE (booking_id, version)
);
CREATE UNIQUE INDEX booking_quotations_accepted_idx ON booking_quotations(booking_id) WHERE decision = 'accepted';

CREATE TABLE booking_agreements (
  id uuid PRIMARY KEY,
  booking_id uuid NOT NULL UNIQUE REFERENCES bookings(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  quotation_id uuid NOT NULL UNIQUE REFERENCES booking_quotations(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  artifact text NOT NULL,
  digest char(64) NOT NULL,
  created_at timestamptz(3) NOT NULL DEFAULT now()
);
