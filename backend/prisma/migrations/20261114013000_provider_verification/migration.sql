ALTER TABLE assets DROP CONSTRAINT assets_purpose_check;
ALTER TABLE assets ADD CONSTRAINT assets_purpose_check
  CHECK (purpose IN ('avatar', 'portfolio', 'equipment', 'evidence', 'chat', 'review', 'inspection', 'verification'));

CREATE TYPE "VerificationStatus" AS ENUM ('pending', 'approved', 'rejected');

CREATE TABLE verification_cases (
  id uuid PRIMARY KEY,
  provider_id uuid NOT NULL REFERENCES auth_users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  kind "AuthRole" NOT NULL CHECK (kind IN ('artist', 'renter')),
  request_key uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  subject varchar(140) NOT NULL CHECK (length(trim(subject)) >= 3),
  body varchar(2000) NOT NULL CHECK (length(trim(body)) >= 20),
  status "VerificationStatus" NOT NULL DEFAULT 'pending',
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  decided_by uuid REFERENCES auth_users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  decided_at timestamptz(3),
  reason varchar(2000),
  UNIQUE (provider_id, kind, version),
  UNIQUE (provider_id, request_key),
  CHECK (
    (status = 'pending' AND decided_by IS NULL AND decided_at IS NULL AND reason IS NULL)
    OR (status <> 'pending' AND decided_by IS NOT NULL AND decided_by <> provider_id
        AND decided_at IS NOT NULL AND decided_at >= created_at AND reason IS NOT NULL AND length(trim(reason)) >= 10)
  )
);
CREATE INDEX verification_cases_status_id_idx ON verification_cases(status, id);
CREATE UNIQUE INDEX verification_cases_one_pending_idx ON verification_cases(provider_id,kind) WHERE status = 'pending';

CREATE TABLE verification_documents (
  case_id uuid NOT NULL REFERENCES verification_cases(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  asset_id uuid NOT NULL REFERENCES assets(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  position integer NOT NULL CHECK (position BETWEEN 0 AND 4),
  PRIMARY KEY (case_id, asset_id),
  UNIQUE (case_id, position)
);
CREATE INDEX verification_documents_asset_id_idx ON verification_documents(asset_id);
