CREATE INDEX journal_transactions_posted_at_idx ON journal_transactions(posted_at) WHERE posted_at IS NOT NULL;
CREATE INDEX bookings_created_at_idx ON bookings(created_at);
CREATE INDEX bookings_agreed_at_idx ON bookings(agreed_at) WHERE agreed_at IS NOT NULL;
CREATE INDEX bookings_cancelled_at_idx ON bookings(cancelled_at) WHERE cancelled_at IS NOT NULL;
CREATE INDEX booking_completions_verified_at_idx ON booking_completions(verified_at) WHERE verified_at IS NOT NULL;
CREATE INDEX auth_users_created_at_idx ON auth_users(created_at);
