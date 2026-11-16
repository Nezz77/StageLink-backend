CREATE TABLE stripe_payout_destination_links (
  id uuid PRIMARY KEY,
  provider_id uuid NOT NULL,
  destination_revision integer NOT NULL,
  platform_account_id varchar(150) NOT NULL CHECK (platform_account_id ~ '^acct_[A-Za-z0-9]+$'),
  stripe_account_id varchar(150) NOT NULL CHECK (stripe_account_id ~ '^acct_[A-Za-z0-9]+$'),
  account_country char(2) NOT NULL CHECK (account_country ~ '^[A-Z]{2}$'),
  linked_by uuid NOT NULL REFERENCES auth_users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  request_key uuid NOT NULL,
  replaces_id uuid REFERENCES stripe_payout_destination_links(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  reason varchar(500) NOT NULL CHECK (length(trim(reason)) >= 10),
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  ended_by uuid REFERENCES auth_users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  ended_at timestamptz(3),
  end_kind varchar(8),
  end_reason varchar(500),
  FOREIGN KEY (provider_id, destination_revision) REFERENCES payout_destination_versions(user_id, revision) ON DELETE RESTRICT ON UPDATE CASCADE,
  UNIQUE (provider_id, request_key),
  CHECK (platform_account_id <> stripe_account_id AND provider_id <> linked_by),
  CHECK (
    (ended_at IS NULL AND ended_by IS NULL AND end_kind IS NULL AND end_reason IS NULL)
    OR (ended_at IS NOT NULL AND ended_by IS NOT NULL AND end_kind IS NOT NULL
        AND end_kind IN ('revoke', 'replace') AND end_reason IS NOT NULL AND length(trim(end_reason)) >= 10)
  )
);

CREATE UNIQUE INDEX stripe_payout_destination_active_provider ON stripe_payout_destination_links (provider_id) WHERE ended_at IS NULL;
CREATE UNIQUE INDEX stripe_payout_destination_active_account ON stripe_payout_destination_links (platform_account_id, stripe_account_id) WHERE ended_at IS NULL;
CREATE INDEX stripe_payout_destination_history ON stripe_payout_destination_links (provider_id, created_at DESC);
