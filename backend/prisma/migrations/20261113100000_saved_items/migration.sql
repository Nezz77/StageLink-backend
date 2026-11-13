CREATE TYPE "SavedItemKind" AS ENUM ('artist', 'gig', 'rental');

CREATE TABLE saved_items (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE ON UPDATE CASCADE,
  kind "SavedItemKind" NOT NULL,
  target_id uuid NOT NULL,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT saved_items_owner_id_kind_target_id_key UNIQUE (owner_id, kind, target_id)
);
CREATE INDEX saved_items_owner_id_id_idx ON saved_items(owner_id, id);
