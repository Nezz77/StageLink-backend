ALTER TABLE assets DROP CONSTRAINT assets_purpose_check;
ALTER TABLE assets ADD CONSTRAINT assets_purpose_check
  CHECK (purpose IN ('avatar', 'portfolio', 'equipment', 'evidence', 'chat'));

-- An empty body is allowed for a message containing only attachments.
ALTER TABLE booking_messages DROP CONSTRAINT booking_messages_body_check;

CREATE TABLE booking_message_attachments (
  message_id bigint NOT NULL REFERENCES booking_messages(id) ON DELETE CASCADE ON UPDATE CASCADE,
  asset_id uuid NOT NULL REFERENCES assets(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  position integer NOT NULL CHECK (position BETWEEN 0 AND 3),
  PRIMARY KEY (message_id, asset_id),
  CONSTRAINT booking_message_attachments_message_id_position_key UNIQUE (message_id, position)
);
CREATE INDEX booking_message_attachments_asset_id_idx ON booking_message_attachments(asset_id);
