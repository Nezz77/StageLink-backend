# StageLink backend checkpoint

Date: 2026-11-03. Work stays on `backend` in the separate `StageLink-backend` worktree. GitHub's `frontend` branch remains at the original UI commit `9cbbe0ded3112a347c8ba1ffdf7029bd4fde268e`; the original UI checkout remains on its local `main` branch. No merge or deployment is performed.

## Completed

P00: whole-backend plan, 65-ticket backlog, 55-feature coverage inventory, separate branch and baseline validation.

P01: NestJS/Prisma/PostgreSQL API, Redis/BullMQ worker with recoverable transactional outbox, FastAPI health shell, migrations, contracts, Docker and CI. The local API/worker/AI/web images build and all services boot. A committed CLI event produced exactly one worker receipt. The corrected GitHub foundation run [41389043819](https://github.com/Nezz77/StageLink/actions/runs/41389043819) passed all three jobs at `0b41611`.

P02: persistent public account registration, login, assigned-role selection, email verification, password recovery, refresh rotation/replay protection and sign-out. Administrator creation is an operator-only, create-only CLI; ordinary signup cannot request admin. PostgreSQL stores identity, hashed credentials/tokens and revocable sessions. The mail worker delivers transactionally queued, encrypted payloads to a local Mailpit inbox. No external email provider is enabled.

The account API serves authenticated account data and assigned roles. A newly signed-in account sees its own identity and assigned roles. Sample bookings/balances/messages stay in the explicit demo app; catalog browsing is clearly labeled as a preview. Booking/chat/payment APIs remain to be implemented; profiles and payout metadata are now persistent. Artist/renter account types are not provider approval.


P03: current-account contact details, separate confirmed email changes, artist/renter onboarding, approved public snapshots, encrypted and versioned payout destinations, and revision-safe administrator reviews. Provider profile review remains separate from KYC and real payout eligibility. Full bank numbers never enter API responses. See ADR 003 for the exact authorization and versioning boundaries.


P04: durable private media library, profile-photo binding, real image/audio/video validation and derivatives, artist/renter portfolios, allowlisted video embeds, publication review and expiring read capabilities. PostgreSQL owns processing/lease/revision state; bytes use the S3 adapter with a persistent local development emulator. Future business modules will attach files under their own authorization. PDF/archive/SVG uploads remain unsupported. Live AWS is not configured or verified.


## Validation

See `foundation-validation.json` for P01 and `auth-validation.json` for P02. Local P02 checks passed: six backend unit tests, two real dependency integration scenarios, 163 frontend tests, both TypeScript checks, generated contracts, website/API/worker/AI container builds and healthy Compose boot. Runtime backend dependencies have zero audit findings; three moderate development-only findings remain in the OpenAPI generator dependency chain, as documented in ADR 001.

Integration verifies two independent accounts, attempted privilege escalation, token expiry/single use, actual SMTP capture, refresh replay revocation, real password replacement, revoked sessions and controlled admin bootstrap. It also retains the existing outbox recovery/restart tests. Browser QA verifies sign-in/reload, role persistence, sign-out, incorrect-password feedback, recovery email feedback, responsive account layouts at actual CSS widths 312/375/1440, and dark/light themes. Credential mutation is verified through HTTP integration rather than automated browser password entry.


P03 local checks passed: seven backend unit tests, three real dependency integration scenarios, 166 frontend tests, both TypeScript checks, regenerated contracts, API/worker/web builds and healthy Compose services. Browser checks cover saved contact reload, provider submissions, keyboard-edited opening hours, account separation, unsaved guards, masked payout details, admin queue rendering, light/dark themes and CSS widths 375/1440. Sensitive mutations were tested through isolated HTTP integration, not automated browser credential entry or approval clicks. Disposable QA accounts were removed after verification. See `profiles-validation.json`.

P03 implementation was committed separately before P04. Its remote run 41556410593 passed all three jobs at 06ed822. The GitHub Actions history for the backend branch records remote results. No deployment is performed.

P04 local validation passed: nine backend unit tests, four real dependency integration scenarios, 168 frontend tests, both TypeScript checks and generated contracts. Real browser checks covered account separation, stored image loading, measured 30-second audio playback, avatar loading, portfolio save/submission/reload, unsaved mobile edits, review queue/forms, light/dark themes and CSS widths 375/1440. Browser approval and upload-file entry were not automated; binary upload/approval are covered by real HTTP integration. Runtime dependency audit remains zero. See `media-validation.json` for the final runtime/remote handoff.

P02 remote CI is recorded in `auth-validation.json`; local completion is separate from remote verification. No production readiness or deployment is claimed.

## Current phase

P05 started on 13 November 2026. **Manage gigs** now connects the artist account to persistent gig drafts, revisions, publishing, pausing and archiving. Public gig detail reads the explicitly published version. API-mode artist browse now reads published gigs and approved artist profile summaries. The gig detail shows the published package revision and lets visitors compare tiers and add-ons in LKR. Artists can save Standard, Deluxe and VIP tiers with duration, performer count, LKR prices and add-ons. Packages are stored with the gig revision and become public when that revision is published. PostgreSQL and HTTP integration verification, persisted booking snapshots, inventory, and listing media remain open. See the [completion backlog](StageLink-Completion-Backlog.md).

P10/BE-041 explicitly retains the socket-security follow-through: authenticate socket connections/messages using persisted sessions and disconnect revoked sessions. There are no sockets to disconnect in P02. Provider approvals, hosted SMTP, payment/model providers, final retention/security/load checks and deployment remain later work.

BE-029 equipment listings are implemented in API mode. Renters can manage drafts with a daily LKR rate, stock quantity and optional technical specs, then publish through an approved storefront. Public equipment browse reads published versions. Stock quantity records catalog capacity. Date-specific stock availability and reservations are scheduled in P08. TypeScript, Prisma schema, frontend build and frontend tests passed. Database integration was blocked by the unavailable Docker daemon.

BE-030 extends the existing rental API with venue and bundle types. Venue listings store guest capacity and represent one exclusive space. Bundles reference versioned published equipment owned by the same renter. Publishing a changed component revision or taking it offline pauses dependent bundles. Daily rates remain required, with optional hourly and weekly rates. The public estimator multiplies one selected rate by the number of whole periods. Reservation overlap enforcement and booking price snapshots follow in the booking phases.

The backend branch now contains server code, database migrations, API contracts, backend documentation, and backend infrastructure. The combined integration snapshot is preserved locally at `frontend-integration`.

BE-032 adds versioned refundable deposit policies through `PUT /api/v1/me/rentals/:id/deposit-policy`. The owner supplies the current listing revision and chooses none, a fixed LKR amount in minor units, or basis points of the rental subtotal. Fixed and percentage policies require refund terms. Owner reads return draft policy and public reads return published policy. Existing listings default to no deposit. Booking snapshots, collection, and settlement follow in the booking and payment phases.

BE-034 adds a renter-owned serial registry, overdue custody tracking, return inspection, maintenance, quarantine and retirement. Every status change appends a movement in the same transaction. Concurrent dispatch attempts for a single serial serialize under the owner lock and require the current revision. Date-specific reservation capacity and booking-linked dispatch remain in P08 and P14.

BE-065 adds rental gallery endpoints. Renters can link, caption, reorder and detach their reviewed equipment photos and videos. Public galleries require a published listing and current media approval. The response includes the portfolio item ID used by the existing public media access endpoint. Detaching a gallery item leaves its source asset and retention records intact.

BE-011 adds a public feed of approved, published gigs and rentals, live listing counts, and scheduled announcements. The API excludes unpublished, future and expired announcements. Announcement authoring and campaign delivery remain in P17.

BE-022 adds private customer event briefs with a date, city, LKR budget and typed artist, equipment or venue requirements. Customers can create, list, read, update and delete their own briefs. Revision checks protect edits and deletion. Briefs can be used as input for later recommendations and inquiries.

BE-012 adds cursor-paginated discovery by listing or provider name, city, advertised LKR price, artist genre, rental category or type, and distance from an input coordinate. Distance uses approximate coordinates saved with the last approved provider revision. API responses omit coordinates. Rating filters depend on verified review data in P13.

BE-063 adds featured package previews derived from published gig versions with configured package tiers. It returns the same LKR pricing and artist summary as the published gig and has an empty result when no listings qualify.

BE-020 adds an owner-scoped archive for saved artists, gigs and rentals, with category filters and cursor pagination. Repeated saves deduplicate. An unpublished or archived target remains removable without exposing its private title or details.

BE-021 adds private, revision-checked drafts for event briefs and message text. The API accepts typed fields and caps draft count per account. Event brief submission can consume the exact draft in the same database transaction. Message-draft consumption follows with inquiry and chat submission.

BE-040 persists member-only inquiries and text replies with idempotent request keys and optional message-draft consumption. A thread records its published listing version at creation and remains readable to its members after a listing is archived. Linking the inquiry to a booking follows with booking submission.

BE-028 adds provider-wide recurring hours and blackout periods with IANA timezone, overlap checks and optimistic revision checks. Public reads require an approved provider and show time windows without blackout reasons. Booking and stock holds will use this calendar in P08.

BE-033 and BE-037 add booking request submission, member-only reads, inquiry conversion, and date-specific availability and 15-minute holds. An expired hold stops consuming capacity immediately. Renewals recheck publication, calendar and stock. Artist slots share provider capacity, venues reserve one space, and bundles share the inventory of their component listings. The booking record keeps the submitted package, selected add-ons, rates, deposit policy and calculated amount. Provider decisions, confirmed reservations and payment handling remain in later phases.

BE-038 adds provider acceptance and rejection, booking history filters, and a provider calendar projection. Accepting requires the assigned verified provider, the current booking revision, and a live, revalidated reservation. Acceptance extends the negotiation hold for up to 24 hours, bounded by the booking start. Rejected bookings release capacity immediately.
