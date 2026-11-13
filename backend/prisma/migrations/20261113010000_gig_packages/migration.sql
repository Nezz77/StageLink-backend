ALTER TABLE artist_gig_versions
  ADD COLUMN packages jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD CONSTRAINT artist_gig_versions_packages_array CHECK (jsonb_typeof(packages) = 'array');
