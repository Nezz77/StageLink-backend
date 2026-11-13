CREATE TABLE recommendation_runs (
  id uuid PRIMARY KEY,
  brief_id uuid NOT NULL REFERENCES event_briefs(id) ON DELETE CASCADE ON UPDATE CASCADE,
  request_key uuid NOT NULL,
  brief_revision integer NOT NULL CHECK (brief_revision > 0),
  weights_revision integer NOT NULL REFERENCES matching_versions(revision) ON DELETE RESTRICT ON UPDATE CASCADE,
  genres jsonb NOT NULL CHECK (jsonb_typeof(genres) = 'array' AND jsonb_array_length(genres) <= 10),
  method varchar(24) NOT NULL CHECK (method = 'weighted_catalog_v1'),
  results jsonb NOT NULL CHECK (jsonb_typeof(results) = 'array' AND jsonb_array_length(results) <= 3),
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  UNIQUE (brief_id, request_key)
);
