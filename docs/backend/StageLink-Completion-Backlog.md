# StageLink completion backlog

Updated 21 November 2026. Scope comes from the final proposal, sections 4, 5 and 7, and the [interim report](https://chatgpt.com/library?file_id=libfile_52b19e94cb7c8191abf03766b2de8ca8&account_id=personal), sections 5.11, 6.4–6.8 and 7.6.

## Completed backend work

The PayHere recovery build at `52e0102` passed Node and Python tests, API contract checks, and both container builds. [Run 44688362522](https://github.com/Nezz77/StageLink-backend/actions/runs/44688362522).

Full PayHere sandbox arbitration refunds and audited recovery are on `main`. Recovery covers uncertain full card refunds for cancellations, rental deposits and arbitration. It checks fresh payment evidence, settles the original reservation once, and records the administrator and journal. Hosted verification and partial PayHere refunds remain open.

| Area | Implemented |
| --- | --- |
| Accounts and onboarding | Registration, email verification, recovery, role-scoped sessions, provider profiles and approvals, and private media with publication review |
| Marketplace and discovery | Published artist gigs and packages, equipment, venues and bundles, serialized inventory, galleries, deposit policies, filtered search, public feed, saved items, private event briefs, drafts and inquiries |
| Booking and communication | Availability calendars, renewable holds, booking and quote revisions, authenticated agreements, persistent chat and attachments, cross-replica chat signals, completion, and verified reviews |
| Payments and rentals | Sandbox checkout and signed notification handlers, administrator checkout reconciliation and audited recovery, immutable financial journal, refund and payout reservations, approved Stripe test and PayHere sandbox refund execution, sandbox invoices and receipts, inspections, deposit claims and arbitration reservations |
| AI | Weighted top-three recommendations, matching weight and prompt versioning, model usage, private artist writing suggestions, approved-source equipment lookups, versioned gig embeddings, and opt-in semantic reranking |
| Administration and operations | Provider verification history, support, dispute review, in-app notifications, email reminder queues, consent-based email campaigns, announcements, maintenance controls and sandbox analytics |

## Remaining work in order

| Order | Task | Completion criteria |
| --- | --- | --- |
| 1 | Equipment reference catalog, P15 | Review and approve the 12 bundled references on staging, then expand coverage against the rental catalog. |
| 2 | Hosted payment verification, P11–P16 | Verify PayHere and Stripe test callbacks, retrieval and audited recovery with merchant accounts. Confirm Stripe LKR and Connect eligibility. Verify sandbox refunds, transfers, rental deductions and arbitration settlements with the supported routes. |
| 3 | Remaining payment implementation, P12–P16 | Establish exact provider evidence for partial PayHere refunds, then implement supported reconciliation. Complete PayHere deduction, provider payout and fee settlement and manual bank payouts. Issue production documents and report live financial totals after confirming live settlements. |
| 4 | AI and private evidence, P15–P16 | Smoke test hosted models, evaluate ranking against representative listings and event briefs, and verify private PDF access on staging storage. |
| 5 | Hosted communication, P10 and P17 | Verify SMTP and SMS delivery, WebSocket upgrades and reconnect through the hosted proxy. Wire and verify member opt-out controls for promotional SMS. |
| 6 | Frontend and release, all phases | Connect supported workflows in the frontend and update their Figma flows. Run staging end-to-end, access control, accessibility, load, backup restore and rollback checks. |

## Backend build order

A checked box marks implemented backend code. Client wiring and hosted checks have their own entries.

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
- [x] P10 Participant-scoped Socket.IO booking chat across API replicas, including typing signals, read receipts and socket session revocation.
- [x] P10 Staging smoke command for WebSocket upgrade, reconnect, missed-message recovery and resumed delivery.
- [ ] P10 Verify the WebSocket upgrade and reconnect paths on the hosted proxy.
- [x] P11 financial journal foundation. Balanced immutable postings, duplicate command protection, and atomic available-to-reserved fund transfers.
- [x] P11 server-priced advance and deposit orders with participant-only status reads.
- [x] P11 PayHere sandbox hosted checkout and signed notification intake for advances and deposits.
- [x] P11 Stripe test-mode hosted Checkout and signed notification intake for advances and deposits.
- [x] P11 Administrator read-only checkout reconciliation using Stripe test Checkout retrieval and PayHere sandbox Merchant API evidence.
- [x] P11 Verified-administrator recovery for confirmed missing sandbox captures and expired Stripe Checkout sessions. Recovery preserves the audit record and deduplicates later webhooks.
- [x] P11 Read-only Stripe test capability checks for platform LKR and candidate connected destinations.
- [x] P11 Read-only staging payment smoke command for Stripe and PayHere capture reconciliation, LKR and Connect capability evidence, and recorded checkout recovery.
- [ ] P11 Verify real PayHere and Stripe sandbox callbacks, retrieval and audited recovery. Confirm Stripe merchant LKR support and Connect eligibility.
- [x] P12 provider check-in, counterparty overtime decisions, completion reporting and admin verification.
- [x] P12 final balance from the accepted agreement and approved overtime, with sandbox checkout after reported completion.
- [x] P12 cancellation, refund request review and atomic refund fund reservation.
- [x] P12 provider earnings and admin payment views, audited payout holds, and atomic payout reservations against reviewed destinations.
- [x] P12 Execution, reconciliation and journal settlement for approved Stripe test refund items. Failed or uncertain executions retain the reservation for review.
- [x] P12 Full PayHere sandbox refunds for approved cancellation items, with provider confirmation before journal settlement.
- [x] P12–P16 Audited recovery of uncertain full PayHere sandbox card refunds from fresh retrieval evidence, covering cancellation items, rental deposits and arbitration allocations without resubmission.
- [x] P12 Audited Stripe test account links tied to reviewed payout destination revisions.
- [x] P12 Stripe test transfers and reconciliation for eligible payout reservations, with journal posting after provider confirmation.
- [ ] P12 Hosted Stripe and PayHere refund verification and Stripe test transfer verification with a supported LKR route.
- [x] P12 Stripe test transfer reversal accounting credits partial and full reversals to held payout funds during reconciliation.
- [x] P12 Audited repair of stale payout destination revisions before transfer submission, keeping the original reserve and fee.
- [x] P12 Audited Stripe test transfer retry after a confirmed full reversal restores the original reserve.
- [x] P12 Audited Stripe test transfer retry after a confirmed first-submission `balance_insufficient` rejection.
- [x] P12 Signed Stripe test transfer creation and reversal events reconcile existing attempts and recover a lost submission response when Stripe confirms the transfer.
- [x] P12 Read-only Stripe test confirmation of transfer inclusion in a reconciled automatic LKR bank payout, with fresh failure status.
- [x] P12 Stripe test journal and fee settlement for confirmed automatic LKR bank payouts, with compensating entries when the payout fails or the transfer reverses.
- [ ] P12 Manual bank payout execution and investigation of attempts without conclusive Stripe evidence.
- [x] P13 Sandbox invoice, per-capture receipt and payout reservation statement with private server-rendered PDFs.
- [x] P13 Verified customer reviews, moderated event photos and public rating aggregates.
- [x] P14 Serialized equipment allocation, private dispatch and return reports, correction history, comparison and stock clearance.
- [x] P14 Damage claims, customer responses and admin-reviewed reservation of collected deposits.
- [x] P14 Stripe test execution and reconciliation of the approved customer share of a rental deposit.
- [x] P14 PayHere sandbox execution and reconciliation of full rental card deposit refunds for resolved claims with a zero deduction.
- [x] P14 Separate Stripe test payout reservations, transfers, bank settlement and reversal accounting for approved rental deductions.
- [ ] P13 Production document issuance.
- [ ] P14 Hosted rental deposit refund and Stripe deduction payout verification, PayHere partial refund support and evidence, and PayHere deduction settlement.
- [x] P15 AI service status, revisioned matching weights and persisted usage queries.
- [x] P15 Prompt drafts, placeholder validation, preview, published history and rollback.
- [x] P15 Opt-in OpenAI and Gemini administrator previews, with bounded fallback and persisted usage per attempt.
- [x] P15 Private artist biography and gig suggestions with published prompt versions, quotas and replay-safe retrieval.
- [x] P15 Equipment suggestions from approved manufacturer references with citation history and withdrawal.
- [x] P15 Top-three event-brief artist recommendations using published listings and versioned catalog weights.
- [x] P15 Natural-language artist search preview with confirmable catalog filters.
- [x] P15 Administrator indexing and status checks for versioned public gig embeddings.
- [x] P15 Opt-in semantic reranking, weighted fallback, embedding provenance and repeatable synthetic ranking evaluation.
- [x] P15 Offline paired ranking evaluator with graded relevance, fallback counts and snapshot compatibility checks.
- [ ] P15 Live model smoke test and ranking evaluation against a representative catalog and event briefs.
- [x] P15 Manufacturer reference bundle with 12 cited models, administrator preview, digest-based approval and safeguards for duplicate, conflicting and retired entries. [Bundle guide](Equipment-Reference-Bundle.md).
- [ ] P15 Approve the bundled references on staging and expand coverage against the rental catalog.
- [x] P16 Private provider verification submissions, administrative review and resubmission history.
- [x] P16 Role-specific provider identity approval for sandbox payout and arbitration reservations.
- [x] P16 Support tickets, member/staff replies, private notes, assignments and reopen history.
- [x] P16 Booking disputes, private evidence, audited dismissal and atomic arbitration reservations.
- [x] P17 Durable 24-hour and 2-hour booking email reminder queue with audited controls.
- [x] P17 In-app notifications, unread counts, read state and email reminder preferences.
- [x] P17 Account-scoped realtime inbox refresh signals after notification creation or read-state changes.
- [x] P17 Read-only maintenance mode, public announcement controls, scoped cache invalidation, session revocation and operations audit.
- [x] P17 Promotional email opt-in, campaign drafts, verified audience preview, scheduling and cancellation.
- [x] P17 Opt-in promotional email worker, rolling hourly cap, and administrator delivery counts.
- [x] P17 One-click promotional email opt-out from supported mail clients.
- [x] P16 Private verification PDF upload, rendered derivatives, and owner and pending-case administrator access.
- [x] P16 Staging smoke command for private PDF downloads, case-bound administrator access, outsider denial and private response headers.
- [x] P16 Stripe test execution and reconciliation of customer arbitration refunds from saved payment allocations, with participant-visible status.
- [x] P16 Stripe test provider arbitration payouts and associated fees, including destination repair, bank settlement and reversal accounting.
- [x] P16 Stripe test fee settlement for awards with no provider payment, with provider evidence checks, reversal accounting, participant status and analytics.
- [x] P16 PayHere sandbox customer arbitration refunds for full captured card-payment allocations, with reconciliation, shared reserve settlement and participant status.
- [ ] P16 Hosted verification PDF access, hosted arbitration execution verification, partial PayHere refund reconciliation, and PayHere provider payout and fee execution.
- [x] P17 SMS contact foundation: encrypted phone verification, explicit revisioned booking/marketing SMS consent, delivery status/reconciliation and masked history. Provider delivery defaults off.
- [x] P17 Booking SMS reminder scheduling at 24 and 2 hours with current consent checks, a shared hourly send limit, delivery reconciliation and member history.
- [x] P17 Administrator SMS reminder monitoring, real delivery counts and audited cancellation before submission. [Operations guide](SMS-Reminder-Operations.md).
- [x] P17 Consent-based promotional SMS drafts, audience review, revision-bound scheduling, cancellation, shared send cap and delivery counts. [Workflow](Promotional-SMS.md).
- [ ] P17 Live SMTP reminder/campaign verification, hosted SMS verification/reminder/campaign delivery and frontend/Figma controls.
- [x] P18 Administrator and provider analytics from booking records and posted sandbox journals.
- [x] P18 Stripe test and PayHere sandbox refund settlements in administrator and provider analytics, with daily totals.
- [x] P18 Net Stripe test bank payout and platform fee analytics by UTC day and period, scoped by role and inclusive of posted reversals.
- [ ] P18 Live financial totals for supported workflows and release verification for security, accessibility, backup and rollback.

## Verification and client integration

- [x] GitHub CI passed for uncertain PayHere refund recovery and matching database audit evidence at `52e0102`. See [run 44688362522](https://github.com/Nezz77/StageLink-backend/actions/runs/44688362522).

- [x] GitHub CI passed through `78705a3` using PostgreSQL, Redis, Mailpit and S3Mock. See [run 43754928062](https://github.com/Nezz77/StageLink-backend/actions/runs/43754928062).
- [x] Local listing-embedding checks passed with all migrations applied to isolated PGlite, Redis, mocked model calls, 37 Node unit tests and 21 FastAPI tests.
- [x] GitHub CI passed for listing embeddings at `0abecf3`. It applied the migrations twice and passed PostgreSQL, Redis, Mailpit and S3Mock integration, contract regeneration and both container builds. See [run 43807860434](https://github.com/Nezz77/StageLink-backend/actions/runs/43807860434).
- [x] GitHub CI passed for semantic recommendations at `564940c`. See [run 43809837950](https://github.com/Nezz77/StageLink-backend/actions/runs/43809837950).
- [x] GitHub CI passed for sandbox reconciliation at `0d26c4e` and cross-replica chat at `678ec3c`. See [run 43811076875](https://github.com/Nezz77/StageLink-backend/actions/runs/43811076875).
- [x] GitHub CI passed for audited checkout recovery at `e451baa`, including the PostgreSQL journal suite. See [run 43812388181](https://github.com/Nezz77/StageLink-backend/actions/runs/43812388181).
- [x] GitHub CI passed for Stripe test refund execution at `329f025`. See [run 43813265782](https://github.com/Nezz77/StageLink-backend/actions/runs/43813265782).
- [x] GitHub CI passed for sandbox refund analytics at `276b20f` and PayHere sandbox refund execution at `1608785`. See [run 43814251179](https://github.com/Nezz77/StageLink-backend/actions/runs/43814251179).
- [x] GitHub CI passed for private verification PDFs at `85ffe0e`. See [run 43815321146](https://github.com/Nezz77/StageLink-backend/actions/runs/43815321146).
- [x] GitHub CI passed for Stripe test connected-account transfers at `9b06fa1`. See [run 43913024522](https://github.com/Nezz77/StageLink-backend/actions/runs/43913024522).
- [x] GitHub CI passed for Stripe test transfer reversal accounting at `735d69e`. See [run 43914122080](https://github.com/Nezz77/StageLink-backend/actions/runs/43914122080).
- [x] GitHub CI passed for payout destination repair at `6b6817b`. See [run 43925286920](https://github.com/Nezz77/StageLink-backend/actions/runs/43925286920).
- [x] GitHub CI passed for retries after full Stripe test transfer reversals at `b25970b`. See [run 43928323258](https://github.com/Nezz77/StageLink-backend/actions/runs/43928323258).
- [x] GitHub CI passed for confirmed Stripe test balance rejection recovery at `5cd50f4`. See [run 43933131668](https://github.com/Nezz77/StageLink-backend/actions/runs/43933131668).
- [x] GitHub CI passed for signed Stripe test transfer creation and reversal events at `a5f1a97`. See [run 43954240039](https://github.com/Nezz77/StageLink-backend/actions/runs/43954240039).
- [x] GitHub CI passed for Stripe test bank payout inclusion at `d5e43ee`. See [run 44044430909](https://github.com/Nezz77/StageLink-backend/actions/runs/44044430909).
- [x] GitHub CI passed for Stripe test bank payout and fee settlement through `a54fb29`. See [run 44047480446](https://github.com/Nezz77/StageLink-backend/actions/runs/44047480446).
- [x] GitHub CI passed for net sandbox bank payout and fee analytics at `0fa0aac`. See [run 44055209767](https://github.com/Nezz77/StageLink-backend/actions/runs/44055209767).
- [x] GitHub CI passed for Stripe test rental deposit refunds at `b388b88`. See [run 44065258482](https://github.com/Nezz77/StageLink-backend/actions/runs/44065258482).
- [x] GitHub CI passed for full PayHere sandbox rental deposit refunds at `76fbd21`. See [run 44074808321](https://github.com/Nezz77/StageLink-backend/actions/runs/44074808321).
- [x] GitHub CI passed for Stripe test rental deduction payouts at `5326542`. See [run 44569402153](https://github.com/Nezz77/StageLink-backend/actions/runs/44569402153).
- [x] GitHub CI passed for Stripe test customer arbitration refunds through `5db6176`. See [run 44573229698](https://github.com/Nezz77/StageLink-backend/actions/runs/44573229698).
- [x] GitHub CI passed for Stripe test provider arbitration payouts and fees at `84b8c40`. See [run 44576771413](https://github.com/Nezz77/StageLink-backend/actions/runs/44576771413).
- [x] GitHub CI passed for Stripe test fee settlement without a provider payment through `6085ea4`. See [run 44683400682](https://github.com/Nezz77/StageLink-backend/actions/runs/44683400682).
- [x] GitHub CI passed for full PayHere sandbox customer arbitration refunds at `f8114f6`. See [run 44685259243](https://github.com/Nezz77/StageLink-backend/actions/runs/44685259243).
- [ ] Reconcile the [team frontend](https://github.com/Nezz77/StageLink) with the current backend contracts. Update the corresponding StageLink Figma screens and flows during each UI task.
- [ ] Verify hosted model calls, signed sandbox payment callbacks, gateway reconciliation and two-account booking flows in staging.

See [backend-backlog.json](backend-backlog.json) for ticket acceptance criteria and [PROGRESS.md](PROGRESS.md) for implementation details.
