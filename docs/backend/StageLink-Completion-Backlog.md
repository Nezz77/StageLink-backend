# StageLink completion backlog

Audit date 13 November 2026. Requirements come from the final proposal, sections 4, 5 and 7, and the interim report, sections 5.11, 6.4–6.8 and 7.6. The [interim report](https://chatgpt.com/library?file_id=libfile_52b19e94cb7c8191abf03766b2de8ca8&account_id=personal) describes initial implementation. This checklist uses local source and test results to establish current status.

## Frontend and backend gaps by module

| Module | What exists | What to complete |
| --- | --- | --- |
| 1. Visitor and customer | Live artist browse and published gig detail with package selection. The demo also has discovery, saved items and reviews. Account, recovery and contact data persist in the backend repository. | Connect the public feed and promotional slots to approved records. Implement real radius, genre, budget and rating filters. Add the event brief form and top-three recommendation results. Persist saved items and allow completed-booking reviews with photos. |
| 2. Artist and talent | Persistent onboarding and reviewed portfolio media. Demo UI for package tiers, audition and calendar. The live artist account now saves gig drafts, base pricing, package tiers, add-ons, performer count and duration, with explicit publication controls. | Connect approved media to gigs, add public catalog search and capture the selected package version in bookings, add AI bio/listing generation and connect the calendar to authoritative booking availability. |
| 3. Renter and equipment | Persistent storefront onboarding, reviewed media and versioned equipment listings with daily LKR rates, stock quantities and technical specs. Public equipment browse shows published versions. Demo UI covers deposit rules, inspections and earnings. | Verify venue and bundle publication against PostgreSQL. Enforce exclusive venue reservations and shared equipment capacity in P08. Connect equipment galleries and listings to approved media. Persist serial custody, maintenance, dispatch, return and inspections. Connect deposits and earnings to settlement data. |
| 4. Booking, chat and payments | Demo screens for booking, messages, quotations, checkout, milestones, documents and the saved archive. | Persist requests and lifecycle transitions, reservation holds, quotes and counteroffers. Add authenticated agreement acceptance and a verifiable SHA-256 digest of accepted terms. Implement authorized Socket.IO rooms, attachments, typing, reads and reconnect. Connect hosted sandbox checkout, webhook handling, refunds, payouts and server-issued documents. |
| 5. Administration and AI | Persistent provider-profile, payout-destination and portfolio reviews. Demo operations and AI panels. | Complete KYC evidence and decisions, case and support chat, dispute settlement and audit evidence, live analytics, promotion and maintenance. Implement FastAPI matchmaking and content generation, and real 24-hour and 2-hour SMS/email scheduling. |

## Backend build order

A checked box marks implemented backend code. PostgreSQL integration, client wiring, and external provider checks are tracked below.

- [x] P00–P04 foundation, accounts, profiles and reviewed media.
- [x] P05 catalog. Versioned gigs and packages, equipment, venues, bundles, rate plans, refundable deposit policies, serialized inventory and rental galleries.
- [x] P06 published feed, scheduled announcements, featured package previews, private event briefs and catalog search by name, price, city, radius, genre, rental type and category.
- [x] P06 minimum-rating filter from published verified booking reviews.
- [x] P07 private saved items, resumable drafts and pre-booking inquiries. Booking submission links an inquiry to the resulting booking.
- [x] P08 provider calendars, blackouts, date-specific stock, booking requests, captured terms and renewable holds.
- [x] P09 provider decisions and calendar/history projections.
- [x] P09 quotation revisions, counteroffers, authenticated acceptance and SHA-256 agreement evidence.
- [x] P10 booking text persistence, retry deduplication, read receipts, and history catch-up.
- [x] P10 private image attachments with validated derivatives, participant-only access, and retention while referenced.
- [ ] P10 Socket.IO delivery, typing, and socket session revocation.
- [x] P11 financial journal foundation. Balanced immutable postings, duplicate command protection, and atomic available-to-reserved fund transfers.
- [x] P11 server-priced advance and deposit orders with participant-only status reads.
- [x] P11 PayHere sandbox hosted checkout and signed notification intake for advances and deposits.
- [x] P11 Stripe test-mode hosted Checkout and signed notification intake for advances and deposits.
- [ ] P11 Verify real PayHere and Stripe sandbox callbacks, confirm Stripe merchant LKR support and Connect eligibility, and reconcile gateway outcomes.
- [x] P12 provider check-in, counterparty overtime decisions, completion reporting and admin verification.
- [x] P12 final balance from the accepted agreement and approved overtime, with sandbox checkout after reported completion.
- [x] P12 cancellation, refund request review and atomic refund fund reservation.
- [x] P12 provider earnings and admin payment views, audited payout holds, and atomic payout reservations against reviewed destinations.
- [ ] P12 Gateway refund and payout execution, reconciliation, and recovery of blocked reservations.
- [x] P13 Sandbox invoice, per-capture receipt and payout reservation statement with private server-rendered PDFs.
- [x] P13 Verified customer reviews, moderated event photos and public rating aggregates.
- [x] P14 Serialized equipment allocation, private dispatch and return reports, correction history, comparison and stock clearance.
- [x] P14 Damage claims, customer responses and admin-reviewed reservation of collected deposits.
- [ ] P13–P14 Production document issuance and gateway execution of deposit refunds and deductions.
- [x] P15 AI service status, revisioned matching weights and persisted usage queries.
- [x] P15 Prompt drafts, placeholder validation, preview, published history and rollback.
- [x] P15 Top-three event-brief artist recommendations using published listings and versioned catalog weights.
- [x] P16 Private provider verification submissions, administrative review and resubmission history.
- [x] P16 Support tickets, member/staff replies, private notes, assignments and reopen history.
- [x] P16 Booking disputes, private evidence, audited dismissal and atomic arbitration reservations.
- [x] P17 Durable 24-hour and 2-hour booking email reminder queue with audited controls.
- [x] P17 In-app notifications, unread counts, read state and email reminder preferences.
- [x] P17 Read-only maintenance mode, public announcement controls, scoped cache invalidation, session revocation and operations audit.
- [ ] P15–P17 AI provider calls and output previews, semantic ranking, verification policy enforcement, realtime notifications, arbitration execution, SMS reminders and promotional campaigns.
- [ ] P18 analytics, security, accessibility, backup and rollback, and end-to-end release verification.

## Verification and client integration

- [ ] Run the new migrations and integration tests with PostgreSQL, Redis, Mailpit and S3Mock. Include concurrent reservations and decisions, expiry, permissions and published-version visibility.
- [ ] Reconcile the team frontend and connect the backend contracts on the frontend branch. Update the corresponding StageLink Figma screens and flows in each UI task.
- [ ] Verify payment sandbox callbacks, reconciliation and two-account booking flows once those endpoints exist.

See [backend-backlog.json](backend-backlog.json) for ticket acceptance criteria and [PROGRESS.md](PROGRESS.md) for implementation details.
