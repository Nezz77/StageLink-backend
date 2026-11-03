# StageLink backend checkpoint

Date: 2026-11-03. Work stays on `backend` in the separate `StageLink-backend` worktree. GitHub's `frontend` branch remains at the original UI commit `9cbbe0ded3112a347c8ba1ffdf7029bd4fde268e`; the original UI checkout remains on its local `main` branch. No merge or deployment is performed.

## Completed

P00: whole-backend plan, 65-ticket backlog, 55-feature coverage inventory, separate branch and baseline validation.

P01: NestJS/Prisma/PostgreSQL API, Redis/BullMQ worker with recoverable transactional outbox, FastAPI health shell, migrations, contracts, Docker and CI. The local API/worker/AI/web images build and all services boot. A committed CLI event produced exactly one worker receipt. The corrected GitHub foundation run [41389043819](https://github.com/Nezz77/StageLink/actions/runs/41389043819) passed all three jobs at `0b41611`.

P02: persistent public account registration, login, assigned-role selection, email verification, password recovery, refresh rotation/replay protection and sign-out. Administrator creation is an operator-only, create-only CLI; ordinary signup cannot request admin. PostgreSQL stores identity, hashed credentials/tokens and revocable sessions. The mail worker delivers transactionally queued, encrypted payloads to a local Mailpit inbox. No external email provider is enabled.

The backend branch now defaults to the real account UI. A newly signed-in account sees its own identity and assigned roles. Sample bookings/balances/messages stay in the explicit demo app; catalog browsing is clearly labeled as a preview. Booking/chat/payment APIs remain to be implemented; profiles and payout metadata are now persistent. Artist/renter account types are not provider approval.

New Figma material is recorded in `figma-auth-mapping.json`: 18 editable design states, 18 monochrome wireframes and 18 prototype states, with 80 native reactions and four named starting flows. Existing frontend journeys are preserved. The prototype simulates outcomes; it does not call the account backend.

P03: current-account contact details, separate confirmed email changes, artist/renter onboarding, approved public snapshots, encrypted and versioned payout destinations, and revision-safe administrator reviews. Provider profile review remains separate from KYC and real payout eligibility. Full bank numbers never enter API responses. See ADR 003 for the exact authorization and versioning boundaries.

P03 Figma adds 15 editable design states, 15 wireframe states and 15 prototype states, with 59 native connections and four starting flows. Field component widths were repaired and final screenshots inspected. The mapping in `figma-profile-mapping.json` records the actual final nodes; these prototypes simulate outcomes.

## Validation

See `foundation-validation.json` for P01 and `auth-validation.json` for P02. Local P02 checks passed: six backend unit tests, two real dependency integration scenarios, 163 frontend tests, both TypeScript checks, generated contracts, website/API/worker/AI container builds and healthy Compose boot. Runtime backend dependencies have zero audit findings; three moderate development-only findings remain in the OpenAPI generator dependency chain, as documented in ADR 001.

Integration verifies two independent accounts, attempted privilege escalation, token expiry/single use, actual SMTP capture, refresh replay revocation, real password replacement, revoked sessions and controlled admin bootstrap. It also retains the existing outbox recovery/restart tests. Browser QA verifies sign-in/reload, role persistence, sign-out, incorrect-password feedback, recovery email feedback, responsive account layouts at actual CSS widths 312/375/1440, and dark/light themes. Credential mutation is verified through HTTP integration rather than automated browser password entry.

Figma structural checks found editable text/components/SVGs, Geist/Fraunces fonts, no flattened image fills, and no broken prototype destinations. Screenshots were inspected for account, sign-in and wireframe views. Design mapping and local browser evidence are committed with this checkpoint.

P03 local checks passed: seven backend unit tests, three real dependency integration scenarios, 166 frontend tests, both TypeScript checks, regenerated contracts, API/worker/web builds and healthy Compose services. Browser checks cover saved contact reload, provider submissions, keyboard-edited opening hours, account separation, unsaved guards, masked payout details, admin queue rendering, light/dark themes and CSS widths 375/1440. Sensitive mutations were tested through isolated HTTP integration, not automated browser credential entry or approval clicks. Disposable QA accounts were removed after verification. See `profiles-validation.json`.

P03 implementation is committed separately before beginning P04. The GitHub Actions history for the backend branch records remote results. No deployment is performed.

P02 remote CI is recorded in `auth-validation.json`; local completion is separate from remote verification. No production readiness or deployment is claimed.

## Next phase

P04: durable private media uploads, processing, portfolio and allowlisted embeds. Connect future listing/evidence ownership when their business phases land. Follow the remaining phases in `backend-backlog.json` as each preview feature is converted.

P10/BE-041 explicitly retains the socket-security follow-through: authenticate socket connections/messages using persisted sessions and disconnect revoked sessions. There are no sockets to disconnect in P02. Provider approvals, hosted SMTP, payment/model providers, final retention/security/load checks and deployment remain later work.
