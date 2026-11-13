CREATE TYPE "ProviderDecision" AS ENUM ('accepted', 'rejected');
ALTER TABLE bookings
  ADD COLUMN provider_decision "ProviderDecision",
  ADD COLUMN decided_at timestamptz(3),
  ADD COLUMN decision_reason varchar(500),
  ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  ADD CHECK ((provider_decision IS NULL) = (decided_at IS NULL)),
  ADD CHECK ((provider_decision IS NULL) = (decision_reason IS NULL));
