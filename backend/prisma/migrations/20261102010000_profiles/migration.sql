ALTER TABLE auth_tokens DROP CONSTRAINT auth_tokens_purpose_check;
ALTER TABLE auth_tokens ADD CONSTRAINT auth_tokens_purpose_check CHECK(purpose IN ('verify_email','password_reset','password_reset_grant','email_change'));
CREATE TABLE member_profiles (
 user_id UUID PRIMARY KEY REFERENCES auth_users(id) ON DELETE CASCADE ON UPDATE CASCADE,
 revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0), city VARCHAR(100) NOT NULL, phone VARCHAR(32) NOT NULL,
 organization VARCHAR(120) NOT NULL, bio VARCHAR(2000) NOT NULL,
 updated_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE provider_profiles (
 user_id UUID NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE ON UPDATE CASCADE, kind "AuthRole" NOT NULL CHECK(kind IN ('artist','renter')),
 revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0), display_name VARCHAR(120) NOT NULL, bio VARCHAR(2000) NOT NULL,
 city VARCHAR(100) NOT NULL, service_radius_km INTEGER NOT NULL CHECK(service_radius_km BETWEEN 1 AND 500),
 latitude DECIMAL(9,6), longitude DECIMAL(9,6), address VARCHAR(200) NOT NULL,
 category VARCHAR(40) NOT NULL, genres TEXT[] NOT NULL, experience_years INTEGER NOT NULL CHECK(experience_years BETWEEN 0 AND 80),
 base_rate_minor INTEGER NOT NULL CHECK(base_rate_minor BETWEEN 0 AND 100000000), currency CHAR(3) NOT NULL DEFAULT 'LKR' CHECK(currency='LKR'),
 equipment_categories TEXT[] NOT NULL, operating_hours JSONB NOT NULL, rental_terms VARCHAR(2000) NOT NULL,
 delivery_offered BOOLEAN NOT NULL DEFAULT FALSE,
 review_status TEXT NOT NULL DEFAULT 'draft' CHECK(review_status IN ('draft','pending','approved','rejected')),
 review_reason VARCHAR(2000), approved_revision INTEGER, approved_snapshot JSONB,
 updated_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(user_id,kind), CHECK((latitude IS NULL)=(longitude IS NULL)),
 CHECK(latitude IS NULL OR latitude BETWEEN -90 AND 90), CHECK(longitude IS NULL OR longitude BETWEEN -180 AND 180),
 CHECK((approved_revision IS NULL)=(approved_snapshot IS NULL)), CHECK(approved_revision IS NULL OR approved_revision<=revision)
);
CREATE INDEX provider_profiles_review_status_updated_at_idx ON provider_profiles(review_status,updated_at);
CREATE TABLE pending_email_changes (
 user_id UUID PRIMARY KEY REFERENCES auth_users(id) ON DELETE CASCADE ON UPDATE CASCADE,
 from_email VARCHAR(200) NOT NULL, new_email VARCHAR(200) NOT NULL, token_digest VARCHAR(64) UNIQUE NOT NULL,
 expires_at TIMESTAMPTZ(3) NOT NULL, CHECK(new_email=LOWER(TRIM(new_email)))
);
CREATE TABLE payout_destinations (
 user_id UUID PRIMARY KEY REFERENCES auth_users(id) ON DELETE CASCADE ON UPDATE CASCADE,
 revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0), sealed_details TEXT NOT NULL, account_last4 CHAR(4) NOT NULL CHECK(account_last4 ~ '^[0-9]{4}$'),
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
 review_reason VARCHAR(2000), updated_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX payout_destinations_status_updated_at_idx ON payout_destinations(status,updated_at);
CREATE TABLE payout_destination_versions (
 user_id UUID NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE ON UPDATE CASCADE,
 revision INTEGER NOT NULL CHECK(revision>0), sealed_details TEXT NOT NULL,
 account_last4 CHAR(4) NOT NULL CHECK(account_last4 ~ '^[0-9]{4}$'),
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
 review_reason VARCHAR(2000), reviewer_id UUID, reviewed_at TIMESTAMPTZ(3),
 created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(user_id,revision)
);
-- Audit values contain actor/target IDs, revisions and decision reasons, never raw bank numbers or old/new contact details.
CREATE TABLE profile_audits (
 id UUID PRIMARY KEY, actor_id UUID NOT NULL, target_user_id UUID NOT NULL,
 entity VARCHAR(40) NOT NULL, action VARCHAR(40) NOT NULL, revision INTEGER NOT NULL,
 reason VARCHAR(2000), created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX profile_audits_target_user_id_created_at_idx ON profile_audits(target_user_id,created_at);
