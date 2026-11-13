CREATE TABLE private_drafts (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE ON UPDATE CASCADE,
  key varchar(80) NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT private_drafts_owner_id_key_key UNIQUE (owner_id, key)
);
