CREATE TYPE "RentalKind" AS ENUM ('equipment', 'venue', 'bundle');

ALTER TABLE rental_listings ADD COLUMN kind "RentalKind" NOT NULL DEFAULT 'equipment';

ALTER TABLE rental_listing_versions
  ADD COLUMN hourly_rate_minor integer CHECK (hourly_rate_minor BETWEEN 1 AND 100000000),
  ADD COLUMN weekly_rate_minor integer CHECK (weekly_rate_minor BETWEEN 1 AND 100000000),
  ADD COLUMN venue_capacity integer CHECK (venue_capacity BETWEEN 1 AND 100000),
  ADD COLUMN bundle_items jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(bundle_items) = 'array');
