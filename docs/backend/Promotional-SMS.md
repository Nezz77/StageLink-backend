# Promotional SMS campaigns

Implemented 21 November 2026. Backend only; member preferences and administrator campaign screens still need frontend and Figma wiring. No real SMS was sent during development.

## Configuration

`PROMOTIONAL_SMS_DELIVERY=false` by default. Enabling it requires `TEXTLK_TOKEN` and the approved `TEXTLK_SENDER`. Verification and booking reminder flags remain independent. No configuration enables marketing consent on a user's behalf.

All three SMS flows share `SMS_HOURLY_LIMIT` (default 20). A PostgreSQL advisory lock and database clock count claimed submissions, including unknown and failed sends, across workers and channels. Read-only delivery reconciliation does not consume another submission. An account deletion must retain referenced campaign delivery history.

Keep delivery off until the member-facing SMS preferences screen and its advertised navigation are available and hosted sender/delivery behavior has been checked. Tests use synthetic accounts and mocked transports.

## Administrator workflow

Only authenticated, email-verified administrators can access `/api/v1/admin/sms-campaigns`. Mutations also require the exact web origin, JSON, and CSRF token, with fresh authorization under the user lock.

1. `POST /admin/sms-campaigns` with `{id, body, recipientLimit}` creates an immutable draft. The caller supplies a UUID; matching retries return the same draft and changed reuse is rejected. Limit is 1–100 accounts.
2. `POST /admin/sms-campaigns/:id/preview` with `{}` returns a count and audience fingerprint. Phone numbers and recipient identities are omitted. Only enabled members with verified email, verified SMS contact and independent marketing SMS consent qualify. Booking SMS or promotional email consent does not qualify.
3. `POST /admin/sms-campaigns/:id/schedule` with `{scheduledFor, audienceFingerprint}` freezes that audience and its contact revisions. Choose a future time within 30 days. A changed audience requires another preview. An identical scheduling retry returns the recorded decision.
4. `GET /admin/sms-campaigns` (optional `after` UUID) and `GET /admin/sms-campaigns/:id` show the final message, delivery-enabled flag, and counts for queued, sending, accepted, delivered, failed, unknown and skipped recipients.
5. `POST /admin/sms-campaigns/:id/cancel` with `{reason}` records the administrator, time and reason and skips unsent rows. Cancellation cannot recall an already claimed/submitted message. Editing requires a new campaign ID.

The body is at most 100 characters from a restricted GSM basic alphabet. The final SMS adds `StageLink: ` and `Stop SMS: StageLink > Account > SMS preferences.` and remains under 160 characters. Unicode and GSM extension characters are rejected in this first version. The final text is included in the administrator read response before scheduling. Reply-based STOP processing and a public SMS unsubscribe endpoint are not implemented.

## Consent and delivery

The existing `PUT /me/sms-contact/consent` controls marketing SMS separately from booking SMS. Revocation, changed contact revision, disabled/unverified account or removed member role skips the saved campaign recipient. A later opt-in never revives that recipient automatically; a new campaign needs another audience review. Any contact revision change conservatively invalidates the saved recipient, including a booking-only consent change.

The worker locks user → campaign → shared SMS budget, rechecks eligibility and records its claim before making one provider request. The number is decrypted only for submission; campaign records store a keyed recipient digest, never the plaintext phone. The campaign is deliverable for 24 hours after its scheduled time. Expired queued recipients are skipped, including while delivery is paused.

Accepted is distinct from delivered. A known provider ID can be retrieved every 30 seconds for up to 24 hours after submission; sender, recipient digest and message ID must match. Temporary retrieval failures preserve prior acceptance. Interrupted or ambiguous sends become unknown and are never automatically resubmitted; definite failures also have no retry endpoint. The original audience and delivery state remain recorded when a campaign is cancelled.

The adapter uses text.lk's documented [single-message submission](https://text.lk/docs/send-sms/) and [message retrieval](https://text.lk/docs/view-sms/) endpoints. Hosted retrieval response compatibility and actual delivery still require provider-account checks. Bulk provider contact lists are not used.

## Verification

Unit checks cover default-off settings, independent provider enablement, basic-alphabet restrictions and the complete message budget. The isolated PostgreSQL integration covers administrator/CSRF/origin checks, frozen audience changes, account-scoped consent, booking-only exclusion, idempotent drafts/schedules, duplicate worker claims, cancellation, opt-out, shared verification submission budget, uncertain/failed sends without retries, delivery reconciliation, expiry, disabled accounts and a skewed application clock. Fixtures delete their own campaign, delivery and account rows.

Local checks passed: 61 Node unit tests, 30 integration scenarios, migration deploy repeated safely, TypeScript build and generated API contracts. Hosted delivery is a separate pending check.
