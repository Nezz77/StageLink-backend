CREATE TABLE bookings (
  id uuid PRIMARY KEY,
  customer_id uuid NOT NULL REFERENCES auth_users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  provider_id uuid NOT NULL REFERENCES auth_users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  inquiry_id uuid REFERENCES inquiries(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  request_key uuid NOT NULL,
  request_digest char(64) NOT NULL,
  target_kind "SavedItemKind" NOT NULL CHECK (target_kind IN ('gig', 'rental')),
  target_id uuid NOT NULL,
  target_version integer NOT NULL CHECK (target_version > 0),
  starts_at timestamptz(3) NOT NULL,
  ends_at timestamptz(3) NOT NULL,
  hold_expires_at timestamptz(3) NOT NULL,
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  CHECK (customer_id <> provider_id AND starts_at < ends_at AND hold_expires_at <= starts_at),
  CONSTRAINT bookings_customer_id_request_key_key UNIQUE (customer_id, request_key),
  CONSTRAINT bookings_inquiry_id_key UNIQUE (inquiry_id)
);
CREATE INDEX bookings_customer_id_id_idx ON bookings(customer_id, id);
CREATE INDEX bookings_provider_id_id_idx ON bookings(provider_id, id);

CREATE TYPE "ReservationResource" AS ENUM ('artist', 'equipment', 'venue');
CREATE TABLE booking_reservation_lines (
  booking_id uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE ON UPDATE CASCADE,
  resource "ReservationResource" NOT NULL,
  resource_id uuid NOT NULL,
  quantity integer NOT NULL CHECK (quantity > 0),
  PRIMARY KEY (booking_id, resource, resource_id)
);
CREATE INDEX booking_reservation_lines_resource_resource_id_idx ON booking_reservation_lines(resource, resource_id);
