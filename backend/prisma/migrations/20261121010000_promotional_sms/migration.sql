CREATE TABLE sms_campaigns (
 id uuid PRIMARY KEY, body varchar(100) NOT NULL CHECK (length(body)>0 AND body !~ '[^ -~]'),
 recipient_limit integer NOT NULL CHECK (recipient_limit BETWEEN 1 AND 100),
 state "PromotionalCampaignState" NOT NULL DEFAULT 'draft',
 created_by uuid NOT NULL REFERENCES auth_users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
 created_at timestamptz(3) NOT NULL DEFAULT now(),
 scheduled_for timestamptz(3), scheduled_by uuid REFERENCES auth_users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
 cancelled_by uuid REFERENCES auth_users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
 cancelled_at timestamptz(3), cancellation_reason varchar(500),
 CHECK (state <> 'scheduled' OR (scheduled_for IS NOT NULL AND scheduled_by IS NOT NULL)),
 CHECK (state <> 'cancelled' OR (cancelled_at IS NOT NULL AND cancelled_by IS NOT NULL AND length(cancellation_reason)>=10))
);
CREATE TYPE "SmsCampaignDeliveryStatus" AS ENUM ('queued','sending','accepted','delivered','failed','unknown','skipped');
CREATE TABLE sms_campaign_recipients (
 campaign_id uuid NOT NULL REFERENCES sms_campaigns(id) ON DELETE RESTRICT ON UPDATE CASCADE,
 user_id uuid NOT NULL REFERENCES auth_users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
 contact_revision integer NOT NULL CHECK (contact_revision>0),
 status "SmsCampaignDeliveryStatus" NOT NULL DEFAULT 'queued',
 target_digest char(64), provider_id varchar(120) UNIQUE,
 sending_at timestamptz(3), checked_at timestamptz(3), last_code varchar(80),
 PRIMARY KEY(campaign_id,user_id),
 CHECK ((target_digest IS NULL) = (sending_at IS NULL)),
 CHECK (status <> 'sending' OR sending_at IS NOT NULL),
 CHECK (status NOT IN ('accepted','delivered') OR (provider_id IS NOT NULL AND sending_at IS NOT NULL))
);
CREATE INDEX sms_campaign_recipients_status_campaign_id_idx ON sms_campaign_recipients(status,campaign_id);
CREATE INDEX sms_campaign_recipients_sending_at_idx ON sms_campaign_recipients(sending_at);
