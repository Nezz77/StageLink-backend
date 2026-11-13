CREATE TYPE "PaymentPurpose" AS ENUM ('advance', 'balance', 'deposit');
CREATE TYPE "PaymentOrderStatus" AS ENUM ('open', 'pending', 'failed', 'cancelled', 'paid', 'review');

CREATE TABLE payment_orders (
  id uuid PRIMARY KEY,
  booking_id uuid NOT NULL REFERENCES bookings(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  purpose "PaymentPurpose" NOT NULL,
  amount_minor integer NOT NULL CHECK (amount_minor > 0),
  currency char(3) NOT NULL DEFAULT 'LKR' CHECK (currency = 'LKR'),
  status "PaymentOrderStatus" NOT NULL DEFAULT 'open',
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT payment_orders_booking_id_purpose_key UNIQUE (booking_id, purpose)
);
