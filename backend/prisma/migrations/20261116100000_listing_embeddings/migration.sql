CREATE TYPE "ListingEmbeddingState" AS ENUM ('processing', 'ready', 'failed');

CREATE TABLE listing_embeddings (
  gig_id uuid NOT NULL,
  gig_version integer NOT NULL,
  model varchar(100) NOT NULL,
  input_version varchar(32) NOT NULL,
  state "ListingEmbeddingState" NOT NULL DEFAULT 'processing',
  vector double precision[] NOT NULL DEFAULT '{}',
  attempt_id uuid NOT NULL,
  started_at timestamptz(3) NOT NULL,
  indexed_at timestamptz(3),
  PRIMARY KEY (gig_id, gig_version, model, input_version),
  FOREIGN KEY (gig_id, gig_version) REFERENCES artist_gig_versions(gig_id, version) ON DELETE CASCADE ON UPDATE CASCADE,
  CHECK (
    (state = 'ready' AND cardinality(vector) = 256 AND indexed_at IS NOT NULL)
    OR (state <> 'ready' AND cardinality(vector) = 0 AND indexed_at IS NULL)
  )
);
