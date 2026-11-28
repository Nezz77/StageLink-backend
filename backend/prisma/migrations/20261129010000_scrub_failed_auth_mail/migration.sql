UPDATE auth_mail_outbox
SET sealed_payload = NULL, locked_until = NULL, lease_owner = NULL
WHERE status = 'failed' AND sealed_payload IS NOT NULL;
