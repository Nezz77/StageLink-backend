# StageLink completion backlog

Audit date 13 November 2026. Requirements come from the final proposal, sections 4, 5 and 7, and the interim report, sections 5.11, 6.4–6.8 and 7.6. The [interim report](https://chatgpt.com/library?file_id=libfile_52b19e94cb7c8191abf03766b2de8ca8&account_id=personal) describes initial implementation. This checklist uses local source and test results to establish current status.

## Frontend and backend gaps by module

| Module | What exists | What to complete |
| --- | --- | --- |
| 1. Visitor and customer | Landing, discovery and detail previews, saved items and reviews in demo workflows. Account, recovery and contact data persist on the backend branch. | Connect the public feed and promotional slots to approved records. Implement real radius, genre, budget and rating filters. Add the event brief form and top-three recommendation results. Persist saved items and allow completed-booking reviews with photos. |
| 2. Artist and talent | Persistent onboarding and reviewed portfolio media. Demo UI for package tiers, audition and calendar. The live artist account now saves gig drafts, base pricing, package tiers, add-ons, performer count and duration, with explicit publication controls. | Connect approved media to gigs, wire public gig pages, package selection and search, capture the selected package version in bookings, add AI bio/listing generation and connect the calendar to authoritative booking availability. |
| 3. Renter and equipment | Persistent storefront onboarding and reviewed media. Demo UI for equipment specs, stock, deposit rules, inspections and earnings. | Complete venue capacity and exclusivity, bundles and hourly/daily/weekly rates. Connect equipment galleries and listings to approved media. Persist serial custody, maintenance, dispatch, return and inspections. Connect deposits and earnings to settlement data. |
| 4. Booking, chat and payments | Demo screens for booking, messages, quotations, checkout, milestones, documents and the saved archive. | Persist requests and lifecycle transitions, reservation holds, quotes and counteroffers. Add authenticated agreement acceptance and a verifiable SHA-256 digest of accepted terms. Implement authorized Socket.IO rooms, attachments, typing, reads and reconnect. Connect hosted sandbox checkout, webhook handling, refunds, payouts and server-issued documents. |
| 5. Administration and AI | Persistent provider-profile, payout-destination and portfolio reviews. Demo operations and AI panels. | Complete KYC evidence and decisions, case and support chat, dispute settlement and audit evidence, live analytics, promotion and maintenance. Implement FastAPI matchmaking and content generation, and real 24-hour and 2-hour SMS/email scheduling. |

## Work order

- [ ] Reconcile the team frontend at local `ddc2f25` with the validated backend baseline. Fix missing package/arbitration modules and incompatible booking and calendar types before merging team changes. Under the available toolchain, the team frontend typecheck failed and 28 of 115 tests failed.
- [ ] Record the architecture decision for the frontend. The proposal and report describe Next.js/SSR. Both inspected checkouts use React/Vite.
- [ ] P05 catalog. Verify the new artist-gig migration with PostgreSQL. Verify the package migration and publication flow. Finish public catalog pages and package selection, then persistent rentals, venues, deposit rules, inventory and listing media.
- [ ] P06–P07 discovery and customer actions. Deliver live browse and search, event briefs, saved items, drafts and inquiries.
- [ ] P08–P10 booking and negotiation. Deliver availability and atomic reservations, request decisions, immutable quotes and agreement evidence, then durable Socket.IO messaging.
- [ ] P11–P14 payment and completion. Implement financial journal and PayHere/Stripe sandbox callbacks, refunds and reconciliation, settlements, documents, verified reviews, inspection evidence and rental deposits.
- [ ] P15–P17 AI and administration. Integrate matchmaking and generated content, KYC, support and disputes, delivery/reminders, and system controls.
- [ ] P18 release. Replace sample analytics, verify empty states and per-account data isolation, exercise booking/stock races and payment retries, and run accessibility, browser, security, backup and rollback checks.

See [backend-backlog.json](backend-backlog.json) for ticket-level acceptance criteria and [UI-Backend-Coverage.csv](UI-Backend-Coverage.csv) for source mappings. P05 is in progress in this checkout. The gig lifecycle uses immutable content revisions and a published-version pointer. Saving edits to a published gig leaves its public version visible until the owner republishes. The status API handles publish, pause and archive in one command endpoint. A verified, approved artist profile is required to publish. Public marketplace browsing still uses previews.
