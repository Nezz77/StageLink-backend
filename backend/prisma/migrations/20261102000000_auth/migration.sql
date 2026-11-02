CREATE TYPE "AuthRole" AS ENUM ('customer','artist','renter','admin');
CREATE TABLE auth_users (
 id UUID PRIMARY KEY, email VARCHAR(200) NOT NULL UNIQUE,
 display_name VARCHAR(80) NOT NULL, password_hash TEXT NOT NULL,
 roles "AuthRole"[] NOT NULL DEFAULT ARRAY['customer']::"AuthRole"[],
 email_verified_at TIMESTAMPTZ(3), disabled_at TIMESTAMPTZ(3),
 created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK(email = LOWER(TRIM(email))), CHECK(cardinality(roles) > 0)
);
CREATE TABLE auth_sessions (
 id UUID PRIMARY KEY, user_id UUID NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE ON UPDATE CASCADE,
 active_role "AuthRole" NOT NULL, created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 expires_at TIMESTAMPTZ(3) NOT NULL, revoked_at TIMESTAMPTZ(3)
);
CREATE INDEX auth_sessions_user_id_revoked_at_idx ON auth_sessions(user_id,revoked_at);
CREATE TABLE auth_refresh_credentials (
 id UUID PRIMARY KEY, session_id UUID NOT NULL REFERENCES auth_sessions(id) ON DELETE CASCADE ON UPDATE CASCADE,
 secret_digest VARCHAR(64) NOT NULL, created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 expires_at TIMESTAMPTZ(3) NOT NULL, consumed_at TIMESTAMPTZ(3)
);
CREATE INDEX auth_refresh_credentials_session_id_idx ON auth_refresh_credentials(session_id);
CREATE TABLE auth_tokens (
 id UUID PRIMARY KEY, user_id UUID NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE ON UPDATE CASCADE,
 purpose TEXT NOT NULL CHECK(purpose IN ('verify_email','password_reset','password_reset_grant')),
 email VARCHAR(200) NOT NULL, digest VARCHAR(64) NOT NULL UNIQUE,
 expires_at TIMESTAMPTZ(3) NOT NULL, used_at TIMESTAMPTZ(3), created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX auth_tokens_user_id_purpose_used_at_idx ON auth_tokens(user_id,purpose,used_at);
CREATE TABLE auth_mail_outbox (
 id UUID PRIMARY KEY, user_id UUID NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE ON UPDATE CASCADE,
 sealed_payload TEXT, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','delivered','failed','expired')),
 attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
 created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, available_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 expires_at TIMESTAMPTZ(3) NOT NULL, locked_until TIMESTAMPTZ(3), lease_owner UUID,
 delivered_at TIMESTAMPTZ(3), last_error_code TEXT
);
CREATE INDEX auth_mail_due_idx ON auth_mail_outbox(available_at,created_at) WHERE status='pending';
