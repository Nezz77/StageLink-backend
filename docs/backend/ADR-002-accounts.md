# ADR 002 — Persistent accounts and recovery

Date: 2026-11-02. Scope: backend branch P02, following ADR 001.

## Account boundary

NestJS owns normalized email, display name, password hash and assigned account roles. PostgreSQL owns sessions, refresh credentials, purpose-bound tokens and transactional mail deliveries. The browser receives only a public account projection. It cannot select an arbitrary user or promote itself to administrator. Artist/renter signup adds customer plus the requested provider account type; approval, listing and payout eligibility require separate business checks in later phases.

API mode opens an account workspace containing the real user's identity and allowed roles. Original dashboards remain in the explicit demo app; catalog browsing is labeled sample content. This prevents successful authentication from presenting another person's hardcoded bookings, balances or messages. P03 connects profiles/onboarding before subsequent feature phases.

## Credentials and sessions

- Passwords use asynchronous scrypt, independent random salts, N=32768, r=8, p=3 and 32-byte hashes. Registration/reset accepts 12–128 characters without trimming/truncation. Unknown-user login still derives a hash. Login rechecks the stored hash under a user row lock so concurrent reset cannot leave an old-password login alive.
- Ten-minute HS256 access JWTs validate issuer, audience, algorithm, type and maximum age. Every protected request also checks the SQL session, disabled state and current role membership.
- Thirty-day absolute sessions use opaque refresh credentials stored as SHA-256 digests. Rotation locks the session row. Reuse of a valid consumed credential commits session-family revocation. Logout revokes that SQL session; reset revokes all user sessions.
- Refresh cookies are HTTPOnly, SameSite=Strict and Path=/. Production requires HTTPS, Secure and the `__Host-` prefix. Access/CSRF values stay in browser memory. Web Locks serialize rotation across tabs; BroadcastChannel sends change notices without credentials. Browsers without Web Locks may need to sign in again if concurrent refresh triggers reuse protection.
- Mutations require JSON and exact Origin, reject cross-site fetch metadata, and authenticated mutations require a session-bound HMAC CSRF token. Redis rate limits hash identities and fail closed on outage. The API does not trust arbitrary forwarded IPs; deployment must configure a trusted proxy boundary before per-client IP limiting behind a proxy.

## Verification and recovery

Verification lasts 24 hours. Recovery links last 15 minutes and exchange once for a separate five-minute reset grant. Tokens/grants are hashed, purpose-bound, tied to the current email and single-use. New requests supersede outstanding links of the same purpose. Completion changes the actual password, consumes outstanding tokens and revokes sessions.

Registration/recovery requests return uniform acceptance content and never overwrite credentials. This does not claim perfect timing indistinguishability across database/network conditions.

Mail queues in the token transaction. AES-256-GCM encrypts recipient/token payloads under a separate 32-byte key. The worker leases claims, rechecks token/account eligibility, and retries with bounded backoff. SMTP acceptance marks delivery and removes the encrypted payload; stale pending jobs expire. Delivery is at least once: uncertain SMTP results can cause duplicate messages with the same message ID. SMTP acceptance does not prove inbox delivery. Local QA verifies actual messages in Mailpit; no external email service is enabled.

Links put tokens in URL fragments; the app clears them when opening the form and requires explicit submission. Account pages exclude analytics. Passwords/tokens/mail payloads are excluded from structured logs. Recovery and verification dialogs stay mounted while session state refreshes, preserving completion messages.

## Administration and remaining work

Administrator bootstrap is create-only, requires a protected stdin password, and never overwrites an account. `/admin/access` proves server role enforcement; it is not the full admin backend.

Sockets do not exist in P02. P10 must check persisted sessions at connection/message time and disconnect revoked sessions. P03/P16 must authorize provider approval and membership changes. Data-retention/failed-mail cleanup, trusted production proxy configuration, hosted SMTP, deployment secrets, provider integrations and broader security/load testing remain later work. This is a tested development checkpoint, not the complete backend or a production deployment.

## Evidence

See `auth-validation.json` and `figma-auth-mapping.json` for checked behavior and real design/prototype node IDs. Six backend unit tests, two dependency integration scenarios and 163 frontend tests passed locally, with TypeScript and production/container builds. Browser screenshots use a disposable `.test` account. Figma flows are visual prototypes; they do not execute the database or deliver email.
