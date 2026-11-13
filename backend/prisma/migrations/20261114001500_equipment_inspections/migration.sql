CREATE TYPE "InspectionPhase" AS ENUM ('dispatch', 'return', 'clearance');
CREATE TYPE "InspectionStage" AS ENUM ('dispatch_draft', 'dispatch_ack', 'out', 'return_draft', 'return_ack', 'quarantined', 'clearance_draft', 'cleared', 'abandoned');

CREATE TABLE equipment_inspections (
  id uuid PRIMARY KEY,
  booking_id uuid NOT NULL UNIQUE REFERENCES bookings(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  stage "InspectionStage" NOT NULL DEFAULT 'dispatch_draft',
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  accessories jsonb NOT NULL CHECK (jsonb_typeof(accessories) = 'array'),
  draft jsonb CHECK (draft IS NULL OR jsonb_typeof(draft) = 'object'),
  created_at timestamptz(3) NOT NULL DEFAULT now()
);

CREATE TABLE equipment_inspection_units (
  inspection_id uuid NOT NULL REFERENCES equipment_inspections(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  unit_id uuid NOT NULL REFERENCES inventory_units(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  released_at timestamptz(3),
  PRIMARY KEY (inspection_id, unit_id)
);
CREATE UNIQUE INDEX equipment_inspection_active_unit_idx ON equipment_inspection_units(unit_id) WHERE released_at IS NULL;

CREATE TABLE equipment_inspection_reports (
  inspection_id uuid NOT NULL REFERENCES equipment_inspections(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  revision integer NOT NULL CHECK (revision > 1),
  phase "InspectionPhase" NOT NULL,
  evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence) = 'object'),
  submitted_by uuid NOT NULL REFERENCES auth_users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  submitted_at timestamptz(3) NOT NULL DEFAULT now(),
  decided_by uuid REFERENCES auth_users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  decided_at timestamptz(3),
  decision varchar(12) CHECK (decision IN ('acknowledged', 'correction')),
  correction_reason varchar(500),
  PRIMARY KEY (inspection_id, revision),
  CHECK ((decided_by IS NULL) = (decided_at IS NULL) AND (decided_by IS NULL) = (decision IS NULL)),
  CHECK ((decision = 'correction' AND correction_reason IS NOT NULL)
      OR (decision IS DISTINCT FROM 'correction' AND correction_reason IS NULL))
);

CREATE TABLE equipment_inspection_photos (
  inspection_id uuid NOT NULL,
  report_revision integer NOT NULL,
  asset_id uuid NOT NULL REFERENCES assets(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  PRIMARY KEY (inspection_id, report_revision, asset_id),
  FOREIGN KEY (inspection_id, report_revision) REFERENCES equipment_inspection_reports(inspection_id, revision)
    ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX equipment_inspection_photos_asset_id_idx ON equipment_inspection_photos(asset_id);

ALTER TABLE assets DROP CONSTRAINT assets_purpose_check;
ALTER TABLE assets ADD CONSTRAINT assets_purpose_check
  CHECK (purpose IN ('avatar', 'portfolio', 'equipment', 'evidence', 'chat', 'review', 'inspection'));
