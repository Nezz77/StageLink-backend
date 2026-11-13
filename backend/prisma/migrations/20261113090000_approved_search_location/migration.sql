ALTER TABLE provider_profiles
  ADD COLUMN approved_latitude decimal(5,2),
  ADD COLUMN approved_longitude decimal(5,2),
  CHECK ((approved_latitude IS NULL) = (approved_longitude IS NULL)),
  CHECK (approved_latitude BETWEEN -90 AND 90),
  CHECK (approved_longitude BETWEEN -180 AND 180);

-- Only an unchanged approved revision can establish the location being published.
UPDATE provider_profiles
SET approved_latitude = round(latitude, 2), approved_longitude = round(longitude, 2)
WHERE approved_revision = revision AND approved_snapshot IS NOT NULL;
