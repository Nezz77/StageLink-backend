ALTER TABLE recommendation_runs
  DROP CONSTRAINT recommendation_runs_method_check,
  ADD COLUMN semantic_requested boolean NOT NULL DEFAULT false,
  ADD COLUMN semantic_pending_until timestamptz(3),
  ADD COLUMN semantic_provenance jsonb;

ALTER TABLE recommendation_runs
  ADD CONSTRAINT recommendation_runs_semantic_state_check CHECK (
    (semantic_pending_until IS NULL OR (semantic_requested AND method = 'weighted_catalog_v1'))
    AND (
      (method = 'semantic_hybrid_v1' AND semantic_requested AND semantic_provenance IS NOT NULL)
      OR (method = 'weighted_catalog_v1' AND semantic_provenance IS NULL)
    )
  );
