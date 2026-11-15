ALTER TABLE ai_model_calls
  DROP CONSTRAINT ai_model_calls_check,
  ADD CONSTRAINT ai_model_calls_cached_input_tokens_check CHECK (
    cached_input_tokens IS NULL OR
    (input_tokens IS NOT NULL AND cached_input_tokens >= 0 AND cached_input_tokens <= input_tokens)
  );
