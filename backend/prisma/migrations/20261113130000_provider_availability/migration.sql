CREATE TABLE availability_calendars (
  owner_id uuid PRIMARY KEY REFERENCES auth_users(id) ON DELETE CASCADE ON UPDATE CASCADE,
  timezone varchar(100) NOT NULL,
  hours jsonb NOT NULL CHECK (jsonb_typeof(hours) = 'array'),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0)
);

CREATE TABLE availability_blocks (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES availability_calendars(owner_id) ON DELETE CASCADE ON UPDATE CASCADE,
  starts_at timestamptz(3) NOT NULL,
  ends_at timestamptz(3) NOT NULL,
  reason varchar(500) NOT NULL,
  CHECK (starts_at < ends_at)
);
CREATE INDEX availability_blocks_owner_id_starts_at_idx ON availability_blocks(owner_id, starts_at);
