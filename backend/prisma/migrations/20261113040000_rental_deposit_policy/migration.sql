ALTER TABLE rental_listing_versions
  ADD COLUMN deposit_policy jsonb NOT NULL DEFAULT '{"mode":"none","currency":"LKR"}'::jsonb
    CHECK (jsonb_typeof(deposit_policy) = 'object');
