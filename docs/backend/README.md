# StageLink backend

Submit backend changes on a separate branch and open a pull request into `main` in [Nezz77/StageLink-backend](https://github.com/Nezz77/StageLink-backend). The frontend repository is [Nezz77/StageLink](https://github.com/Nezz77/StageLink). See the [implementation plan](StageLink-Backend-Implementation-Plan.md), [completion checklist](StageLink-Completion-Backlog.md), [ticket acceptance criteria](backend-backlog.json), [UI coverage](UI-Backend-Coverage.csv), and [build history](PROGRESS.md).

## Verified build

The 28 November 2026 build at `b5abf9a` includes persistent accounts, marketplace listings, bookings and quotes, chat and support, rental inspections, private PDFs, sandbox payment reconciliation, and AI suggestions and ranking. GitHub CI passed 90 Node unit tests, 44 integration tests, 21 Python tests, the PostgreSQL restore drill, contract validation, and both container builds. **116 of 127 backend build checklist items are complete (91.3%)**. Use the checklist for the remaining payment implementation, hosted verification, client integration, and release gates. [GitHub build](https://github.com/Nezz77/StageLink-backend/actions/runs/46133760621) · [Completion checklist](StageLink-Completion-Backlog.md)

## Start locally

Use Node 24.22.1 and Docker. From the repository root:

```sh
node backend/scripts/setup-env.mjs
docker compose --env-file infra/.env -f infra/compose.backend.yml up --build -d --wait
```

Setup creates ignored configuration files with separate random signing, mail-encryption and payout-encryption keys. It fills missing settings and preserves valid existing keys and custom values. Do not copy an example over an existing `.env`. If setup reports mismatched existing keys, align the intended configuration explicitly; it does not rotate them silently. Database passwords in these defaults are for this loopback development stack only.

- API docs: [localhost:4000/api/docs](http://localhost:4000/api/docs).
- Local verification/recovery inbox: [127.0.0.1:8025](http://127.0.0.1:8025). Mailpit captures mail locally; it does not deliver to external inboxes.
- API health: [localhost:4000/api/v1/health/ready](http://localhost:4000/api/v1/health/ready).

Host ports bind loopback: API 4000, PostgreSQL 55432, Redis 56379, Mailpit 8025/1025, and S3Mock 59090. AI has no public port. Migrations must succeed before API/worker start. No accounts or business records are seeded automatically.

When connecting a separately running web client, set `WEB_ORIGIN` to its exact origin. Browser mutations enforce this origin. Credentialed responses expose only `Content-Disposition` and `X-Request-ID` in addition to the browser default headers, so the allowed client can read private download filenames and display server error references. This does not make download URLs public or permit other web origins. Verification and recovery messages are available in Mailpit.

Stop while retaining database/Redis volumes:

```sh
docker compose --env-file infra/.env -f infra/compose.backend.yml down
```

This is a local development configuration, not a production deployment.

## Host development

Use npm from the backend directory:

```sh
node backend/scripts/setup-env.mjs
docker compose --env-file infra/.env -f infra/compose.backend.yml up -d postgres redis mailpit storage
cd backend
npm ci
npm run db:generate
set -a
. ./.env
set +a
npm run db:migrate
npm run dev:api
# In another terminal with the same environment: npm run dev:worker
```

Docker reads `infra/.env`. Host processes use the explicitly loaded `backend/.env`. Use matching signing and encryption keys when switching between host and container processes.

## Validation

```sh
cd backend
npm run db:generate
npm run typecheck
npm test
npm run contracts
cd ..
sh backend/scripts/check-integration.sh
```

Integration uses a separate Compose project, `stagelink_test`, PostgreSQL 55433, Redis 56380 and Mailpit 11025/18025. Tests reject non-test database names and remove only their own rows/jobs/Redis namespace. They do not truncate shared tables or flush Redis. Coverage includes migrations, outages, worker restart and duplicate delivery; accounts also test separate users, privilege rejection, rotation/replay, actual SMTP capture, single-use/expired tokens, password replacement and session revocation.

The HTTP tests listen on a temporary loopback port.

The integration script and CI run a PostgreSQL backup and restore drill after the suites finish. The drill archives the migrated test database, restores it in one transaction into a fresh database, and compares table row counts and checksums, sequence state, constraints and indexes. It removes the temporary database and archive on exit. To repeat it with the test stack idle, run from the repository root:

```sh
docker compose -f infra/compose.test.yml exec -T postgres bash -s < backend/scripts/check-postgres-restore.sh
```

The drill covers PostgreSQL data and schema in the test environment. Hosted backup verification also needs an isolated restore of the hosted database, private media objects and access to the matching encryption keys. [PostgreSQL backup documentation](https://www.postgresql.org/docs/17/backup-dump.html)

### Check readiness after deployment or rollback

Run the check from the built backend release you expect to be serving. Set `STAGELINK_RELEASE_API_ORIGIN` and `STAGELINK_RELEASE_WORKER_ORIGIN` to the two service origins. Use the worker’s internal address. From the backend package, run `npm run --silent release:check`.

The check requires both readiness endpoints to report PostgreSQL and Redis available, the worker dispatcher to be active, and both schema versions to match the migration bundled with this build. After a rollback, run it from the restored release after starting the API and worker against the matching database schema. The check exits nonzero when either service fails and makes no changes to the database.

Generated contracts are `contracts/openapi.json` → `packages/contracts/src/api.d.ts`. Regenerate and commit both after endpoint changes; CI rejects drift. Never edit an applied migration.

The build embeds the latest bundled Prisma migration in the API and worker. Their readiness endpoints return 503 if PostgreSQL has a different latest completed migration or an unfinished migration entry. Rolled-back entries are ignored. The normal local API and worker start commands regenerate the expected version from the checkout.

The worker checks its bundled migration version before beginning a background scan or handling an outbox job. An unavailable database, a schema mismatch, or an unfinished migration defers work. Already queued jobs retry after a delay without using a delivery attempt and resume once the matching schema is available. Stop the deployed workers before applying or restoring migrations so work already in flight can finish.

The internal FastAPI service provides health checks, opt-in prompt previews, artist bio and gig draft generation, and public gig embeddings. Run its tests under `backend/ai` with Python 3.12 and uv 0.11.29 using `uv sync --frozen`, then `uv run --frozen pytest -q`. Provider calls require explicit configuration. See [prompt model previews](#prompt-model-previews) and [semantic recommendations](#semantic-recommendations).

## Controlled administrator creation

There is no public administrator signup or default password. With database configuration loaded, an operator can create a new administrator using the compiled CLI. Pipe a 12–128 character password from a protected source, such as an approved password manager's stdout, into:

```sh
npm run --silent admin:create -- --email administrator@example.com --name 'StageLink Administrator'
```

The command refuses terminal password input and refuses to overwrite any account. It prints only the new user ID. Replace the example address with the intended administrator. Setup/tests create no real administrator. Provider approval and admin-management screens remain separate backlog work.

## Profiles and onboarding

Authenticated clients use the `/api/v1/me` routes to manage profile data, submit artist or renter applications, and manage payout destinations. The administrator routes accept and reject submissions. Public snapshots omit contact details and exact coordinates. See [ADR 003](ADR-003-profiles.md) for authorization and versioning.

## Persistent media (P04)

Authenticated media routes provide uploads and private asset access. The worker validates uploads and builds derivatives. Portfolio items require administrator review and an approved provider profile before public access.

The local Compose stack includes persistent S3Mock on loopback port 59090 (test: 59091). Host configuration uses `MEDIA_DRIVER=local-s3`, `S3_BUCKET=stagelink-media`, `S3_REGION=us-east-1` and `S3_ENDPOINT=http://127.0.0.1:59090`. Production must use `MEDIA_DRIVER=aws`, the intended private bucket/region and the AWS credential chain; do not use the emulator for real hosted evidence. Live AWS has not been configured/tested. Host workers and tests use FFmpeg/FFprobe and Poppler’s `pdfinfo` and `pdftoppm`. Linux workers also use `prlimit` for PDF processing bounds. The backend image and CI include those dependencies.

Images: JPEG/PNG/WebP ≤8 MiB and 16 MP. Artist audio: MP3/WAV ≤20 MiB. Artist video: MP4/WebM ≤40 MiB. Audio/video ≤10 minutes, with actual previews up to 30 seconds. The verification upload purpose also accepts private PDFs up to 5 MiB and eight pages. SVG, archives and executables are rejected. See [ADR 004](ADR-004-media.md) for processing, retention, capability and future business-reference boundaries.

## PayHere sandbox

Set `PAYHERE_SANDBOX_MERCHANT_ID`, `PAYHERE_SANDBOX_MERCHANT_SECRET`, and `PAYHERE_SANDBOX_NOTIFY_URL` together. Use the sandbox merchant details and a publicly reachable HTTPS endpoint at `/api/v1/payments/webhooks/payhere`. With all three settings empty, checkout is disabled.

The booking customer creates an advance or deposit order and requests a hosted checkout session. Submit the returned fields to its sandbox action URL. After returning, fetch the payment order to see the state recorded from the verified callback. PostgreSQL time governs order and checkout deadlines. A successful PayHere callback processed after expiry records the funds for review. Expired or ambiguous outcomes require reconciliation before a new attempt. Balance collection opens after the provider reports completion. See the [PayHere Checkout API](https://support.payhere.lk/api-%26-mobile-sdk/checkout-api).

## Stripe test Checkout

Set `STRIPE_TEST_SECRET_KEY` and `STRIPE_TEST_WEBHOOK_SECRET` together to enable Stripe test Checkout. Configure the test webhook endpoint at `/api/v1/payments/webhooks/stripe` for `checkout.session.completed`, `checkout.session.expired`, `checkout.session.async_payment_succeeded`, and `checkout.session.async_payment_failed`. Enable `transfer.created` and `transfer.reversed` from the platform account on the same endpoint to reconcile Stripe test payout transfers. Use a public HTTPS endpoint for delivery from Stripe. See [Stripe webhooks](https://docs.stripe.com/webhooks).

The booking customer sends `{}` to `POST /api/v1/payment-orders/:id/sessions/stripe` for an eligible advance, deposit or balance order and opens the returned URL. Advance and deposit sessions require more than 30 minutes before the booking starts. StageLink uses PostgreSQL time to check eligibility before and after the Stripe request. Fetch the payment order after returning for the state recorded by the webhook. Each order stays with the first gateway selected. Expired or ambiguous attempts require reconciliation before replacement. Test account LKR support, actual webhook delivery and Connect settlement still need verification. [Stripe Checkout Session creation](https://docs.stripe.com/api/checkout/sessions/create)

## Sandbox payment reconciliation

A verified administrator can call `GET /api/v1/admin/payment-orders/:id/reconciliation` to compare the current StageLink capture record with gateway evidence. The response reports the gateway status and whether the evidence agrees, needs review or is inconclusive. Missing captures, mismatched amounts and duplicate or reversed PayHere payments need review. The check is read-only. Replaying a verified notification follows the existing webhook path.

Stripe uses the existing test key to retrieve the stored Checkout Session. PayHere requires `PAYHERE_SANDBOX_RETRIEVAL_APP_ID` and `PAYHERE_SANDBOX_RETRIEVAL_APP_SECRET` from the sandbox Merchant API settings. StageLink uses those credentials for a short-lived sandbox token. A missing PayHere retrieval result is inconclusive. [Stripe Checkout Session retrieval](https://docs.stripe.com/api/checkout/sessions/retrieve) · [PayHere Retrieval API](https://support.payhere.lk/api-%26-mobile-sdk/retrieval-api)

For a confirmed missing capture, a verified administrator submits `{requestKey, expectedOutcome: "captured", reason}` to `POST /api/v1/admin/payment-orders/:id/reconciliation/recover` with the standard origin and CSRF headers. StageLink retrieves fresh gateway evidence, checks the amount, currency and attempt reference, then records the capture in the sandbox review balance. The action records the administrator, evidence time, reason, and journal transaction. Verified Stripe expiration also supports `expectedOutcome: "expired"` for a pending order. Repeat the original request key to retrieve the saved action. Review recorded actions using `GET /api/v1/admin/payment-orders/:id/reconciliation/recoveries`. Inconclusive, duplicate, mismatched and reversed evidence requires manual review.

Run `npm run build` from `backend/`, then run `npm run --silent payments:smoke` with a verified staging administrator's access token piped through stdin. Supply these environment variables before running the command.

| Setting | Value |
| --- | --- |
| `STAGELINK_SMOKE_ORIGIN` | HTTPS origin of the staging API, such as `https://staging-api.example.com` |
| `STAGELINK_SMOKE_STRIPE_ORDER_ID` | ID of a paid Stripe test order with a recorded capture |
| `STAGELINK_SMOKE_PAYHERE_ORDER_ID` | ID of a paid PayHere sandbox order with a recorded capture |
| `STAGELINK_SMOKE_STRIPE_ACCOUNT_ID` | Candidate Stripe test connected account ID |
| `STAGELINK_SMOKE_RECOVERY_ORDER_ID` | Optional ID of a separate sandbox order with an audited capture recovery |
| `STAGELINK_SMOKE_PAYHERE_REFUND_EXECUTION_ID` | Optional ID of a PayHere sandbox full refund execution with a recorded recovery |
| `STAGELINK_SMOKE_PAYHERE_REFUND_AMOUNT_MINOR` | Expected positive integer refund amount in minor LKR units, required with the refund execution ID |
| `STAGELINK_SMOKE_STRIPE_PAYOUT_ORDER_ID` | Optional StageLink payout order ID with a recorded Stripe test bank settlement |
| `STAGELINK_SMOKE_STRIPE_BANK_PAYOUT_ID` | Stripe bank payout ID beginning with `po_`, required with the StageLink payout order ID |

The command reads API readiness, checks both payment orders against fresh provider evidence, and reports the Stripe platform and connected account capabilities relevant to LKR. It reports available LKR balance as a boolean. The optional checkout recovery fixture verifies a recorded capture recovery with a journal.

The optional PayHere refund fixture checks the recorded recovery against the expected execution and amount. The Stripe bank payout fixture compares fresh paid payout evidence with the stored settlement for the same transfer and balance transaction. A missing or reversed journal needs review. Prepare the sandbox transactions and recoveries in staging before running these checks. The command makes GET requests only and reports sanitized results without credentials, IDs, amounts or response bodies. Any requested check that fails or needs review produces a nonzero exit status.


## Date-specific equipment availability

Use `GET /api/v1/listings/:id/availability` with the published listing version, date range, requested quantity and rate unit. For standalone equipment with a bookable calendar window, the response includes `stock.totalUnits`, `stock.reservedUnits` and `stock.availableUnits`. Total units reflect the published stock limit and available registered units when the listing tracks serials. Reserved units reflect peak overlapping active holds and agreements, including demand from bundles that use the same equipment. Availability compares the requested quantity against the remaining stock for the entire interval.

Calendar closures and other listing types return the existing `available` flag. Refresh the counts when the date range changes. The booking request still checks capacity inside the provider lock.

## Booking completion

Booking hold creation, renewal, and expiry use the PostgreSQL clock. Booking and quotation status use that same clock. Writes sample it after acquiring the booking participants' locks so the timestamp reflects any wait for another request.

Adding a provider blackout through `POST /api/v1/me/availability/blocks` returns `409 BLACKOUT_BOOKING_CONFLICT` when the selected time overlaps an agreed booking or an accepted request with an active hold. A blackout and a booking decision use the same provider lock. An expired negotiation hold leaves the interval eligible for blocking. A blackout can begin exactly when a booking ends. Blackout reasons appear only in the provider's private calendar.

Booking participants can read `GET /api/v1/bookings/:id/journey`. The provider submits `{"confirmed":true}` to the booking's `check-ins` route during its scheduled window and to its `completion` route after the scheduled and approved overtime end. Both require a paid advance. A check-in records the provider's manual confirmation. Either gig participant can propose overtime after check-in, and the other participant must resolve the proposal before completion.

After the completion report, the customer can open a balance payment order for the original price plus approved overtime less the paid advance. A separate admin verification records the reviewer, time and reason. Completion and verification leave settlement to the payout workflow.

## Cancellations and refund review

The customer can cancel an unpaid upcoming booking using `POST /api/v1/bookings/:id/cancellations` or request a refund review for captured funds using `POST /api/v1/bookings/:id/refund-requests`. Both take a reason. Administrators review pending requests at `GET /api/v1/admin/refund-requests` and submit a decision and reason to `POST /api/v1/admin/refund-requests/:id/decisions`. Approval reserves sandbox funds by payment and remains pending gateway execution. A gateway-confirmed refund is required to close a paid booking through this flow.

## Stripe test refund execution

Enable `STRIPE_TEST_REFUND_EXECUTION=true` with the Stripe test settings. The feature is off by default. A verified administrator with a recent sign-in can send `{}` to `POST /api/v1/admin/refund-requests/:id/items/:orderId/stripe-execution` with the standard origin and CSRF headers. StageLink uses the approved LKR amount from the reservation and the PaymentIntent from the matching paid test Checkout Session. It posts a settlement only after Stripe confirms the exact refund. The existing refund view includes the last Stripe execution status for each item.

Use `GET` on the execution path to read local state. Repeat the `POST` to reconcile a pending or uncertain execution by Stripe refund ID or metadata. StageLink reuses the original execution reference. It checks the 30-second submission lease and the 23-hour replay window with PostgreSQL time immediately before sending a refund. After the replay window closes, older attempts can still reconcile from provider evidence. Uncertain and terminal failed executions keep the reservation for review. [Stripe refund API](https://docs.stripe.com/api/refunds/create) · [Stripe idempotent requests](https://docs.stripe.com/api/idempotent_requests)

For a resolved rental damage claim with a captured Stripe test deposit, use `POST /api/v1/admin/damage-claims/:id/stripe-refund` with the same `{}` body and administrator checks. StageLink submits the approved customer amount, including a partial refund when the claim includes a deduction. A confirmed refund settles the customer's reserve. Any provider deduction stays reserved. Use `GET` on the same path to check execution, and repeat `POST` to reconcile a pending or uncertain refund. Booking participants can read the recorded `stripeRefundState` at `GET /api/v1/bookings/:id/damage-claim`.

## PayHere sandbox refund execution

Enable `PAYHERE_SANDBOX_REFUND_EXECUTION=true` with the sandbox Merchant API credentials. A verified administrator with a recent sign-in sends `{}` to `POST /api/v1/admin/refund-requests/:id/items/:orderId/payhere-execution` with the standard origin and CSRF headers. StageLink ties the reserved amount to one captured PayHere payment with fresh retrieval evidence and submits a full refund. Successful submission records the provider refund number and leaves the reservation pending. Repeat the `POST` to reconcile it. A confirmed refunded payment consumes the reservation once and posts the settlement. Use `GET` on the same path to read local execution status.

A lost or ambiguous submission response retains the reservation for manual review. Repeating the request returns its saved state. [PayHere Refund API](https://support.payhere.lk/api-%26-mobile-sdk/refund-api) · [PayHere Retrieval API](https://support.payhere.lk/api-%26-mobile-sdk/retrieval-api)

To recover an `uncertain` full card refund after a lost response, an independent verified administrator with a recent sign-in sends `{requestKey, expectedUpdatedAt, reason}` to `POST /api/v1/admin/payhere-refund-executions/:id/recover` with the standard origin and CSRF headers. Use a UUID request key, the execution's current `updatedAt`, and a reason of 10–500 characters. The command retrieves fresh PayHere evidence and requires the exact captured card payment to be `REFUNDED`. It settles the original reservation once and records the reviewer, reason, payment evidence and journal. It makes no refund submission and leaves the missing provider refund number empty. A late submission response preserves the recovered settlement.

Use `GET /api/v1/admin/payhere-refund-executions/:id/recovery` to read the audit record. PostgreSQL time records refund updates, when StageLink observes authenticated PayHere evidence, and when the recovery is saved. Repeating the same recovery command returns that record. A changed command, stale execution, pending refund, chargeback or mismatched evidence cannot settle the funds. Recovery applies to approved cancellation items, resolved full rental deposit refunds and full arbitration allocations. Hosted verification and partial refund evidence remain pending.

PostgreSQL requires a matching recovery record when a successful execution has no provider refund number. The audit must match the execution, captured payment, amount and settlement journal. Removing or changing that evidence fails the transaction.

For a resolved rental deposit claim with a zero deduction, use `POST /api/v1/admin/damage-claims/:id/payhere-refund` with the same `{}` body and administrator checks. StageLink requires authenticated evidence of the matching LKR card payment. Once PayHere reports the payment as refunded, repeating the `POST` settles the customer reserve. Use `GET` on the same path to check execution. Booking participants can read `payHereRefundState` at `GET /api/v1/bookings/:id/damage-claim`.

Partial deposit refunds need hosted confirmation of both provider support and evidence of the exact refunded amount. PayHere’s Refund API shows an amount parameter, while its refund guide describes full refunds and its Retrieval API reports payment status. [PayHere Refund API](https://support.payhere.lk/api-%26-mobile-sdk/refund-api) · [PayHere Refund Process](https://support.payhere.lk/refund-process) · [PayHere Retrieval API](https://support.payhere.lk/api-%26-mobile-sdk/retrieval-api)

### Collect PayHere partial-refund sandbox evidence

Create a dedicated test card capture in the PayHere sandbox. Set the sandbox Retrieval API credentials in `PAYHERE_SANDBOX_RETRIEVAL_APP_ID` and `PAYHERE_SANDBOX_RETRIEVAL_APP_SECRET`. Set `STAGELINK_PROBE_PAYHERE_ORDER_ID` and `STAGELINK_PROBE_PAYHERE_PAYMENT_ID` from the test payment, and use `STAGELINK_PROBE_PAYHERE_CAPTURE_MINOR` and `STAGELINK_PROBE_PAYHERE_REFUND_MINOR` for the original and intended refund amounts in LKR minor units.

After building, run `npm run --silent payhere:partial-refund-probe` from `backend/` to record the initial payment state. Run it once with `-- --submit` to send the exact partial amount. Record the returned sandbox refund number and run without flags again after PayHere processes the refund. If the submission result is uncertain, inspect the merchant record before any further submission. Compare the exact refunded amount and refund number in the merchant record against the intended amount. The probe reports the payment-level status and names of refund-related fields. A pending submission or a payment-level status alone leaves exact partial settlement unverified.

## Payout reservations

Providers can read `GET /api/v1/me/earnings`. Administrators can read `GET /api/v1/admin/payments` and submit `{expectedRevision, held, reason}` to `POST /api/v1/admin/bookings/:id/holds`. Use hold revision `0` for a booking without a prior hold.

`POST /api/v1/admin/payouts` takes `{bookingId, destinationRevision}` and reserves the sandbox service funds once. It requires administrator-verified completion, paid service orders and the current approved destination. `GET /api/v1/payouts/:id` is scoped to the provider and administrators. A reservation status of `review_required` signals a hold, destination change or payment review. `stripeTransferStatus` reports the status of a connected-account transfer separately from reservation eligibility.

### Repair a stale payout destination

A verified administrator with a recent sign-in can use `POST /api/v1/admin/bookings/:id/payout-destination-repairs` with the standard origin and CSRF headers. Send `requestKey`, the payout's `expectedDestinationRevision`, the newer approved `destinationRevision`, and a review `reason`. StageLink requires verified completion, current provider identity approval, paid service orders, the full original reserve, and clearance of booking and payment holds. An existing Stripe attempt blocks repair until a retry is authorized after a confirmed rejection or full reversal.

The repair preserves the payout ID, reserved balance and fee amount. StageLink records both revisions and the approving administrator, then issues a new reservation statement alongside the original. Replay the same request key and input to get the saved decision. Review and link the newer Stripe test destination before submitting a transfer.

## Stripe test Connect capabilities

A verified administrator can read `GET /api/v1/admin/payments/stripe-capabilities` using the configured Stripe test key. It reports whether the platform country lists LKR for payments and whether the account has an available LKR balance. With `connectedAccountId=acct_…`, it also reports the account controller relationship, transfer capability, payout status and the available country-spec evidence for LKR bank settlement and destinations. Missing evidence appears as `null`. The report is a read-only diagnostic. Hosted validation still needs a test platform, the actual connected account and a supported transfer route for the chosen payout. [Stripe Accounts](https://docs.stripe.com/api/accounts/retrieve) · [Country specs](https://docs.stripe.com/api/country_specs/retrieve) · [Connect transfers](https://docs.stripe.com/connect/separate-charges-and-transfers)

## Stripe test payout destination links

A verified administrator can link a platform-controlled Stripe test account to a provider’s current approved payout destination revision. Use `POST /api/v1/admin/providers/:id/stripe-destination` with `requestKey`, `destinationRevision`, `expectedLinkId`, `accountId` and a review reason. Set `expectedLinkId` to `null` for the first link or to the current link ID for a replacement. The administrator signs in recently, verifies the provider-account match, and includes the standard origin and CSRF headers. Stripe account evidence confirms that the configured test platform controls the account. [Stripe account retrieval](https://docs.stripe.com/api/accounts/retrieve) · [Stripe test balance](https://docs.stripe.com/api/balance/balance_retrieve)

Use `GET` on the same path for the active link, its match to the current approved destination and the latest 20 historical changes. To revoke, send `{expectedLinkId, reason}` to `POST /api/v1/admin/providers/:id/stripe-destination/revoke`. Links record the platform, destination revision, reviewer and reason. A new payout destination revision requires a new link. Payout submission still requires a validated transfer route and current booking and provider eligibility.

## Stripe test payout transfers

`STRIPE_TEST_PAYOUT_TRANSFERS=true` enables submission with the Stripe test settings. The feature defaults off. A verified administrator with a recent sign-in sends `{}` to `POST /api/v1/admin/payouts/:id/stripe-transfer` with the standard origin and CSRF headers. StageLink rechecks booking completion, holds, current provider verification, the approved linked destination, the reservation and the paid Stripe test captures. The connected account must have an active transfer capability and the platform must have enough available LKR card balance.

Use `GET` on the same path to read the latest created transfer attempt. Send `{reconcileOnly:true}` to check an unsettled or completed active attempt against Stripe without initiating a transfer. For the first attempt, a retry with `{}` first looks for the original transfer and reuses its idempotency key only while the 30-second submission lease and the 23-hour replay window are active. PostgreSQL measures both deadlines. After the replay window closes, StageLink can still reconcile the original transfer with Stripe. A confirmed transfer posts the provider's net amount once to Stripe transfer clearing. `transferred` means Stripe confirmed the movement to the connected account balance. [Stripe transfers](https://docs.stripe.com/api/transfers) · [Stripe idempotency](https://docs.stripe.com/api/idempotent_requests)

Reconciliation credits confirmed partial or full reversals back to the payout reserve. The API reports the cumulative posted amount in `reversedMinor`. Reconciliation posts only increases in that total and preserves the original transfer journal. A reversal keeps the payout in `review_required` and the returned funds and platform fee remain reserved. [Stripe transfer reversals](https://docs.stripe.com/api/transfer_reversals)

Signed platform `transfer.created` and `transfer.reversed` events reconcile existing attempts, including when a submission response was lost. StageLink matches the test transfer and retrieves it with the configured platform key before posting. Event IDs and the retrieved reversal totals are stored with the attempt. Duplicate deliveries share one receipt and stale totals leave later postings intact. Reconciliation remains available for existing attempts when submission is disabled. Hosted webhook delivery and the LKR route require a configured test platform. [Stripe transfer events](https://docs.stripe.com/api/events/types) · [Stripe webhook ordering](https://docs.stripe.com/webhooks#event-ordering)

A first Stripe submission that returns an authenticated `balance_insufficient` rejection with a Stripe request ID records `rejected` and preserves the full reserve. The administrator view includes the error code and request ID for review. Network errors, server errors, and rejection responses from retries of uncertain submissions keep the original attempt in reconciliation. [Stripe transfer creation](https://docs.stripe.com/api/transfers/create) · [Stripe error handling](https://docs.stripe.com/error-low-level)

An independent verified administrator can send `{transferId, reason}` to `POST /api/v1/admin/payouts/:id/stripe-transfer/retry-authorizations` after a confirmed rejection or full reversal with the original gross reserve intact. StageLink records the approval and retains the prior attempt and journals. Repeating the same approval returns the saved decision. Use `GET /api/v1/admin/payouts/:id/stripe-transfer/attempts` for the most recent 20 attempts and their retry approvals.

Use `GET /api/v1/admin/payouts/:id/stripe-transfer/attempts/:attemptId/investigation` as a verified administrator to review a specific attempt. One database snapshot shows the attempt status and lease, recorded journal ID, original gross reserve, current posted reserve, booking payout block, and the 20 most recently received signed Stripe events for that attempt. The reserve balance is a decimal string in minor LKR units and is null when the reservation account cannot be verified for the attempt. Historical attempts share the current payout reserve balance. `latestAttempt` identifies the attempt targeted by reconciliation.

For an uncertain latest attempt, check the investigation record before using the existing `{ "reconcileOnly": true }` transfer command. The investigation endpoint reads stored evidence and makes zero Stripe calls. An empty event list and intact reserve leave the Stripe outcome uncertain. A new attempt still requires a confirmed rejection or a reconciled full reversal and recorded retry approval.

To begin a new attempt, send `{retryOfTransferId}` to the transfer endpoint using the approved transfer's ID. Use the same body to retry an uncertain response for that new attempt. A new attempt uses a new Stripe idempotency key and rechecks the current destination, captures, holds and reserve. An empty body returns the latest state after retry approval. Partial reversals and unresolved submissions remain held for review. Hosted LKR verification and bank payout execution remain open.

#### Stripe test bank payout confirmation

A verified administrator can use `GET /api/v1/admin/payouts/:id/stripe-transfer/bank-payout?bankPayoutId=po_…` to check the latest recorded unreversed transfer against a specific automatic standard LKR bank payout. StageLink retrieves the transfer with the platform test key, then checks the payout and its balance transactions on the linked connected account. `included` means Stripe currently reports the payout as paid and lists the transfer's exact full LKR credit among its reconciled balance transactions. The response may identify one transfer within a larger payout batch. [Stripe connected-account requests](https://docs.stripe.com/connect/authentication) · [Stripe payout balance transactions](https://docs.stripe.com/api/balance_transactions/list)

The check returns the current Stripe payout state on each request. A later failure returns `review_required`, and reconciliation still in progress returns `pending`. Use the settlement endpoint to record those outcomes in the sandbox journal. Hosted verification still needs a configured Stripe test platform and a supported LKR payout route. [Stripe payout statuses](https://docs.stripe.com/api/payouts/object)

#### Stripe test bank payout settlement

A verified administrator with a recent sign-in can send `{bankPayoutId}` to `POST /api/v1/admin/payouts/:id/stripe-transfer/bank-settlements` with the standard origin and CSRF headers. StageLink fetches fresh Stripe test evidence. When the linked transfer is included in a paid, reconciled automatic LKR bank payout, the booking is clear of holds, and its fee reserve is intact, the journal moves the provider amount into bank clearing and records the reserved platform fee as settled. One active settlement per transfer is allowed, so duplicate requests share the recorded journal.

Use the same POST to reconcile a later bank payout failure. StageLink posts accounting entries that compensate the original settlement, restores the fee reserve, and preserves both journal entries. Reconciliation of a Stripe transfer reversal also compensates any active bank settlement for that transfer. `GET /api/v1/admin/payouts/:id/stripe-transfer/bank-settlements` shows the most recent 20 records and their review reasons. Manual bank payout initiation and hosted verification remain open.

### Manual sandbox payout reconciliation

Set `MANUAL_SANDBOX_PAYOUT_RECONCILIATION=true` to exercise the manual workflow with fictional payout references. This posts sandbox ledger records for ordinary booking service payouts. Live bank payouts remain disabled.

A verified administrator with a recent sign-in sends `{testReference, amountMinor, destinationRevision, reason}` to `POST /api/v1/admin/payouts/:id/manual-sandbox-settlement` using the standard origin and CSRF headers. Use a unique reference beginning with `SBX-`. The amount is the exact net payout in minor LKR units. StageLink checks the reviewed destination, booking eligibility and full original reserve. An identical retry using the same administrator returns the saved record.

A different verified administrator submits `{decision, reason, expectedRevision}` to `POST /api/v1/admin/payouts/:id/manual-sandbox-settlement/review`. Older clients can omit `expectedRevision` to review revision 1. A `confirm` decision rechecks eligibility and posts the provider net and platform fee once. A `flag` decision preserves the full reserve for review. A prior Stripe attempt prevents recording a manual payout. Reservations with manual evidence stay assigned to manual sandbox reconciliation.

For a flagged or reversed revision, submit `{expectedRevision, testReference, reason}` to `POST /api/v1/admin/payouts/:id/manual-sandbox-settlement/corrections`. StageLink rechecks the reserve, payout holds and approved destination, then records the unused test reference as a new revision awaiting review. The prior reference, review, reversal and statements stay in the audit history. A different administrator from the correction author must review the new revision. An identical retry returns the saved correction.

If the provider's approved destination changes after the latest manual payout is reversed, repair the reservation through `POST /api/v1/admin/bookings/:id/payout-destination-repairs` with the standard repair body. The repair requires the full restored reserve and clearance of payout holds. It records the old and new destinations in the audit history and issues a fresh reservation statement. Include the new `expectedDestinationRevision` in the replacement correction so the new evidence is bound to the reviewed destination.

To reverse a posted sandbox settlement, a verified administrator other than the administrator who confirmed it submits `{expectedRevision, requestKey, reason}` to `POST /api/v1/admin/payouts/:id/manual-sandbox-settlement/reversals`. StageLink checks the original journal and restores the gross reserve with one compensating journal. The original approval and postings remain in the history. Provider status becomes `reversed`, and sandbox analytics reflect the offsetting payout and fee. The reservation stays on the manual sandbox path. An identical reversal request returns the original reversal, including after a later revision replaces it.

Administrators can read the current revision using `GET /api/v1/admin/payouts/:id/manual-sandbox-settlement` and page through older records using `GET /api/v1/admin/payouts/:id/manual-sandbox-settlement/history?beforeRevision=<cursor>`. History starts at the newest revision when the cursor is omitted. Providers see the latest manual settlement status beside the reservation in their payout and earnings views. Posted journal entries appear in sandbox analytics.

## Booking documents

List documents at `GET /api/v1/bookings/:id/documents`, preview a snapshot at `GET /api/v1/documents/:id`, and download the worker-rendered PDF at `GET /api/v1/documents/:id/download`. The worker must be running with access to the private object store. A failed render can be queued again with `POST /api/v1/documents/:id/render-retry`.

Booking participants can see the invoice. The customer can see capture and refund receipts. The provider can see their payout reservation, bank settlement and settlement reversal statements. Authorized administrators can access each type. These are sandbox documents. Production issuance needs confirmed issuer details and gateway outcomes.

A successful sandbox refund creates one receipt for its matching posted journal. This covers Stripe test and PayHere sandbox refunds for cancellations, rental deposit claims and arbitration, including audited PayHere recovery. Existing successful refunds with matching journals are backfilled. The API returns these receipts as `version: 2` receipt snapshots with `disposition: "refunded"`, the exact refunded amount, gateway, original payment order, and refund context.

Stripe test bank settlement and reversal statements come from posted ledger movements, with one document per journal. A later reversal adds a statement that references the original journal and preserves the original statement. Posting attempts without a bank settlement journal produce no statement. Existing posted journals are backfilled by the migration. The API exposes these as settlement snapshots with `version: 2` and a `bankSettlement` object. Deploy the matching API and PDF worker together so both understand the new snapshot version.

Manual sandbox settlement and reversal statements use `version: 3` settlement snapshots with a `manualSettlement` object. Each statement identifies the posted ledger journal and the evidence revision. Reversal statements also identify the original settlement journal. Providers and authorized administrators can download both PDFs. Historical posted manual journals are backfilled.

### Verify payout statements on staging

Use a dedicated sandbox booking with a posted manual payout and reversal. Wait until both PDFs are ready, then set `STAGELINK_SMOKE_ORIGIN` to the staging API HTTPS origin and set `STAGELINK_SMOKE_BOOKING_ID`, `STAGELINK_SMOKE_PAYOUT_SETTLEMENT_DOCUMENT_ID` and `STAGELINK_SMOKE_PAYOUT_REVERSAL_DOCUMENT_ID` to the fixture IDs. After `npm run build`, run `npm run --silent payout-statements:smoke` in `backend/` and supply the three staging access tokens as `{"admin":"...","provider":"...","customer":"..."}` through protected stdin.

The command reads the linked records, checks that the administrator and booked provider receive identical private bytes for each PDF, and verifies that the customer and anonymous requests receive the expected denials. It exits nonzero on any failure. The report contains check names, outcomes and HTTP status codes.

## Verified reviews

The customer submits one review after completion is verified. Use `POST /api/v1/bookings/:id/reviews` with `{rating, body, photoIds?}`. Use the private media upload pipeline with purpose `review` for photos. Administrators can list reviews at `GET /api/v1/admin/reviews` and record a revisioned moderation decision at `PATCH /api/v1/admin/reviews/:id/moderation`.

`GET /api/v1/listings/:id/reviews?targetKind=gig|rental` returns published reviews and the listing average. Browse responses from `GET /api/v1/listings` and `GET /api/v1/rentals` include each listing's `ratingSummary` with the published review average and count. Listings with no published reviews return an average of `null` and a count of zero. The optional `minRating` filter includes listings at or above the requested average.

## Equipment inspections

The renter opens an inspection at `POST /api/v1/bookings/:id/inspections` during the booking window with the accessory manifest. The server allocates registered serials from the booking's equipment lines. Use upload purpose `inspection` for private photos. The provider submits condition and photo evidence, and the customer acknowledges the submitted revision or requests a correction.

The renter opens return inspection at `POST /api/v1/inspections/:id/return`. Booking participants can compare submitted conditions and photo sets at `GET /api/v1/inspections/:id/comparison`. Discrepancies keep units quarantined until the provider submits clearance evidence.

## Deposit claims

The renter submits a proposal at `POST /api/v1/damage-claims` after the customer acknowledges the return. The customer responds at `POST /api/v1/damage-claims/:id/respond`. Administrators review the response and record a decision at `POST /api/v1/admin/damage-claims/:id/resolve`. Positive deductions require evidence and are capped at the collected deposit. The `reserved` state represents an internal sandbox allocation pending gateway execution.

For a resolved claim backed by a Stripe test deposit, an administrator can send `{destinationRevision}` to `POST /api/v1/admin/damage-claims/:id/payout`. StageLink requires verified renter identity, a current approved payout destination, clear payout controls, and a confirmed Stripe test refund for any customer share. The deduction gets its own payout and sandbox statement. The net equals the approved deduction and the platform fee is zero.

Use the returned payout ID with the existing administrator Stripe transfer and bank settlement endpoints. Before submitting a transfer, StageLink verifies the captured deposit and exact refunded total with Stripe. Transfer reversals restore the deduction to its payout reserve and reverse any posted bank settlement. The earnings and admin payments views list the reservation under `deductionPayout`. If the destination revision changes, use `POST /api/v1/admin/damage-claims/:id/payout-destination-repairs` with the standard repair body, then review the Stripe test link for the new revision. [Stripe Charge object](https://docs.stripe.com/api/charges/object) · [Stripe Transfer API](https://docs.stripe.com/api/transfers/create)

## AI operations

Administrators can read `GET /api/v1/admin/ai/status`, `GET /api/v1/admin/ai/config` and `GET /api/v1/admin/ai/metrics`. Use `PUT /api/v1/admin/ai/config` with `{expectedRevision, weights}` to save weights that total 100. The status endpoint checks the configured internal FastAPI origin. Metrics report recorded requests, outcomes, latency, token usage and model counts.

Administrators manage the biography and equipment prompts under `/api/v1/admin/ai/prompts`. Draft saves, publish and rollback use `expectedRevision`. Rollback creates a new published version from the selected prior version. Preview resolves the template and reports model output as unavailable until a provider is connected.

Customers can request up to three ranked published gigs at `POST /api/v1/event-posts/:id/recommendations` with `{requestKey, expectedRevision, genres?}`. Read saved results at `GET /api/v1/recommendations/:id`. Rankings use the published base price and event brief budget, city, optional genres, published ratings and the saved matching weights. The event date follows Sri Lanka time. When the artist has weekly hours, at least one operating interval in their calendar timezone must overlap that date after blackouts are removed. For calendars without usable weekly hours, a complete blackout of that date excludes the artist. Confirm the specific time through the availability endpoint before booking.

## Prompt model previews

The administrator preview endpoint `POST /api/v1/admin/ai/prompts/:key/preview` resolves the template with the supplied fields. Set `generate: true` to request a model suggestion as well. The response includes the rendered template, model status and optional plain-text draft for review.

Enable model previews by configuring the API and its private FastAPI service with the same `AI_INTERNAL_TOKEN` (32 random bytes encoded as hex). Set `AI_PREVIEW_PRIMARY_PROVIDER` to `openai` (default) or `gemini`. Configure the selected provider's API key and structured-output model in FastAPI with `AI_OPENAI_API_KEY` and `AI_OPENAI_MODEL`, or `AI_GEMINI_API_KEY` and `AI_GEMINI_MODEL`.

Set `AI_PREVIEW_FALLBACK=true` and configure both providers to permit a second attempt after an explicit HTTP 429. The same template and fields may then be sent to both providers. Both attempts share an eight-second deadline. Refusals, timeouts, incomplete results and other provider errors end the preview. The API uses a shared 24-hour Redis counter (`AI_PREVIEW_DAILY_LIMIT`, default 20 submitted previews). Each attempt requests a maximum of 450 output tokens and supplies no tools.

Provider-reported usage and template source are recorded in PostgreSQL per attempt. Draft, inline and published templates are traced separately. Preview output requires review before copying into a listing. Equipment prompts direct the model to omit unverified technical claims.

To check the hosted model, set `STAGELINK_SMOKE_ORIGIN` and `STAGELINK_SMOKE_WEB_ORIGIN` to the staging API and configured web HTTPS origins. From `backend/`, run `npm run build` and then `npm run --silent ai:smoke`, piping a JSON object with `accessToken` and `csrfToken` from a verified administrator session through protected stdin.

Run during a quiet staging window so other biography previews do not affect the usage comparison. The command checks the service's preview capability, takes a usage baseline, and sends one synthetic biography preview with an inline prompt. It consumes one preview quota entry and may use the configured provider fallback. It checks that the rolling 24-hour `preview-bio` request and success counters increase. The report contains check outcomes and HTTP/model status codes. No prompt, generated text, or session data appears in the report. A failed check exits with a nonzero status.

## Artist writing suggestions

Verified artist accounts can request a biography at `POST /api/v1/ai/generations/bio` with `requestKey` and `fields` containing `artist_name`, `genres` and `event_type`. For a gig title and description, use `POST /api/v1/ai/generations/gig` with `artist_name`, `performance` and `event_type`. Each request uses the latest published template at acceptance. The result can be retrieved by its owner from `GET /api/v1/ai/generations/:id`. Artists review and copy suggestions into their own drafts before saving.

Supply a fresh UUID for each intended generation. Reuse that key and the same fields to recover the existing result after a network interruption. PostgreSQL measures the 30-second processing deadline and the rolling 24-hour request limits. After the deadline, the job returns `unavailable` and any late model response is recorded as usage without saving its suggested text. User input fields are sent to the configured provider as data. The job retains a request fingerprint, the suggested text when available, the prompt version and links to usage records. The limits are five requests per artist and `AI_GENERATION_DAILY_LIMIT` (default 20) across all artists. Configured provider fallback follows the same rules as administrator previews.

## Equipment specification suggestions

Administrators review source documents and approve each manufacturer/model reference with `POST /api/v1/admin/equipment-spec-sources`. Supply `manufacturer`, `model`, `specs`, an HTTPS `url`, a document `title` and an optional `locator` such as the page number. Use listing-format values for wattage, SPL, frequency and weight. One reference can be active per manufacturer and model. List references with the admin GET route and retire a reference with `POST /api/v1/admin/equipment-spec-sources/:id/retire` and a reason.

Administrators can also review 12 manufacturer references and approve a selection using its preview digest. [Manufacturer reference bundle](Equipment-Reference-Bundle.md).

Verified renters can submit `requestKey`, `model` and optionally `manufacturer` to `POST /api/v1/ai/generations/equipment-specs`. The backend compares the full model name after case and whitespace normalization. An ambiguous or unknown match returns empty specs. Matching suggestions include a source citation and can be reopened by their owner at `GET /api/v1/ai/generations/:id`. After retirement, saved suggestions retain the citation and return `withdrawn` with empty specs. Reuse the request key to reopen a lookup or use a fresh one to check the current catalog. Renters review suggestions and save applicable values through the existing listing editor. The lookup uses approved catalog records and has a rolling limit of 30 new searches per renter over 24 hours.

## Published gig embeddings

Set `AI_EMBEDDING_MODEL` to `text-embedding-3-small` or `text-embedding-3-large` on both the API and private FastAPI service. Configure the shared `AI_INTERNAL_TOKEN` and set `AI_OPENAI_API_KEY` on FastAPI. The API requires `AI_SERVICE_ORIGIN` in host development. Indexing is disabled by default. The shared 24-hour quota defaults to 20 provider requests through `AI_EMBEDDING_DAILY_LIMIT`.

Verified administrators can send `POST /api/v1/admin/ai/listing-embeddings/:gigId` with the current published `expectedVersion` and the normal origin and CSRF headers. The provider receives the public title and description. Repeating an in-progress or completed request returns its status. An attempt can be retried after its 30-second PostgreSQL deadline. Late responses are recorded as model usage and leave the stored listing vector intact. `GET` on the same path reports the state for the currently published version and configured model. Vectors remain in PostgreSQL. Recommendations use the weighted catalog by default.

## Semantic recommendations

Set `AI_SEMANTIC_RECOMMENDATIONS=true` on the API to allow an opt-in request. Send `useSemantic: true` with a new recommendation request key to authorize sending the current private brief title and description to the configured OpenAI embedding model. Brief requirements and account data stay in StageLink. Repeating a request key reuses its saved result and requires the same opt-in setting. While the 30-second PostgreSQL deadline is active, the API returns `RECOMMENDATION_PROCESSING` and the caller can retry with the same key. If the deadline passes first, that key returns the saved weighted results. A late model response leaves those results intact.

The API applies the same budget, publication, provider approval and calendar checks as weighted recommendations before scoring up to 30 candidates. When at least two candidates have compatible embeddings for their current published revision, it blends the weighted catalog score (70%) with nonnegative cosine similarity (30%). Candidates without an embedding retain their weighted score. Insufficient coverage, provider failure and exhausted quotas return weighted results. Rankings remain based on the published weight revision recorded with each run. The semantic result records the embedding model and formats plus candidate scores and listing embedding attempts. The run stores neither the query vector nor another copy of the brief text.

Semantic calls are limited to five per customer per 24 hours and `AI_SEMANTIC_DAILY_LIMIT` across customers (default 20). The feature defaults to off. The deterministic `semantic-ranking.test.ts` evaluation compares reciprocal ranks on three labeled synthetic briefs. Representative catalog evaluation and a live model smoke test remain part of staging verification.

### Paired ranking evaluation

For each staging brief, capture one weighted run and one run with `useSemantic: true`. Use separate request keys and keep the brief revision, requested genres, published catalog and matching weights fixed. Save both responses from `GET /api/v1/recommendations/:id`. Label results before inspecting how the two rankers ordered them.

Create a JSON manifest with `version: 1`, `expectedModel` set to the deployed embedding model, and a `cases` array. Each case has a short lowercase `key`, both full run responses under `weighted` and `semantic`, and `judgments` containing `{gigId, relevance}` records. Use grades 0 (irrelevant), 1 (partial fit), 2 (good fit), and 3 (strong fit). Judge every result returned by either run and include any other known relevant listings. Each case needs at least one positive judgment. Use case keys that contain no private details.

From `backend/`, run `npm run build` and then `npm run --silent recommendations:evaluate -- <manifest.json>`. The evaluator reports reciprocal rank of the first relevant result, graded nDCG, and recall over judged relevant listings, all at rank three. Averages use the same comparable cases for both methods. It counts semantic fallbacks and excludes pairs with changed revisions, mismatched embedding provenance, stale listings or missing judgments. Incomplete data returns a nonzero status with the available results. A complete report can still show a quality regression. The command reads the file locally and emits no brief text, listing IDs, or request credentials.

To capture and score staging runs in one command, set `STAGELINK_SMOKE_ORIGIN` and `STAGELINK_SMOKE_WEB_ORIGIN` to the staging HTTPS origins. From `backend/`, build and run `npm run --silent recommendations:capture -- <plan.json>`, piping the staging brief owner's `{accessToken, csrfToken}` session JSON through protected stdin.

The plan uses `version: 1`, `expectedModel`, and one to five `cases` for briefs owned by that customer. Each case supplies `key`, `briefId`, `briefRevision`, optional `genres`, two distinct UUIDs as `weightedRequestKey` and `semanticRequestKey`, and the `judgments` described above. Choose staging briefs and listings that represent the event types and budgets you want to evaluate. Keep the catalog and matching weights fixed during capture.

The command opts each staging brief into the semantic model once per new semantic request key. Use synthetic briefs cleared for embedding and preserve the plan's request keys to recover the same runs after interruption. It rereads both saved results and prints the existing evaluation report. A capture error prints the case key, failed stage and available HTTP status. The command exits nonzero on a capture error or an incomplete comparison.

## Provider verification

Providers submit two to five validated private images or PDFs with `POST /api/v1/verification-cases`. Upload them with purpose `verification`, then pass their asset IDs in the case. Providers read their own history at `GET /api/v1/me/verification`. Administrators review pending cases at `GET /api/v1/admin/verification-cases` and record a reasoned decision at `POST /api/v1/admin/verification-cases/:id/decisions`. A rejected provider can submit a new version.

The worker renders each PDF page and reconstructs the download from the resulting images. The rendered copy preserves the visible pages. Embedded text, interactive content and digital signatures are discarded. The PDF download uses a short-lived asset capability checked at download time. The owner can access their copy. A verified administrator can access the copy while it is attached to a pending verification case. The original remains in private asset storage under the existing retention rules.

To check the hosted PDF path, use two ready synthetic PDFs owned by the same staging provider. Attach one to a pending verification case and the other only to a closed case. Set `STAGELINK_SMOKE_ORIGIN` to the staging API HTTPS origin, `STAGELINK_SMOKE_WEB_ORIGIN` to its configured web HTTPS origin, and `STAGELINK_SMOKE_PENDING_PDF_ASSET_ID` and `STAGELINK_SMOKE_CLOSED_PDF_ASSET_ID` to the two asset IDs. Use a dedicated provider whose fixture cases appear on the first history page.

Run `npm run build` from `backend/` and then `npm run --silent verification:smoke` with a JSON object piped through protected stdin. It has `owner`, `admin` and `outsider` entries, each with `accessToken` and `csrfToken` from its current staging session. Use the fixture owner, a verified administrator with the admin role active, and an unrelated member. The tool checks case state, both owner downloads, the pending-case administrator download, and denials for the closed-case administrator, outsider and unsigned requests. Verified downloads must return private attachment headers and PDF bytes. The owner and administrator must receive the same pending PDF. The report includes check results only. It prints no asset IDs, capabilities, credentials, file bytes or digests. Failed checks produce a nonzero exit status.

## Support cases

See [live support refresh](Support-Realtime.md) for case subscriptions, member/staff visibility and reconnect recovery.

Members create and read their own cases through `POST /api/v1/cases` and `GET /api/v1/me/cases`. Use the case replies endpoint for the shared conversation. Administrators use `/api/v1/admin/cases` for the queue, replies, private notes, assignment and status changes. Validated private images and PDFs use upload purpose `support`. PDFs are limited to 5 MiB and one to eight unencrypted pages. The worker renders and rebuilds the file; downloads expose only the sanitized derivative and use the fixed name `support-attachment.pdf`. The owner can read their library file, and a verified active administrator gains access only after it is attached to a support case. Existing download grants recheck the session and case binding. Original quarantined files are not downloadable. Frontend attachment controls and Figma updates remain pending.

## Realtime booking chat

Connect Socket.IO 4.x to the API host with path `/api/v1/chat/socket.io`, transport `websocket`, and `auth: { accessToken }`. The handshake expects the configured StageLink web origin. Each client event takes one payload and an acknowledgment callback. Acknowledgments return `{ ok: true, data }` or `{ ok: false, error: { code, message } }`.

| Client event | Payload | Success data |
| --- | --- | --- |
| `chat:join` | `{ bookingId }` | `{ bookingId }` |
| `chat:leave` | `{ bookingId }` | `{ bookingId }` |
| `chat:send` | `{ bookingId, data: { requestKey, body, draft?, attachmentIds? } }` | Saved message |
| `chat:read` | `{ bookingId, data: { throughId } }` | Saved read receipt |
| `chat:typing` | `{ bookingId, typing }` | `{ bookingId }` |

Join as a booking participant before sending, reading or publishing typing state. `chat:changed` carries a booking ID and either `{ kind: 'message', messageId }` or `{ kind: 'read', readerId, throughId }`. The API sends changes from REST and socket writes. Use `GET /api/v1/conversations/:id/messages?after=<last applied message ID>` to recover committed messages and current read receipts on change and after reconnect. When no messages have been loaded yet, request the initial page without a cursor. Retry an unacknowledged send with the same request key. `chat:typing` carries `{ bookingId, userId, typing }` and is transient. Expire typing indicators locally.

When an access token expires, reconnect with a refreshed token and rejoin the conversation. A revoked session is rejected. Forward WebSocket upgrades through the proxy. Replicas that share PostgreSQL and Redis must use the same Redis database and `AUTH_RATE_PREFIX` for booking fanout. Redis relays booking IDs and event references, while each replica checks active sessions before delivering to its local rooms. If a relay signal is missed, recover the conversation through the REST history endpoint.

To check the hosted proxy, use a disposable staging booking that permits chat and has two separate test participants. Set `STAGELINK_SMOKE_ORIGIN` to the API HTTPS origin behind the proxy, `STAGELINK_SMOKE_WEB_ORIGIN` to the configured web HTTPS origin and `STAGELINK_SMOKE_BOOKING_ID` to the fixture booking ID. From `backend/`, run `npm run build` and then `npm run --silent chat:smoke`, piping a JSON object with `sender` and `receiver` access tokens through protected stdin.

The check writes three synthetic messages to the fixture conversation. It opens two WebSocket connections, verifies live delivery, disconnects one participant while a message is saved, then reconnects and rejoins that participant. It verifies the missed message through cursor-based REST history and confirms live delivery resumes. It reports check outcomes without printing tokens, booking IDs, message IDs or bodies. A failed check exits with a nonzero status.

## Booking disputes

Booking participants can open a dispute at `POST /api/v1/bookings/:id/disputes` and attach private images uploaded with purpose `evidence`. Administrators review the case and eligible service balance under `/api/v1/admin/disputes`. A dismissal releases the dispute hold. A financial decision requires the reviewed balance and reserves the sandbox refund, fee and provider amounts atomically. `GET /api/v1/arbitrations/:id` reports execution as `awaiting_gateway`, `settled` or `review_required`, with the related `payoutId` when reserved.

The arbitration read includes `refundItems` with the captured amount, approved refund amount and recorded `stripeRefundState` and `payHereRefundState` for each source payment. For a positive Stripe test allocation, a verified administrator with a recent sign-in sends `{}` to `POST /api/v1/admin/arbitrations/:id/items/:orderId/stripe-refund` with the standard origin and CSRF headers. Enable the existing `STRIPE_TEST_REFUND_EXECUTION` setting. The server submits the saved payment allocation and settles that amount from the customer reserve after Stripe confirms the exact refund.

Use `GET` on the same execution path to read local state. Repeat `POST` to reconcile a pending or uncertain result using its original reference. Different source payments can reconcile against the shared customer reserve, and each settlement posts once. [Stripe refund API](https://docs.stripe.com/api/refunds/create) · [Stripe idempotent requests](https://docs.stripe.com/api/idempotent_requests)

For a PayHere sandbox allocation equal to its full captured card payment, an independent verified administrator with a recent sign-in sends `{}` to `POST /api/v1/admin/arbitrations/:id/items/:orderId/payhere-refund` with the standard origin and CSRF headers. Enable `PAYHERE_SANDBOX_REFUND_EXECUTION` and configure the sandbox retrieval credentials. StageLink retrieves matching payment evidence before submitting once. Repeat `POST` to reconcile an accepted pending refund, and use `GET` on the same path to read its local state. Authenticated retrieval must confirm the full payment as refunded before the saved allocation settles from the shared customer reserve. An uncertain submission stays reserved for review and is never automatically resubmitted. Partial allocations and non-card payments require separate review. [PayHere refund API](https://support.payhere.lk/api-%26-mobile-sdk/refund-api) · [PayHere retrieval API](https://support.payhere.lk/api-%26-mobile-sdk/retrieval-api)

For an award with a positive provider amount and Stripe test captures, a verified administrator with a recent sign-in sends `{destinationRevision}` to `POST /api/v1/admin/arbitrations/:id/payout`. StageLink requires confirmed customer refunds, clear payout controls, verified provider identity for the booking role, and the current approved destination. It moves the award's saved provider and fee amounts into one payout reserve and issues a sandbox statement. The new payout ID appears under `arbitrationPayout` in provider earnings and administrator payments.

Use that payout ID with the existing Stripe test transfer, bank settlement, reconciliation and retry endpoints. The transfer uses the saved provider amount. Bank settlement posts the saved fee, and a reversal compensates both amounts. Each source capture is checked against its approved refunded total before submission. Use `POST /api/v1/admin/arbitrations/:id/payout-destination-repairs` with the standard repair body when the approved destination revision changes. Hosted verification, partial PayHere refund reconciliation, and PayHere provider payout and fee execution remain in the backlog. [Stripe Transfer API](https://docs.stripe.com/api/transfers/create) · [Stripe Charge object](https://docs.stripe.com/api/charges/object)

For an award with a fee and zero provider payment, use `POST /api/v1/admin/arbitrations/:id/stripe-fee` with `{}`, the standard administrator origin and CSRF headers, and `STRIPE_TEST_PAYOUT_TRANSFERS=true`. A verified independent administrator signs in recently. StageLink requires confirmed customer refunds, clear payout controls and fresh matching Stripe test capture evidence. The command moves the saved fee from the award reserve into sandbox fee revenue once. `GET` on the same path reads the recorded settlement. Participants can read `stripeFeeState` on the arbitration.

Repeat the fee `POST` to reconcile. Temporary provider failures return `unavailable` alongside the last recorded settlement. A confirmed charge dispute or changed refunded total posts compensating entries, restores the fee reserve and marks the award for review. Administrator and provider analytics include settlement and reversal amounts on their journal posting dates. [Stripe Charge object](https://docs.stripe.com/api/charges/object)

## Booking reminders

Set `BOOKING_EMAIL_REMINDERS=true` to have the worker queue and send email reminders for eligible bookings. Development Compose uses Mailpit. Administrators can inspect and manage rows at `/api/v1/admin/reminders`. SMTP acceptance means the receiving server accepted the message. An unknown send outcome requires reconciliation before any resend.

To check the staging SMTP transport, load the staging worker environment, build from `backend/`, and pipe a single test inbox address you control into `npm run --silent smtp:smoke`. The command uses the worker's SMTP and TLS settings and sends one synthetic probe. It reports a probe ID and the SMTP outcome. Search the inbox for `StageLink SMTP smoke <probeId>` to verify receipt. Failed and unknown outcomes exit with a nonzero status.

Members list notifications at `GET /api/v1/me/notifications` and mark a notification read with `PUT /api/v1/me/notifications/:id/read`. The worker materializes notifications from booking and support outbox events. `PATCH /api/v1/me/notification-preferences` updates the booking reminder email preference using the revision returned by the corresponding GET.

For live inbox updates, send `notifications:subscribe` with `{}` on the authenticated Socket.IO connection, wait for the acknowledgment, then load the inbox over REST. On `notifications:changed`, a signal with payload `{}`, reload the list and unread count. Redis Pub/Sub fans out signals to API replicas after database commits. Reconnect, subscribe again and reload to recover missed changes. Keep the REST inbox available during broker outages and reload periodically while the inbox is open.

## Administrator system controls

Read maintenance state at `GET /api/v1/system/public-status`. Administrators use `PUT /api/v1/admin/system/maintenance` with the current revision, an enabled flag and a reason. While enabled, new business writes receive `503 MAINTENANCE_MODE`. Reads, sign-in, account recovery, payment callbacks, and these recovery controls remain available. Background workers continue running. Verified administrators can still cancel queued email/SMS reminders and email/SMS campaigns using their existing cancellation endpoints; creating, scheduling and retrying communication remain blocked. Origin, CSRF, authorization and audit checks still apply.

Administrators list and schedule announcements under `/api/v1/admin/announcements`. Publishing or unpublishing refreshes the public announcement cache. `POST /api/v1/admin/cache/invalidate` accepts the `public_announcements` scope. `POST /api/v1/admin/sessions/revoke` accepts one user ID and an optional session ID. `GET /api/v1/admin/audit` lists recorded control changes.

## Promotional campaigns

Members manage opt-in with `GET` and `PUT /api/v1/me/marketing-preferences`. Consent applies to the verified address at the time of opt-in and is independent of booking reminders. Administrators create campaigns under `/api/v1/admin/campaigns`. Preview returns the eligible recipient count and an audience fingerprint to submit with a schedule. The recipient cap is 100 per campaign. Scheduled rows are stored for the future delivery worker.

## Analytics

Administrators use `GET /api/v1/admin/analytics`. Providers use `GET /api/v1/me/analytics` for their own bookings. Both accept `from` (inclusive) and `to` (exclusive) as UTC calendar dates, defaulting to 30 days through the current UTC day. The maximum range is 366 days. Booking requests, agreements, cancellations and verified completions count on the dates those events occurred. The administrator view includes new user registrations. These operational counts are independent of the payment environment.

Financial activity uses the journal posting date and accepts `currency=LKR` and `environment=sandbox|live`. Amounts are decimal strings in minor units. Service capture is the successfully posted booking payment total before refunds and fees. Deposits and captures posted for reconciliation appear separately. Refund, payout and fee reservations show newly reserved amounts in the period. In sandbox reports, `settled.refundedMinor` includes confirmed Stripe test and PayHere sandbox refunds posted in the period and is also available for each UTC day. Refund reservations count under `money.refundReservedMinor` when posted.

Sandbox `settled.paidOutMinor` and `settled.feeRevenueMinor` report net bank payouts and platform fees from posted Stripe test bank settlement journals. A compensating journal reduces the totals on its own posting date, so a day or period can show a negative amount. An empty sandbox period reports zero. Provider reports include only their own bookings. Live financial activity and settlement amounts return `null` pending supported provider execution.

## Communication readiness

Verified administrators use `GET /api/v1/admin/communications` for delivery-enabled flags, SMTP security mode and SMS provider configuration presence. The response omits credentials, relay host, sender identity and recipient details.

`POST /api/v1/admin/communications/smtp-check` accepts `{}` with the configured Origin and CSRF token and requires a sign-in within 15 minutes. It checks the deployment's configured SMTP relay using Nodemailer's connection verification, closes the transport, and returns a normalized connection result, security mode, latency and database timestamp with `messageSent: false`. It does not submit email, select recipients or accept arbitrary relay settings. Failures omit private provider replies. Checks are limited to three per administrator per five minutes and twenty per deployment per minute. The endpoint remains available during maintenance.

After building the backend, set `STAGELINK_SMOKE_ORIGIN` and `STAGELINK_SMOKE_WEB_ORIGIN` to the staging HTTPS origins, then run `npm --prefix backend run --silent communications:check` with a recently signed-in administrator `{accessToken, csrfToken}` JSON object piped from a protected source to stdin. Do not put tokens in shell arguments. The command checks API readiness, secure SMTP connection and the email/SMS reminder queue APIs. It returns sanitized check names/results and sets a failing exit status for missing access, connection failure, plaintext development SMTP, malformed responses or inconsistent queue flags.

This checks connection readiness, not sender authorization or recipient deliverability. See [Nodemailer SMTP verification](https://nodemailer.com/smtp). SMS provider delivery, actual email delivery, TLS/authentication against the hosted relay, and frontend/Figma controls still need staging verification. No live messages are sent by this command.

## SMS contact verification

`SMS_VERIFICATION_ENABLED` enables contact verification and `BOOKING_SMS_REMINDERS` enables 24-hour and 2-hour reminders for opted-in verified contacts. Both settings default to false and share `SMS_HOURLY_LIMIT`. Members read delivery status at `GET /api/v1/me/booking-sms-reminders`. [SMS verification and booking reminders](SMS-Contact-Verification.md).

Booking reminder and SMS verification deadlines use database time, including after lock waits. Interrupted-send recovery and SMS receipt polling use that same clock. See [notification timing](SMS-Contact-Verification.md#notification-time-across-replicas) for regression coverage and hosted boundaries.

## Stop SMS notifications

Members can stop booking SMS, promotional SMS or both through the authenticated off-only action, including during maintenance. Contact revocation now records consent evidence and invalidates queued messages without erasing submitted delivery history. See [SMS contact and opt-out flow](SMS-Contact-Verification.md). Frontend/Figma controls and hosted delivery remain pending.

## Promotional SMS

Verified administrators can draft, preview, schedule, cancel and monitor consent-based SMS campaigns. Delivery defaults off, shares the SMS submission budget, and rechecks saved contact consent before submission. See [promotional SMS workflow](Promotional-SMS.md). Hosted delivery and frontend/Figma controls remain pending.

## Booking SMS operations

Verified administrators can monitor real booking SMS queue counts, filter by booking/window/state and cancel an unsent reminder with recorded review evidence. See [SMS reminder operations](SMS-Reminder-Operations.md). Delivery defaults off; frontend/Figma controls and hosted delivery checks remain pending.

### Staging SMS delivery evidence

Use a controlled, opted-in staging audience and record the IDs of a completed contact verification, a booking reminder, and a promotional campaign. Set `STAGELINK_SMOKE_ORIGIN` to the staging API HTTPS origin. Set `STAGELINK_SMOKE_SMS_VERIFICATION_ID`, `STAGELINK_SMOKE_SMS_REMINDER_ID`, and `STAGELINK_SMOKE_SMS_CAMPAIGN_ID` to those IDs, and set `STAGELINK_SMOKE_SMS_CAMPAIGN_RECIPIENTS` to the campaign's expected audience size.

Build from `backend/` and run `npm run --silent sms:smoke`. Pipe a JSON object with `member` and `admin` access tokens through protected stdin. The member must own the verification and reminder records, which must be in that account's latest 20 history entries. The command reads recorded delivery evidence and requires a delivered and confirmed verification, a delivered booking reminder, and delivery to the whole expected campaign audience. It prints check outcomes and status codes. A failed check exits with a nonzero status.

Payment choices can use the account-scoped [payment configuration capabilities](Payment-Capabilities.md) endpoint. Configured sandbox credentials do not establish merchant or booking eligibility.
