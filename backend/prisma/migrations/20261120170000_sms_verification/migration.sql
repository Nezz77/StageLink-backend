CREATE TABLE sms_contacts (
 user_id uuid PRIMARY KEY REFERENCES auth_users(id) ON DELETE CASCADE,
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0), sealed_number text, last4 char(4),
 verified_at timestamptz(3), pending_id uuid,
 booking_consent boolean NOT NULL DEFAULT false, marketing_consent boolean NOT NULL DEFAULT false, consent_at timestamptz(3),
 CHECK((sealed_number IS NULL AND last4 IS NULL AND verified_at IS NULL) OR (sealed_number IS NOT NULL AND last4 IS NOT NULL AND verified_at IS NOT NULL)),
 CHECK(NOT (booking_consent OR marketing_consent) OR verified_at IS NOT NULL)
);
CREATE TABLE sms_verifications (
 id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
 target_digest char(64) NOT NULL, last4 char(4) NOT NULL, code_digest char(64), sealed_payload text,
 expires_at timestamptz(3) NOT NULL, attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','sending','accepted','delivered','failed','unknown','cancelled')),
 provider_id varchar(120) UNIQUE, last_code varchar(80), created_at timestamptz(3) NOT NULL DEFAULT now(),
 sending_at timestamptz(3), checked_at timestamptz(3), confirmed_at timestamptz(3),
 CHECK(status NOT IN ('accepted','delivered') OR provider_id IS NOT NULL)
);
CREATE INDEX sms_verifications_status_created_at_idx ON sms_verifications(status,created_at);
CREATE TABLE sms_consent_events (
 id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE, revision integer NOT NULL,
 action varchar(20) NOT NULL CHECK(action IN ('verified','consent','revoked')), last4 char(4), target_digest char(64),
 booking_consent boolean NOT NULL, marketing_consent boolean NOT NULL, created_at timestamptz(3) NOT NULL DEFAULT now(),
 UNIQUE(user_id,revision)
);
