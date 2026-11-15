ALTER TABLE ai_model_calls
  ADD COLUMN prompt_key varchar(20),
  ADD COLUMN prompt_version integer,
  ADD COLUMN template_revision integer,
  ADD COLUMN prompt_source varchar(12),
  ADD CONSTRAINT ai_model_call_prompt_version_fkey FOREIGN KEY (prompt_key, prompt_version)
    REFERENCES ai_prompt_versions(key, version) ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT ai_model_call_prompt_trace_check CHECK (
    (prompt_key IS NULL AND prompt_version IS NULL AND template_revision IS NULL AND prompt_source IS NULL)
    OR (prompt_key IS NOT NULL AND template_revision IS NOT NULL AND template_revision > 0
      AND prompt_source IS NOT NULL AND prompt_source IN ('published', 'draft', 'inline')
      AND ((prompt_source = 'published') = (prompt_version IS NOT NULL)))
  );
