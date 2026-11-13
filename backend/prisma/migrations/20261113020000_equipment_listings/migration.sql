CREATE TYPE "RentalStatus" AS ENUM ('draft', 'published', 'paused', 'archived');

CREATE TABLE rental_listings (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES auth_users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  published_version integer,
  status "RentalStatus" NOT NULL DEFAULT 'draft',
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  CHECK (status <> 'published' OR published_version IS NOT NULL)
);

CREATE INDEX rental_listings_owner_id_status_idx ON rental_listings(owner_id, status);

CREATE TABLE rental_listing_versions (
  listing_id uuid NOT NULL REFERENCES rental_listings(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  version integer NOT NULL CHECK (version > 0),
  title varchar(120) NOT NULL,
  description varchar(2000) NOT NULL,
  category varchar(40) NOT NULL CHECK (category IN ('Sound', 'Lighting', 'Instruments', 'Power', 'Stage', 'Other')),
  daily_rate_minor integer NOT NULL CHECK (daily_rate_minor BETWEEN 1 AND 100000000),
  stock_quantity integer NOT NULL CHECK (stock_quantity BETWEEN 0 AND 100000),
  specs jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(specs) = 'object'),
  PRIMARY KEY (listing_id, version)
);

ALTER TABLE rental_listings ADD CONSTRAINT rental_listings_id_published_version_fkey
  FOREIGN KEY (id, published_version) REFERENCES rental_listing_versions(listing_id, version)
  ON DELETE RESTRICT ON UPDATE CASCADE;
