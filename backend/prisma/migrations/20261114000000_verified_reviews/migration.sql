ALTER TABLE assets DROP CONSTRAINT assets_purpose_check;
ALTER TABLE assets ADD CONSTRAINT assets_purpose_check
  CHECK (purpose IN ('avatar', 'portfolio', 'equipment', 'evidence', 'chat', 'review'));

CREATE TYPE "BookingReviewStatus" AS ENUM ('pending', 'published', 'hidden');
CREATE TABLE booking_reviews (
  id uuid PRIMARY KEY,
  booking_id uuid NOT NULL UNIQUE REFERENCES bookings(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  target_kind "SavedItemKind" NOT NULL CHECK (target_kind IN ('gig', 'rental')),
  target_id uuid NOT NULL,
  rating integer NOT NULL CHECK (rating BETWEEN 1 AND 5),
  body varchar(2000) NOT NULL CHECK (length(trim(body)) >= 10),
  status "BookingReviewStatus" NOT NULL DEFAULT 'pending',
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz(3) NOT NULL DEFAULT now()
);
CREATE INDEX booking_reviews_target_kind_target_id_status_id_idx ON booking_reviews(target_kind, target_id, status, id);
CREATE INDEX booking_reviews_status_id_idx ON booking_reviews(status, id);

CREATE TABLE booking_review_photos (
  review_id uuid NOT NULL REFERENCES booking_reviews(id) ON DELETE CASCADE ON UPDATE CASCADE,
  asset_id uuid NOT NULL REFERENCES assets(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  position integer NOT NULL CHECK (position BETWEEN 0 AND 3),
  PRIMARY KEY (review_id, asset_id),
  UNIQUE (review_id, position)
);
CREATE INDEX booking_review_photos_asset_id_idx ON booking_review_photos(asset_id);

CREATE TABLE booking_review_moderations (
  review_id uuid NOT NULL REFERENCES booking_reviews(id) ON DELETE CASCADE ON UPDATE CASCADE,
  revision integer NOT NULL CHECK (revision > 1),
  status "BookingReviewStatus" NOT NULL CHECK (status <> 'pending'),
  reason varchar(500) NOT NULL CHECK (length(trim(reason)) > 0),
  actor_id uuid NOT NULL REFERENCES auth_users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  PRIMARY KEY (review_id, revision)
);
