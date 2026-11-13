CREATE TYPE "InventoryStatus" AS ENUM ('available', 'out', 'inspection', 'maintenance', 'quarantined', 'retired');

ALTER TABLE rental_listings ADD CONSTRAINT rental_listings_id_owner_id_key UNIQUE (id, owner_id);

CREATE TABLE inventory_units (
  id uuid PRIMARY KEY,
  listing_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  serial varchar(100) NOT NULL CHECK (serial ~ '^[A-Z0-9][A-Z0-9 ._/-]{0,99}$'),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  status "InventoryStatus" NOT NULL DEFAULT 'available',
  custody_reference varchar(120),
  due_at timestamptz(3),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT inventory_units_listing_id_owner_id_fkey FOREIGN KEY (listing_id, owner_id)
    REFERENCES rental_listings(id, owner_id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT inventory_units_owner_id_serial_key UNIQUE (owner_id, serial),
  CHECK ((status = 'out' AND custody_reference IS NOT NULL AND due_at IS NOT NULL)
    OR (status <> 'out' AND custody_reference IS NULL AND due_at IS NULL))
);

CREATE INDEX inventory_units_owner_id_id_idx ON inventory_units(owner_id, id);
CREATE INDEX inventory_units_listing_id_status_idx ON inventory_units(listing_id, status);

CREATE TABLE inventory_movements (
  id bigserial PRIMARY KEY,
  unit_id uuid NOT NULL REFERENCES inventory_units(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  revision integer NOT NULL CHECK (revision > 0),
  from_status "InventoryStatus",
  to_status "InventoryStatus" NOT NULL,
  reason varchar(500) NOT NULL,
  custody_reference varchar(120),
  due_at timestamptz(3),
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT inventory_movements_unit_id_revision_key UNIQUE (unit_id, revision)
);
