CREATE TYPE "CampaignDeliveryStatus" AS ENUM ('queued', 'sending', 'accepted', 'failed', 'unknown', 'skipped');

ALTER TABLE promotional_campaign_recipients
  ADD COLUMN delivery_status "CampaignDeliveryStatus" NOT NULL DEFAULT 'queued',
  ADD COLUMN claimed_at timestamptz(3),
  ADD COLUMN resolved_at timestamptz(3),
  ADD COLUMN delivery_code varchar(48),
  ADD CONSTRAINT campaign_recipient_delivery_dates CHECK (
    (delivery_status IN ('queued', 'skipped')) = (claimed_at IS NULL)
    AND (delivery_status IN ('queued', 'sending')) = (resolved_at IS NULL)
  );

CREATE INDEX campaign_recipient_delivery_idx ON promotional_campaign_recipients(delivery_status, campaign_id);
CREATE INDEX campaign_recipient_claim_idx ON promotional_campaign_recipients(claimed_at);

UPDATE promotional_campaign_recipients r
SET delivery_status='skipped', resolved_at=c.cancelled_at, delivery_code='CAMPAIGN_CANCELLED'
FROM promotional_campaigns c
WHERE c.id=r.campaign_id AND c.state='cancelled';
