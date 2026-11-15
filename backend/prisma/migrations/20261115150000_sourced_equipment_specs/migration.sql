CREATE TABLE equipment_spec_sources (
  id uuid PRIMARY KEY,
  manufacturer varchar(120) NOT NULL,
  manufacturer_key text NOT NULL,
  model varchar(120) NOT NULL,
  model_key text NOT NULL,
  specs jsonb NOT NULL CHECK (jsonb_typeof(specs) = 'object' AND specs <> '{}'::jsonb),
  url varchar(2048) NOT NULL,
  title varchar(200) NOT NULL,
  locator varchar(160),
  approved_by uuid NOT NULL REFERENCES auth_users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  approved_at timestamptz(3) NOT NULL DEFAULT now(),
  retired_by uuid REFERENCES auth_users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  retired_at timestamptz(3),
  retirement_reason varchar(500),
  CHECK ((retired_at IS NULL) = (retired_by IS NULL)),
  CHECK ((retired_at IS NULL) = (retirement_reason IS NULL))
);

CREATE UNIQUE INDEX equipment_spec_sources_active_model_idx
  ON equipment_spec_sources(model_key, manufacturer_key) WHERE retired_at IS NULL;

ALTER TABLE ai_generation_jobs
  DROP CONSTRAINT ai_generation_jobs_kind_check,
  ALTER COLUMN prompt_version DROP NOT NULL,
  ALTER COLUMN template_revision DROP NOT NULL,
  ADD COLUMN equipment_source_id uuid REFERENCES equipment_spec_sources(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT ai_generation_jobs_trace_check CHECK (
    (kind IN ('bio', 'gig') AND prompt_version IS NOT NULL AND template_revision IS NOT NULL AND equipment_source_id IS NULL)
    OR (kind = 'equipment-specs' AND prompt_version IS NULL AND template_revision IS NULL AND status = 'succeeded')
  );

CREATE INDEX ai_generation_jobs_equipment_source_id_idx ON ai_generation_jobs(equipment_source_id);
