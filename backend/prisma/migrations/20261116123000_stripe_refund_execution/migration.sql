CREATE TYPE "StripeRefundState" AS ENUM ('uncertain', 'pending', 'failed', 'succeeded');

CREATE TABLE stripe_refund_executions (
  id uuid PRIMARY KEY,
  request_id uuid NOT NULL,
  order_id uuid NOT NULL,
  actor_id uuid NOT NULL REFERENCES auth_users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  payment_intent_id varchar(150) NOT NULL,
  provider_refund_id varchar(150) UNIQUE,
  amount_minor integer NOT NULL CHECK (amount_minor > 0),
  status "StripeRefundState" NOT NULL DEFAULT 'uncertain',
  lease_id uuid,
  lease_until timestamptz(3),
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  settlement_id uuid UNIQUE REFERENCES journal_transactions(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  UNIQUE (request_id, order_id),
  FOREIGN KEY (request_id, order_id) REFERENCES refund_items(request_id, order_id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CHECK ((lease_id IS NULL) = (lease_until IS NULL)),
  CHECK ((status = 'succeeded') = (settlement_id IS NOT NULL)),
  CHECK (status = 'uncertain' OR provider_refund_id IS NOT NULL)
);
