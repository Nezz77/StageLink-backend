CREATE TABLE event_briefs (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE ON UPDATE CASCADE,
  title varchar(120) NOT NULL,
  description varchar(2000) NOT NULL,
  event_date date NOT NULL,
  city varchar(100) NOT NULL,
  budget_minor integer NOT NULL CHECK (budget_minor > 0),
  requirements jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(requirements) = 'array'),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now()
);
CREATE INDEX event_briefs_owner_id_id_idx ON event_briefs(owner_id, id);
