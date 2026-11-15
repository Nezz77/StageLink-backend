ALTER TABLE ai_prompt_templates
  DROP CONSTRAINT ai_prompt_templates_key_check,
  ADD CONSTRAINT ai_prompt_templates_key_check CHECK (key IN ('bio', 'equipment', 'gig'));

INSERT INTO ai_prompt_templates (key) VALUES ('gig');
INSERT INTO ai_prompt_versions (key, version, body, reason) VALUES
  ('gig', 1, 'Draft a gig title and description for {{artist_name}}. Use the supplied performance {{performance}} and event type {{event_type}}. Include only supplied facts.', 'Initial template');

CREATE TYPE "AiGenerationStatus" AS ENUM ('processing', 'succeeded', 'failed', 'refused', 'unavailable');

CREATE TABLE ai_generation_jobs (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE ON UPDATE CASCADE,
  request_key uuid NOT NULL,
  request_hash char(64) NOT NULL,
  kind varchar(20) NOT NULL CHECK (kind IN ('bio', 'gig')),
  prompt_version integer NOT NULL,
  template_revision integer NOT NULL CHECK (template_revision > 0),
  status "AiGenerationStatus" NOT NULL DEFAULT 'processing',
  suggestion jsonb,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  expires_at timestamptz(3) NOT NULL,
  completed_at timestamptz(3),
  UNIQUE (owner_id, request_key),
  FOREIGN KEY (kind, prompt_version) REFERENCES ai_prompt_versions(key, version) ON DELETE RESTRICT ON UPDATE CASCADE,
  CHECK (expires_at > created_at),
  CHECK ((status = 'processing') = (completed_at IS NULL)),
  CHECK ((status = 'succeeded') = (suggestion IS NOT NULL) AND
    (suggestion IS NULL OR jsonb_typeof(suggestion) = 'object'))
);
CREATE INDEX ai_generation_jobs_created_at_idx ON ai_generation_jobs(created_at);
CREATE INDEX ai_generation_jobs_owner_id_created_at_idx ON ai_generation_jobs(owner_id, created_at);

ALTER TABLE ai_model_calls
  ADD COLUMN generation_id uuid REFERENCES ai_generation_jobs(id) ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX ai_model_calls_generation_id_idx ON ai_model_calls(generation_id);
