CREATE TABLE assets (
 id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES auth_users(id) ON DELETE RESTRICT,
 purpose varchar(20) NOT NULL CHECK(purpose IN ('avatar','portfolio','equipment','evidence')),
 filename varchar(120) NOT NULL, mime varchar(80) NOT NULL, bytes integer NOT NULL CHECK(bytes>0 AND bytes<=41943040), sha256 char(64) NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','uploading','staged','uploaded','processing','ready','rejected','deleted','purged')),
 variants jsonb NOT NULL DEFAULT '{}', metadata jsonb NOT NULL DEFAULT '{}', reason varchar(240),
 created_at timestamptz(3) NOT NULL DEFAULT now(), expires_at timestamptz(3) NOT NULL, available_at timestamptz(3) NOT NULL DEFAULT now(),
 lease_owner uuid, lease_until timestamptz(3), attempts integer NOT NULL DEFAULT 0,
 delete_after timestamptz(3)
);
CREATE INDEX assets_status_available_at_idx ON assets(status,available_at);
CREATE INDEX assets_owner_id_created_at_idx ON assets(owner_id,created_at);
CREATE TABLE portfolio_items (
 id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
 kind "AuthRole" NOT NULL CHECK(kind IN ('artist','renter')), asset_id uuid REFERENCES assets(id) ON DELETE RESTRICT,
 embed_url varchar(200), caption varchar(240) NOT NULL, transcript varchar(4000) NOT NULL,
 featured boolean NOT NULL DEFAULT false, revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','pending','approved','rejected')),
 reason varchar(2000), updated_at timestamptz(3) NOT NULL DEFAULT now(),
 CHECK((asset_id IS NULL) <> (embed_url IS NULL))
);
CREATE INDEX portfolio_items_owner_id_kind_idx ON portfolio_items(owner_id,kind);
CREATE INDEX portfolio_items_status_updated_at_idx ON portfolio_items(status,updated_at);
CREATE TABLE avatar_bindings (
 owner_id uuid PRIMARY KEY REFERENCES auth_users(id) ON DELETE CASCADE,
 asset_id uuid NOT NULL REFERENCES assets(id) ON DELETE RESTRICT
);
CREATE TABLE asset_holds (
 id uuid PRIMARY KEY, asset_id uuid NOT NULL REFERENCES assets(id) ON DELETE RESTRICT,
 reference varchar(120) NOT NULL UNIQUE, until timestamptz(3) NOT NULL
);
