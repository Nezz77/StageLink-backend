CREATE TABLE booking_messages (
  id bigserial PRIMARY KEY,
  booking_id uuid NOT NULL REFERENCES bookings(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  author_id uuid NOT NULL REFERENCES auth_users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  request_key uuid NOT NULL,
  body varchar(4000) NOT NULL CHECK (length(body) > 0),
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT booking_messages_booking_id_author_id_request_key_key UNIQUE (booking_id, author_id, request_key)
);
CREATE INDEX booking_messages_booking_id_id_idx ON booking_messages(booking_id, id);

CREATE TABLE booking_message_reads (
  booking_id uuid NOT NULL REFERENCES bookings(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  reader_id uuid NOT NULL REFERENCES auth_users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  through_id bigint NOT NULL CHECK (through_id > 0),
  PRIMARY KEY (booking_id, reader_id)
);
