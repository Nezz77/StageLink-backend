CREATE TABLE public_announcements (
  id uuid PRIMARY KEY,
  title varchar(120) NOT NULL,
  body varchar(1000) NOT NULL,
  published_at timestamptz(3),
  starts_at timestamptz(3) NOT NULL,
  ends_at timestamptz(3),
  CHECK (ends_at IS NULL OR ends_at > starts_at)
);
CREATE INDEX public_announcements_starts_at_id_idx ON public_announcements(starts_at, id);
