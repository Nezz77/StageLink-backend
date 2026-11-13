CREATE TABLE inquiries (
  id uuid PRIMARY KEY,
  customer_id uuid NOT NULL REFERENCES auth_users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  provider_id uuid NOT NULL REFERENCES auth_users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  target_kind "SavedItemKind" NOT NULL CHECK (target_kind IN ('gig', 'rental')),
  target_id uuid NOT NULL,
  target_version integer NOT NULL CHECK (target_version > 0),
  title varchar(120) NOT NULL,
  request_key uuid NOT NULL,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT inquiries_customer_id_request_key_key UNIQUE (customer_id, request_key),
  CHECK (customer_id <> provider_id)
);
CREATE INDEX inquiries_customer_id_id_idx ON inquiries(customer_id, id);
CREATE INDEX inquiries_provider_id_id_idx ON inquiries(provider_id, id);

CREATE TABLE inquiry_messages (
  id bigserial PRIMARY KEY,
  inquiry_id uuid NOT NULL REFERENCES inquiries(id) ON DELETE CASCADE ON UPDATE CASCADE,
  author_id uuid NOT NULL REFERENCES auth_users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  request_key uuid NOT NULL,
  body varchar(4000) NOT NULL,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT inquiry_messages_inquiry_id_author_id_request_key_key UNIQUE (inquiry_id, author_id, request_key)
);
CREATE INDEX inquiry_messages_inquiry_id_id_idx ON inquiry_messages(inquiry_id, id);
