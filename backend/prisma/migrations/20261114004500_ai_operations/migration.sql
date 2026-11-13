CREATE TABLE matching_versions (
  revision integer PRIMARY KEY CHECK (revision > 0),
  genre integer NOT NULL CHECK (genre BETWEEN 0 AND 100),
  budget integer NOT NULL CHECK (budget BETWEEN 0 AND 100),
  location integer NOT NULL CHECK (location BETWEEN 0 AND 100),
  rating integer NOT NULL CHECK (rating BETWEEN 0 AND 100),
  actor_id uuid REFERENCES auth_users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  CHECK (genre + budget + location + rating = 100)
);
INSERT INTO matching_versions (revision, genre, budget, location, rating) VALUES (1, 40, 30, 20, 10);

CREATE TABLE ai_model_calls (
  id uuid PRIMARY KEY,
  capability varchar(32) NOT NULL CHECK (length(capability) > 0),
  provider varchar(32) NOT NULL CHECK (length(provider) > 0),
  model varchar(100) NOT NULL CHECK (length(model) > 0),
  outcome varchar(12) NOT NULL CHECK (outcome IN ('succeeded', 'failed', 'refused')),
  latency_ms integer NOT NULL CHECK (latency_ms >= 0),
  input_tokens integer CHECK (input_tokens >= 0),
  output_tokens integer CHECK (output_tokens >= 0),
  cached_input_tokens integer CHECK (input_tokens IS NOT NULL AND cached_input_tokens >= 0 AND cached_input_tokens <= input_tokens),
  created_at timestamptz(3) NOT NULL DEFAULT now()
);
CREATE INDEX ai_model_calls_created_at_idx ON ai_model_calls(created_at);
