# Booking SMS reminder operations

Implemented 21 November 2026. Backend support for the administrator reminder queue; frontend/Figma queue controls and hosted SMS checks remain pending. The existing email queue API is unchanged.

## Read the queue

Authenticated, email-verified administrators can use:

- `GET /api/v1/admin/sms-reminders` with optional `bookingId`, `offsetHours` (`2` or `24`), `status`, and `cursor` filters.
- `GET /api/v1/admin/sms-reminders/:id` for an individual reminder and any administrator cancellation record.

The list returns at most 30 rows ordered by UUID, a `nextCursor`, real database counts for queued, sending, accepted, delivered, failed, unknown and cancelled, the `BOOKING_SMS_REMINDERS` enabled flag and configured shared `SMS_HOURLY_LIMIT`. Counts include all statuses within the booking/window filters, independent of the status filter and page cursor. They are not delivery guarantees or a remaining-balance estimate.

Each row includes the booking/recipient IDs, 24-hour or 2-hour window, booking start and due time, delivery status, claim/check timestamps, last diagnostic code, whether cancellation is currently possible, and recorded administrator cancellation evidence. The projection omits phone numbers, encrypted contact fields, keyed recipient digests, provider message IDs, OTPs and provider credentials. Member accounts cannot access this operations view; their existing `/me/booking-sms-reminders` history remains account-scoped.

## Cancel an unsent reminder

`POST /api/v1/admin/sms-reminders/:id/cancel` accepts `{reason}` with 10–500 characters. It requires the configured Origin, JSON, a valid CSRF token and fresh verified administrator authorization inside the transaction.

The transaction locks the reminder row used by the sender, checks that it is still queued, inserts one cancellation record with the actor, reason and database timestamp, and changes its status to cancelled with `ADMIN_CANCELLED`. The unique schedule row remains present, so the scheduler cannot recreate the same reminder. Rescheduling a booking creates a different schedule identity through the existing worker behavior.

An identical retry by the same administrator returns the original cancellation. A changed reason, another administrator or a non-queued reminder returns a conflict; an automatic policy cancellation does not acquire fabricated administrator evidence. There is no SMS retry/resend route. Sending, accepted, delivered, failed and unknown messages cannot be recalled through this API.

The claim boundary is decisive: if cancellation obtains the row before submission is claimed, the worker skips it. If the worker has already committed its claim, cancellation fails even while the provider request is still in flight. This prevents an administrator from receiving a false cancellation confirmation after a message has started sending. Existing provider reconciliation continues independently.

Cancellation remains available when delivery is disabled or read-only maintenance is active. The maintenance exception applies only to this cancellation route; administrator verification and CSRF/origin checks still apply. This task does not enable `BOOKING_SMS_REMINDERS`, create recipient consent or send real SMS.

## Verification

The isolated PostgreSQL integration uses synthetic scheduler history and disposable `.test` accounts. It covers seven-state counts, booking/window/status filters, UUID pagination, omitted private fields, administrator/email verification, revoked/disabled sessions, origin/CSRF/body validation, identical concurrent cancellation, changed-command conflicts, preservation of automatic cancellation, unsupported retry, scheduler deduplication, a sender/cancellation race and deterministic rejection of an in-flight cancellation. Fixtures remove their own audit, reminder, payment, booking and account rows.

Local validation passed: 64 Node unit tests, 31 integration scenarios, migrations deployed twice, TypeScript build and API contract generation. Hosted delivery and frontend/Figma behavior are separate pending checks.
