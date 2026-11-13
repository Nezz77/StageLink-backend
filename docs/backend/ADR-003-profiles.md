# ADR 003 — Profiles, onboarding and payout destinations

Date: 2026-11-02. Scope: P03 on `backend`, retaining NestJS, Prisma, PostgreSQL, Redis and the existing React/Vite frontend.

## Ownership and publication

Member contact information belongs to an authenticated account, not a global role. Artist and equipment-storefront profiles use `(user_id, kind)` keys and require the corresponding server-assigned membership. The API rejects client-supplied owners, roles, review status and arbitrary profile fields. Saves and submissions use expected revisions under a user row lock; stale edits return 409 rather than overwriting another edit.

Artist data includes category, genres, experience and an integer-minor-unit LKR starting rate. Renter data includes equipment categories, seven-day opening hours, rental terms and delivery preference. Same-day hours use Sri Lanka time, with Monday indexed as day zero. Drafts may contain a fully closed schedule; submission requires at least one opening day. Profile service location includes a public city/radius and optional private address/coordinate pair. Coordinates are bounded decimals and never enter public projections.

Profile review is separate from identity/KYC verification and financial eligibility. Only a verified account can submit. An administrator with a login less than 15 minutes old can approve or request changes, with a reason and exact revision. Self-review is rejected. Approval stores an allowlisted public snapshot. Later draft edits and rejected revisions preserve the prior approved snapshot instead of silently publishing new content. Disabled accounts do not have publicly readable profiles. Public responses exclude phone, email, exact address, coordinates and payout data. The sample catalog remains explicitly labeled until P06 connects discovery to persisted listings/providers.

## Contact and email changes

A normal profile save cannot alter the sign-in email. Email changes require the current password, Origin/CSRF checks, rate limits and a one-time confirmation sent through the transactional mail worker. The current verified delivery contact stays active until the new address is confirmed. Tokens expire after 15 minutes, are hashed, bind the previous and candidate addresses, and are single-use. A database uniqueness conflict rolls back the change and does not take over an existing account.

The request and pending UI behave uniformly for available/unavailable candidates. Confirmation revokes all sessions and outstanding tokens. Password reset also cancels a pending email change. The frontend removes confirmation tokens from URL fragments and keeps the completion dialog mounted while session state updates. External mail remains disabled; local Mailpit captures verification messages.

## Restricted payout details

There is one current destination per provider account, shared by any provider roles on that account. Each submission creates a version. Full details use AES-256-GCM under a separate `PAYOUT_DATA_KEY`, with account ID and revision as authenticated context. An encrypted value cannot be moved to a different account, revision or mail purpose. The API never returns a full account number, including to administrators. Owners/admins receive only holder, bank, branch and last four digits after authorization. Numbers and passwords do not enter logs or audit payloads.

Submitting/replacing details requires a verified account, the current password and an expected revision. A replacement immediately returns the current destination to pending and preserves previous encrypted versions. Review requires an administrator, recent login, reason, matching revision and no self-review. Concurrent decisions yield one successful decision and one conflict. Review updates the exact destination version and records an audit event; it does not approve the provider identity or initiate a transfer.

`assertReviewedDestination()` locks/checks the current account and requires the exact approved destination revision. Tests prove a replacement invalidates both stale and unreviewed references. P12 must call this inside the financial authorization transaction and enforce its additional KYC, balance, provider-capability and payout rules. No payment executor or existing queued transfer is claimed in P03. The UI therefore reports transfers as disabled even after destination review.

## Audit and operation

Profile changes, submissions and review decisions append actor/target IDs, action, revision and decision reason. The application exposes no audit-update endpoint. This is not a claim of cryptographic tamper evidence against database operators; final audit anchoring/retention belongs to the later evidence/administration phases. Old destination versions remain restricted. Production key rotation, retention, trusted proxy configuration and external bank/provider onboarding remain deployment work.

Setup adds a distinct random payout key without rotating valid existing signing/mail keys. API/worker require three different keys. Example/CI keys are non-production fixtures. Concurrent first Redis connections now share a pending connection so simultaneous initial requests do not fail spuriously; actual Redis outages still fail closed.

## Validation

Seven backend unit tests, three real PostgreSQL/Redis/Mailpit integration scenarios and 166 frontend tests pass. Coverage includes independent providers, revision conflicts, publication snapshots, private/public fields, denied self-review, recent-login requirements, encrypted version history, concurrent reviews, email uniqueness races, expired/reused tokens and password-reset invalidation. Browser checks cover saved contact/profile reload, artist/renter submissions, real keyboard edits to opening hours, unsaved-change protection, masked destinations, administrative queue rendering, dark/light themes and actual CSS widths 375/1440. Browser password/email credential changes and administrative approvals were not automated; their mutations were exercised through the isolated HTTP tests.

See `profiles-validation.json` for verification details. Figma uses editable components/text/SVGs and native reactions, with simulated outcomes rather than database execution.
