# SMS contact verification and consent

P17 backend foundation on `backend/sms-contact-verification`. The report specifies text.lk. This change implements verified contact registration and explicit SMS consent, not booking SMS scheduling or promotional SMS campaigns. Existing email reminders and campaigns retain their own controls. No UI/Figma files change here; client controls and their design handoff remain follow-up work.

## Member flow

All routes require the current authenticated account. Mutations require the configured Origin, JSON and CSRF token; caller-supplied owners/statuses are rejected.

1. `GET /api/v1/me/sms-contact` returns the revision, masked last four digits, verified state, SMS consent and pending challenge summary. It never returns a number, OTP or provider credential.
2. `POST /api/v1/me/sms-contact/verification` with `{revision, number}` queues one verification message. A verified account email and enabled provider configuration are required. Only one Sri Lankan mobile is accepted, normalized from `07…`, `+947…` or `947…` to `947…`. Lists, foreign numbers and landlines are rejected. Requests have per-account and per-number hourly limits plus an account cooldown.
3. The worker claims the message in PostgreSQL, rechecks the account and current challenge, and submits once to text.lk. The code expires in ten minutes. `POST /api/v1/me/sms-contact/confirm` takes `{challengeId, code}`. Five valid-format wrong attempts invalidate that challenge; rate limits also bound confirmation requests. Queued, expired, superseded, used and other-account challenges cannot verify. Possession of a correct delivered code can verify a message with an uncertain send outcome.
4. `PUT /api/v1/me/sms-contact/consent` takes `{revision, bookingConsent, marketingConsent}`. Both SMS consents default off, require a verified contact to enable and remain distinct from email preferences. Confirmation of a replacement number resets both. Existing contact consent stays bound to the old verified number while a replacement is pending.
5. `POST /api/v1/me/sms-contact/revoke` takes `{revision}`. It clears the stored contact and both consents, invalidates outstanding codes and cancels queued verification messages. An already submitted message cannot be recalled. Its recorded delivery status is preserved.
6. `GET /api/v1/me/sms-verifications` returns the account's latest twenty masked verification/delivery records. Consent events append the contact revision, target digest, last four digits, choices and action in the same transaction. No application route updates that history.

Verification is proof of number possession for notification contact only. It does not sign in, reset passwords or replace account security. Existing profile phone text does not automatically become a verified SMS contact.

## Provider and worker

Set `SMS_VERIFICATION_ENABLED=true`, `TEXTLK_TOKEN` and the approved `TEXTLK_SENDER` (alphanumeric, at most 11 characters) only when the deployment is ready. `SMS_HOURLY_LIMIT` defaults to 20 submissions across workers sharing the database. Compose forwards these settings; examples leave delivery off. No credentials are seeded or enabled by setup. Production credentials and actual sender/provider behavior still need hosted verification.

The adapter uses the fixed HTTPS text.lk v3 send endpoint, JSON and an Authorization bearer header. It does not place credentials/OTP in query strings or follow redirects. Send timeout, interrupted worker and ambiguous responses are `unknown` and are never automatically resubmitted. Explicit provider rejection is `failed`. A valid provider identifier and matching recipient/sender are required to record accepted/delivered status. A successful HTTP response by itself is not evidence of delivery.

Known message IDs become eligible for another retrieval after thirty seconds, for up to 24 hours. Concurrent workers may make overlapping read-only retrievals. Retrieval must match the expected ID, recipient digest and sender. An outage or mismatched response preserves the prior delivery state and records a bounded error code. Unknown outcomes without an ID remain unresolved; requesting a new challenge is a separate rate-limited action, not a resend of the old message. Background dispatch is disabled by default and does not use real provider credentials in tests.

Phone numbers and OTP message payloads are AES-GCM encrypted under the existing mail key with separate contact/challenge authenticated contexts. The code is retained as a purpose-bound HMAC. Confirmation, expiry, revocation and replacement erase the code/payload. Delivery history retains masked digits and a keyed recipient digest. Secrets and provider response bodies are not logged or echoed. Final retention/key rotation and delivery confirmation on the hosted provider remain deployment work.

Provider references: [text.lk send API](https://text.lk/docs/send-sms/) and [message retrieval](https://text.lk/docs/view-sms/). Retrieval documentation does not supply a complete success schema/status vocabulary; the adapter conservatively requires the matching message fields documented by Send SMS. Hosted contract verification remains open.

## Validation boundaries

Tests use disposable `.test` accounts, synthetic phone numbers and intercepted text.lk requests. They cover strict phone/configuration parsing, role/ownership/Origin/CSRF rules, encrypted payloads, five-attempt limits, expiry and reuse, explicit revisioned consent and revocation, sender/recipient evidence checks, concurrent worker deduplication, an hourly submission cap, interrupted/uncertain send behavior, provider rejection, reconciliation and disabled accounts/provider delivery. No real SMS is sent. Booking reminders and marketing workers must consume only a current verified contact and the appropriate consent when those channels are added.

Local validation on 20 November 2026: all 56 unit tests and 28 integration scenarios passed, with migrations applied and repeated safely. API contract generation, TypeScript checks and changed-file formatting passed. Hosted text.lk delivery and client/Figma integration are not verified by these tests.
