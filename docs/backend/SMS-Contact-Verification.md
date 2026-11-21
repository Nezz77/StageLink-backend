# SMS contact verification and consent

StageLink uses text.lk for verified SMS contacts, booking reminders and promotional campaigns. Booking and marketing consent are separate choices. Client controls and their Figma handoff remain open.

## Member flow

All routes require the current authenticated account. Mutations require the configured Origin, JSON and CSRF token; caller-supplied owners/statuses are rejected.

1. `GET /api/v1/me/sms-contact` returns the revision, masked last four digits, verified state, SMS consent and pending challenge summary. It never returns a number, OTP or provider credential.
2. `POST /api/v1/me/sms-contact/verification` with `{revision, number}` queues one verification message. A verified account email and enabled provider configuration are required. Only one Sri Lankan mobile is accepted, normalized from `07…`, `+947…` or `947…` to `947…`. Lists, foreign numbers and landlines are rejected. Requests have per-account and per-number hourly limits plus an account cooldown.
3. The worker claims the message in PostgreSQL, rechecks the account and current challenge, and submits once to text.lk. The code expires in ten minutes. `POST /api/v1/me/sms-contact/confirm` takes `{challengeId, code}`. Five valid-format wrong attempts invalidate that challenge; rate limits also bound confirmation requests. Queued, expired, superseded, used and other-account challenges cannot verify. Possession of a correct delivered code can verify a message with an uncertain send outcome.
4. `PUT /api/v1/me/sms-contact/consent` takes `{revision, bookingConsent, marketingConsent}`. Both SMS consents default off, require a verified contact to enable and remain distinct from email preferences. Confirmation of a replacement number resets both. Existing contact consent stays bound to the old verified number while a replacement is pending.
5. `POST /api/v1/me/sms-contact/revoke` takes `{revision}`. It clears the stored contact and both consents, invalidates outstanding codes, cancels queued verification/booking messages and skips queued campaigns. New revocations append consent evidence in the same transaction; earlier missing revocation records are not reconstructed. An already submitted message cannot be recalled. Its recorded delivery status is preserved.
6. `GET /api/v1/me/sms-verifications` returns the account's latest twenty masked verification/delivery records. Consent events append the contact revision, target digest, last four digits, choices and action in the same transaction. No application route updates that history.

## Stop SMS during maintenance

`POST /api/v1/me/sms-contact/opt-out` accepts `{channel: "booking"}`, `{channel: "marketing"}` or `{channel: "all"}`. It can only turn consent off, preserves the verified contact and pending number verification, and requires the current signed-in account, Origin, JSON and CSRF token. It needs no contact revision or verified email and makes no provider request. Repeated identical opt-outs return the same contact revision without duplicate consent events. An account without an SMS contact remains unchanged.

Opt-out and number revocation remain available during read-only maintenance. The ordinary consent update, verification request and confirmation routes remain blocked by maintenance; the off-only endpoint cannot enable either channel or change another account. Email preferences are independent.

Changed choices, consent evidence and queued-message invalidation commit together under the account lock used by send claims. Marketing opt-out preserves booking SMS consent and eligible booking reminders. Booking opt-out preserves the marketing consent flag, but any contact revision change conservatively invalidates a previously reviewed campaign audience, as before. The existing `PUT /me/sms-contact/consent` now invalidates ineligible queued sends immediately too. Late scheduler inserts still undergo current-consent checks before a send can be claimed.

Already claimed, accepted, delivered, failed or uncertain delivery records are preserved. An in-flight message cannot be recalled. Removing the contact erases usable verification code/payload data while retaining submitted-message evidence. Damaged encrypted contact data does not prevent stopping SMS or removing the number; audit metadata retains the recorded last four digits and uses a null target digest if the number cannot be decrypted. Audit timestamps use database time.

Verification is proof of number possession for notification contact only. It does not sign in, reset passwords or replace account security. Existing profile phone text does not automatically become a verified SMS contact.

## Provider and worker

Set `SMS_VERIFICATION_ENABLED=true`, `TEXTLK_TOKEN` and the approved `TEXTLK_SENDER` to enable verification messages. `SMS_HOURLY_LIMIT` defaults to 20 total submissions per hour across verification, booking reminders and promotional campaigns on all workers sharing the database. Compose forwards these settings and all three send flags default to `false`. Hosted delivery still needs a configured sender and provider verification.

The adapter uses the fixed HTTPS text.lk v3 send endpoint, JSON and an Authorization bearer header. It does not place credentials/OTP in query strings or follow redirects. Send timeout, interrupted worker and ambiguous responses are `unknown` and are never automatically resubmitted. Explicit provider rejection is `failed`. A valid provider identifier and matching recipient/sender are required to record accepted/delivered status. A successful HTTP response by itself is not evidence of delivery.

Known message IDs become eligible for another retrieval after thirty seconds, for up to 24 hours. Concurrent workers may make overlapping read-only retrievals. Retrieval must match the expected ID, recipient digest and sender. An outage or mismatched response preserves the prior delivery state and records a bounded error code. Unknown outcomes without an ID remain unresolved; requesting a new challenge is a separate rate-limited action, not a resend of the old message. Background dispatch is disabled by default and does not use real provider credentials in tests.

Phone numbers and OTP message payloads are AES-GCM encrypted under the existing mail key with separate contact/challenge authenticated contexts. The code is retained as a purpose-bound HMAC. Confirmation, expiry, revocation and replacement erase the code/payload. Delivery history retains masked digits and a keyed recipient digest. Secrets and provider response bodies are not logged or echoed. Final retention/key rotation and delivery confirmation on the hosted provider remain deployment work.

Provider references: [text.lk send API](https://text.lk/docs/send-sms/) and [message retrieval](https://text.lk/docs/view-sms/). Retrieval documentation does not supply a complete success schema/status vocabulary; the adapter conservatively requires the matching message fields documented by Send SMS. Hosted contract verification remains open.

## Booking reminders

Set `BOOKING_SMS_REMINDERS=true` with the same text.lk credentials to enable booking SMS. The worker schedules 24-hour and 2-hour reminders for the customer and provider on agreed bookings with a paid advance. Each recipient needs a verified SMS contact and booking consent. There is one reminder per recipient, booking start and reminder window.

Before claiming a send, the worker checks the current contact, consent, booking time and payment state. An opt-out, cancellation or reschedule cancels stale queued reminders. A message already submitted to the provider cannot be recalled. Delivery uses the shared hourly cap and the same evidence checks as contact verification. Unknown submissions remain in history and are not automatically resent.

Members can read their latest 20 reminder records at `GET /api/v1/me/booking-sms-reminders`. Each item shows the booking, schedule, delivery status and last check time. SMS and email delivery have separate settings. Hosted SMS delivery and frontend/Figma controls remain open.

## Validation boundaries

Tests use disposable `.test` accounts, synthetic phone numbers and intercepted text.lk requests. Verification tests cover access, encryption, code attempts and expiry, consent and provider outcomes. Booking reminder tests cover shared submission limits, concurrent claims, paid bookings, separate booking consent, opt-out, uncertain sends, reconciliation and account-scoped history.

Local validation on 21 November 2026: all 67 unit tests and 32 integration scenarios passed, with migrations applied and repeated safely. API contract generation, TypeScript checks and changed-file formatting passed. Hosted text.lk delivery and client/Figma integration are not verified by these tests.

Promotional SMS campaigns now use the independent marketing consent through the [campaign workflow](Promotional-SMS.md). Delivery remains disabled by default.

Administrator queue monitoring and audited cancellation of queued booking SMS are available through [SMS reminder operations](SMS-Reminder-Operations.md). Submitted or uncertain messages cannot be recalled or resent through that API.
