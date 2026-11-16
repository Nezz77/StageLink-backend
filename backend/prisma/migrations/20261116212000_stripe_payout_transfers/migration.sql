CREATE TYPE "StripePayoutTransferState" AS ENUM ('uncertain', 'transferred', 'review_required');

CREATE TABLE stripe_payout_transfers (
  id uuid PRIMARY KEY,
  payout_id uuid NOT NULL UNIQUE REFERENCES payout_orders(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  destination_link_id uuid NOT NULL REFERENCES stripe_payout_destination_links(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  actor_id uuid NOT NULL REFERENCES auth_users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  reserved_account_id uuid NOT NULL REFERENCES financial_accounts(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  amount_minor integer NOT NULL CHECK (amount_minor > 0),
  status "StripePayoutTransferState" NOT NULL DEFAULT 'uncertain',
  provider_transfer_id varchar(150) UNIQUE,
  journal_id uuid UNIQUE REFERENCES journal_transactions(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  lease_id uuid,
  lease_until timestamptz(3),
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  CHECK ((lease_id IS NULL) = (lease_until IS NULL)),
  CHECK (
    (status = 'uncertain' AND provider_transfer_id IS NULL AND journal_id IS NULL) OR
    (status = 'transferred' AND provider_transfer_id IS NOT NULL AND journal_id IS NOT NULL) OR
    (status = 'review_required' AND provider_transfer_id IS NOT NULL)
  )
);
