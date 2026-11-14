CREATE TABLE marketing_email_preferences (
  user_id uuid PRIMARY KEY REFERENCES auth_users(id) ON DELETE CASCADE ON UPDATE CASCADE,
  consent_email varchar(200),
  revision integer NOT NULL CHECK (revision > 0),
  updated_at timestamptz(3) NOT NULL DEFAULT now()
);
CREATE INDEX marketing_email_preferences_consent_idx ON marketing_email_preferences(user_id) WHERE consent_email IS NOT NULL;

CREATE TYPE "PromotionalCampaignState" AS ENUM ('draft', 'scheduled', 'cancelled');
CREATE TABLE promotional_campaigns (
  id uuid PRIMARY KEY,
  created_by uuid NOT NULL REFERENCES auth_users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  subject varchar(140) NOT NULL CHECK (length(trim(subject)) > 0),
  body varchar(4000) NOT NULL CHECK (length(trim(body)) > 0),
  recipient_limit integer NOT NULL CHECK (recipient_limit BETWEEN 1 AND 100),
  state "PromotionalCampaignState" NOT NULL DEFAULT 'draft',
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  scheduled_for timestamptz(3),
  scheduled_by uuid REFERENCES auth_users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  cancelled_by uuid REFERENCES auth_users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  cancellation_reason varchar(500),
  cancelled_at timestamptz(3),
  CHECK ((scheduled_for IS NULL) = (scheduled_by IS NULL)),
  CHECK (state <> 'scheduled' OR scheduled_for IS NOT NULL),
  CHECK (state <> 'draft' OR scheduled_for IS NULL),
  CHECK ((state = 'cancelled') = (cancelled_at IS NOT NULL)),
  CHECK ((cancelled_at IS NULL) = (cancelled_by IS NULL) AND (cancelled_at IS NULL) = (cancellation_reason IS NULL))
);
CREATE INDEX promotional_campaigns_schedule_idx ON promotional_campaigns(scheduled_for) WHERE scheduled_for IS NOT NULL;

CREATE TABLE promotional_campaign_recipients (
  campaign_id uuid NOT NULL REFERENCES promotional_campaigns(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  user_id uuid NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE ON UPDATE CASCADE,
  consent_revision integer NOT NULL CHECK (consent_revision > 0),
  PRIMARY KEY (campaign_id, user_id)
);
CREATE INDEX promotional_campaign_recipients_user_idx ON promotional_campaign_recipients(user_id);
