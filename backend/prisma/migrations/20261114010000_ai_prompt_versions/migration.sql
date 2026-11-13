CREATE TABLE ai_prompt_templates (
  key varchar(20) PRIMARY KEY CHECK (key IN ('bio', 'equipment')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  draft varchar(3000),
  updated_at timestamptz(3) NOT NULL DEFAULT now()
);

CREATE TABLE ai_prompt_versions (
  key varchar(20) NOT NULL REFERENCES ai_prompt_templates(key) ON DELETE RESTRICT ON UPDATE CASCADE,
  version integer NOT NULL CHECK (version > 0),
  body varchar(3000) NOT NULL CHECK (length(trim(body)) >= 20),
  reason varchar(500) NOT NULL CHECK (length(trim(reason)) > 0),
  actor_id uuid REFERENCES auth_users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  rolled_back_from integer,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  PRIMARY KEY (key, version),
  FOREIGN KEY (key, rolled_back_from) REFERENCES ai_prompt_versions(key, version) ON DELETE RESTRICT ON UPDATE CASCADE,
  CHECK (rolled_back_from IS NULL OR rolled_back_from < version)
);

INSERT INTO ai_prompt_templates (key) VALUES ('bio'), ('equipment');
INSERT INTO ai_prompt_versions (key, version, body, reason) VALUES
  ('bio', 1, 'Write a concise artist biography for {{artist_name}}. Use supplied genres {{genres}} and event type {{event_type}}. Include only supplied facts.', 'Initial template'),
  ('equipment', 1, 'Summarize {{equipment_title}} by {{manufacturer}} from supplied facts. Report unverified specifications as unknown.', 'Initial template');
