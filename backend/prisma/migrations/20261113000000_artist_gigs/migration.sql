CREATE TYPE "GigStatus" AS ENUM ('draft', 'published', 'paused', 'archived');

CREATE TABLE artist_gigs (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES auth_users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  published_version integer,
  status "GigStatus" NOT NULL DEFAULT 'draft',
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  CHECK (status <> 'published' OR published_version IS NOT NULL)
);

CREATE INDEX artist_gigs_owner_id_status_idx ON artist_gigs(owner_id, status);

CREATE TABLE artist_gig_versions (
  gig_id uuid NOT NULL REFERENCES artist_gigs(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  version integer NOT NULL CHECK (version > 0),
  title varchar(120) NOT NULL,
  description varchar(2000) NOT NULL,
  price_minor integer NOT NULL CHECK (price_minor BETWEEN 1 AND 100000000),
  PRIMARY KEY (gig_id, version)
);

ALTER TABLE artist_gigs ADD CONSTRAINT artist_gigs_id_published_version_fkey
  FOREIGN KEY (id, published_version) REFERENCES artist_gig_versions(gig_id, version)
  ON DELETE RESTRICT ON UPDATE CASCADE;
