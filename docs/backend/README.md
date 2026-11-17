# StageLink backend

Backend development uses `main` in [Nezz77/StageLink-backend](https://github.com/Nezz77/StageLink-backend). Push backend commits with `git push origin main`. The frontend repository is [Nezz77/StageLink](https://github.com/Nezz77/StageLink). See the [whole-backend plan](StageLink-Backend-Implementation-Plan.md), [backlog](backend-backlog.json), [coverage](UI-Backend-Coverage.csv), [foundation decisions](ADR-001-foundation.md), [account decisions](ADR-002-accounts.md), and [progress](PROGRESS.md).

The API supports accounts, profile onboarding, payout destination review, media, artist gigs, and rental listings. Bookings, chat and payments are tracked in the backlog.

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

When connecting a separately running web client, set `WEB_ORIGIN` to its exact origin. Browser mutations enforce this origin. Verification and recovery messages are available in Mailpit.

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

Generated contracts are `contracts/openapi.json` → `packages/contracts/src/api.d.ts`. Regenerate and commit both after endpoint changes; CI rejects drift. Never edit an applied migration. Update the expected migration constant when adding one.

AI remains health-only. Under `backend/ai`, use Python 3.12 / uv 0.11.29, `uv sync --frozen`, then `uv run --frozen pytest -q`. No model/provider is configured.

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

The booking customer creates an advance or deposit order and requests a hosted checkout session. Submit the returned fields to its sandbox action URL. After returning, fetch the payment order to see the state recorded from the verified callback. Expired or ambiguous outcomes require reconciliation before a new attempt. Balance collection opens after the provider reports completion. See the [PayHere Checkout API](https://support.payhere.lk/api-%26-mobile-sdk/checkout-api).

## Stripe test Checkout

Set `STRIPE_TEST_SECRET_KEY` and `STRIPE_TEST_WEBHOOK_SECRET` together to enable Stripe test Checkout. Configure the test webhook endpoint at `/api/v1/payments/webhooks/stripe` for `checkout.session.completed`, `checkout.session.expired`, `checkout.session.async_payment_succeeded`, and `checkout.session.async_payment_failed`. Enable `transfer.created` and `transfer.reversed` from the platform account on the same endpoint to reconcile Stripe test payout transfers. Use a public HTTPS endpoint for delivery from Stripe. See [Stripe webhooks](https://docs.stripe.com/webhooks).

The booking customer sends `{}` to `POST /api/v1/payment-orders/:id/sessions/stripe` for an eligible advance, deposit or balance order and opens the returned URL. Advance and deposit sessions require more than 30 minutes before the booking starts. Fetch the payment order after returning for the state recorded by the webhook. Each order stays with the first gateway selected. Expired or ambiguous attempts require reconciliation before replacement. Test account LKR support, actual webhook delivery and Connect settlement still need verification.

## Sandbox payment reconciliation

A verified administrator can call `GET /api/v1/admin/payment-orders/:id/reconciliation` to compare the current StageLink capture record with gateway evidence. The response reports the gateway status and whether the evidence agrees, needs review or is inconclusive. Missing captures, mismatched amounts and duplicate or reversed PayHere payments need review. The check is read-only. Replaying a verified notification follows the existing webhook path.

Stripe uses the existing test key to retrieve the stored Checkout Session. PayHere requires `PAYHERE_SANDBOX_RETRIEVAL_APP_ID` and `PAYHERE_SANDBOX_RETRIEVAL_APP_SECRET` from the sandbox Merchant API settings. StageLink uses those credentials for a short-lived sandbox token. A missing PayHere retrieval result is inconclusive. [Stripe Checkout Session retrieval](https://docs.stripe.com/api/checkout/sessions/retrieve) · [PayHere Retrieval API](https://support.payhere.lk/api-%26-mobile-sdk/retrieval-api)

For a confirmed missing capture, a verified administrator submits `{requestKey, expectedOutcome: "captured", reason}` to `POST /api/v1/admin/payment-orders/:id/reconciliation/recover` with the standard origin and CSRF headers. StageLink retrieves fresh gateway evidence, checks the amount, currency and attempt reference, then records the capture in the sandbox review balance. The action records the administrator, evidence time, reason, and journal transaction. Verified Stripe expiration also supports `expectedOutcome: "expired"` for a pending order. Repeat the original request key to retrieve the saved action. Review recorded actions using `GET /api/v1/admin/payment-orders/:id/reconciliation/recoveries`. Inconclusive, duplicate, mismatched and reversed evidence requires manual review.


## Booking completion

Booking participants can read `GET /api/v1/bookings/:id/journey`. The provider submits `{"confirmed":true}` to the booking's `check-ins` route during its scheduled window and to its `completion` route after the scheduled and approved overtime end. Both require a paid advance. A check-in records the provider's manual confirmation. Either gig participant can propose overtime after check-in, and the other participant must resolve the proposal before completion.

After the completion report, the customer can open a balance payment order for the original price plus approved overtime less the paid advance. A separate admin verification records the reviewer, time and reason. Completion and verification leave settlement to the payout workflow.

## Cancellations and refund review

The customer can cancel an unpaid upcoming booking using `POST /api/v1/bookings/:id/cancellations` or request a refund review for captured funds using `POST /api/v1/bookings/:id/refund-requests`. Both take a reason. Administrators review pending requests at `GET /api/v1/admin/refund-requests` and submit a decision and reason to `POST /api/v1/admin/refund-requests/:id/decisions`. Approval reserves sandbox funds by payment and remains pending gateway execution. A gateway-confirmed refund is required to close a paid booking through this flow.

## Stripe test refund execution

Enable `STRIPE_TEST_REFUND_EXECUTION=true` with the Stripe test settings. The feature is off by default. A verified administrator with a recent sign-in can send `{}` to `POST /api/v1/admin/refund-requests/:id/items/:orderId/stripe-execution` with the standard origin and CSRF headers. StageLink uses the approved LKR amount from the reservation and the PaymentIntent from the matching paid test Checkout Session. It posts a settlement only after Stripe confirms the exact refund. The existing refund view includes the last Stripe execution status for each item.

Use `GET` on the execution path to read local state. Repeat the `POST` to reconcile a pending or uncertain execution. StageLink reuses its original execution reference and reconciles by Stripe refund ID or metadata. It limits creation retries to 23 hours after the first attempt. Uncertain and terminal failed executions keep the reservation for review. Payouts and arbitration are tracked in the completion backlog. [Stripe refund API](https://docs.stripe.com/api/refunds/create) · [Stripe idempotent requests](https://docs.stripe.com/api/idempotent_requests)

## PayHere sandbox refund execution

Enable `PAYHERE_SANDBOX_REFUND_EXECUTION=true` with the sandbox Merchant API credentials. A verified administrator with a recent sign-in sends `{}` to `POST /api/v1/admin/refund-requests/:id/items/:orderId/payhere-execution` with the standard origin and CSRF headers. StageLink ties the reserved amount to one captured PayHere payment with fresh retrieval evidence and submits a full refund. Successful submission records the provider refund number and leaves the reservation pending. Repeat the `POST` to reconcile it. A confirmed refunded payment consumes the reservation once and posts the settlement. Use `GET` on the same path to read local execution status.

A lost or ambiguous submission response retains the reservation for manual review. Repeating the request returns its saved state. Partial refunds for deposit claims and arbitration remain in the backlog. [PayHere Refund API](https://support.payhere.lk/api-%26-mobile-sdk/refund-api) · [PayHere Retrieval API](https://support.payhere.lk/api-%26-mobile-sdk/retrieval-api)

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

Use `GET` on the same path to read the latest created transfer attempt. Send `{reconcileOnly:true}` to check an unsettled or completed active attempt against Stripe without initiating a transfer. For the first attempt, a retry with `{}` first looks for the original transfer and reuses its idempotency key for at most 23 hours. A confirmed transfer posts the provider's net amount once to Stripe transfer clearing. `transferred` means Stripe confirmed the movement to the connected account balance. [Stripe transfers](https://docs.stripe.com/api/transfers) · [Stripe idempotency](https://docs.stripe.com/api/idempotent_requests)

Reconciliation credits confirmed partial or full reversals back to the payout reserve. The API reports the cumulative posted amount in `reversedMinor`. Reconciliation posts only increases in that total and preserves the original transfer journal. A reversal keeps the payout in `review_required` and the returned funds and platform fee remain reserved. [Stripe transfer reversals](https://docs.stripe.com/api/transfer_reversals)

Signed platform `transfer.created` and `transfer.reversed` events reconcile existing attempts, including when a submission response was lost. StageLink matches the test transfer and retrieves it with the configured platform key before posting. Event IDs and the retrieved reversal totals are stored with the attempt. Duplicate deliveries share one receipt and stale totals leave later postings intact. Reconciliation remains available for existing attempts when submission is disabled. Hosted webhook delivery and the LKR route require a configured test platform. [Stripe transfer events](https://docs.stripe.com/api/events/types) · [Stripe webhook ordering](https://docs.stripe.com/webhooks#event-ordering)

A first Stripe submission that returns an authenticated `balance_insufficient` rejection with a Stripe request ID records `rejected` and preserves the full reserve. The administrator view includes the error code and request ID for review. Network errors, server errors, and rejection responses from retries of uncertain submissions keep the original attempt in reconciliation. [Stripe transfer creation](https://docs.stripe.com/api/transfers/create) · [Stripe error handling](https://docs.stripe.com/error-low-level)

An independent verified administrator can send `{transferId, reason}` to `POST /api/v1/admin/payouts/:id/stripe-transfer/retry-authorizations` after a confirmed rejection or full reversal with the original gross reserve intact. StageLink records the approval and retains the prior attempt and journals. Repeating the same approval returns the saved decision. Use `GET /api/v1/admin/payouts/:id/stripe-transfer/attempts` for the most recent 20 attempts and their retry approvals.

To begin a new attempt, send `{retryOfTransferId}` to the transfer endpoint using the approved transfer's ID. Use the same body to retry an uncertain response for that new attempt. A new attempt uses a new Stripe idempotency key and rechecks the current destination, captures, holds and reserve. An empty body returns the latest state after retry approval. Partial reversals and unresolved submissions remain held for review. Hosted LKR verification and bank payout execution remain open.

#### Stripe test bank payout confirmation

A verified administrator can use `GET /api/v1/admin/payouts/:id/stripe-transfer/bank-payout?bankPayoutId=po_…` to check the latest recorded unreversed transfer against a specific automatic standard LKR bank payout. StageLink retrieves the transfer with the platform test key, then checks the payout and its balance transactions on the linked connected account. `included` means Stripe currently reports the payout as paid and lists the transfer's exact full LKR credit among its reconciled balance transactions. The response may identify one transfer within a larger payout batch. [Stripe connected-account requests](https://docs.stripe.com/connect/authentication) · [Stripe payout balance transactions](https://docs.stripe.com/api/balance_transactions/list)

The check returns the current Stripe payout state on each request. A later failure returns `review_required`, and reconciliation still in progress returns `pending`. Use the settlement endpoint to record those outcomes in the sandbox journal. Hosted verification still needs a configured Stripe test platform and a supported LKR payout route. [Stripe payout statuses](https://docs.stripe.com/api/payouts/object)

#### Stripe test bank payout settlement

A verified administrator with a recent sign-in can send `{bankPayoutId}` to `POST /api/v1/admin/payouts/:id/stripe-transfer/bank-settlements` with the standard origin and CSRF headers. StageLink fetches fresh Stripe test evidence. When the linked transfer is included in a paid, reconciled automatic LKR bank payout, the booking is clear of holds, and its fee reserve is intact, the journal moves the provider amount into bank clearing and records the reserved platform fee as settled. One active settlement per transfer is allowed, so duplicate requests share the recorded journal.

Use the same POST to reconcile a later bank payout failure. StageLink posts accounting entries that compensate the original settlement, restores the fee reserve, and preserves both journal entries. Reconciliation of a Stripe transfer reversal also compensates any active bank settlement for that transfer. `GET /api/v1/admin/payouts/:id/stripe-transfer/bank-settlements` shows the most recent 20 records and their review reasons. Manual bank payout initiation and hosted verification remain open.

## Booking documents

List documents at `GET /api/v1/bookings/:id/documents`, preview a snapshot at `GET /api/v1/documents/:id`, and download the worker-rendered PDF at `GET /api/v1/documents/:id/download`. The worker must be running with access to the private object store. A failed render can be queued again with `POST /api/v1/documents/:id/render-retry`.

Booking participants can see the invoice. The customer can see payment receipts and the provider can see the payout reservation statement. Authorized administrators can access each type. These are sandbox documents. Production issuance needs confirmed issuer details and gateway outcomes.

## Verified reviews

The customer submits one review after completion is verified. Use `POST /api/v1/bookings/:id/reviews` with `{rating, body, photoIds?}`. Use the private media upload pipeline with purpose `review` for photos. Administrators can list reviews at `GET /api/v1/admin/reviews` and record a revisioned moderation decision at `PATCH /api/v1/admin/reviews/:id/moderation`.

`GET /api/v1/listings/:id/reviews?targetKind=gig|rental` returns published reviews and the listing average. The `minRating` filter on catalog browse uses that published average.

## Equipment inspections

The renter opens an inspection at `POST /api/v1/bookings/:id/inspections` during the booking window with the accessory manifest. The server allocates registered serials from the booking's equipment lines. Use upload purpose `inspection` for private photos. The provider submits condition and photo evidence, and the customer acknowledges the submitted revision or requests a correction.

The renter opens return inspection at `POST /api/v1/inspections/:id/return`. Booking participants can compare submitted conditions and photo sets at `GET /api/v1/inspections/:id/comparison`. Discrepancies keep units quarantined until the provider submits clearance evidence.

## Deposit claims

The renter submits a proposal at `POST /api/v1/damage-claims` after the customer acknowledges the return. The customer responds at `POST /api/v1/damage-claims/:id/respond`. Administrators review the response and record a decision at `POST /api/v1/admin/damage-claims/:id/resolve`. Positive deductions require evidence and are capped at the collected deposit. The `reserved` state represents an internal sandbox allocation pending gateway execution.

## AI operations

Administrators can read `GET /api/v1/admin/ai/status`, `GET /api/v1/admin/ai/config` and `GET /api/v1/admin/ai/metrics`. Use `PUT /api/v1/admin/ai/config` with `{expectedRevision, weights}` to save weights that total 100. The status endpoint checks the configured internal FastAPI origin. Metrics report stored observations. Model generation and usage recording are pending.

Administrators manage the biography and equipment prompts under `/api/v1/admin/ai/prompts`. Draft saves, publish and rollback use `expectedRevision`. Rollback creates a new published version from the selected prior version. Preview resolves the template and reports model output as unavailable until a provider is connected.

Customers can request up to three ranked published gigs at `POST /api/v1/event-posts/:id/recommendations` with `{requestKey, expectedRevision, genres?}`. Read saved results at `GET /api/v1/recommendations/:id`. Rankings use the published base price and event brief budget, city, optional genres, published ratings and the saved matching weights. Confirm the booking time through the availability endpoint before booking.

## Prompt model previews

The administrator preview endpoint `POST /api/v1/admin/ai/prompts/:key/preview` resolves the template with the supplied fields. Set `generate: true` to request a model suggestion as well. The response includes the rendered template, model status and optional plain-text draft for review.

Enable model previews by configuring the API and its private FastAPI service with the same `AI_INTERNAL_TOKEN` (32 random bytes encoded as hex). Set `AI_PREVIEW_PRIMARY_PROVIDER` to `openai` (default) or `gemini`. Configure the selected provider's API key and structured-output model in FastAPI with `AI_OPENAI_API_KEY` and `AI_OPENAI_MODEL`, or `AI_GEMINI_API_KEY` and `AI_GEMINI_MODEL`.

Set `AI_PREVIEW_FALLBACK=true` and configure both providers to permit a second attempt after an explicit HTTP 429. The same template and fields may then be sent to both providers. Both attempts share an eight-second deadline. Refusals, timeouts, incomplete results and other provider errors end the preview. The API uses a shared 24-hour Redis counter (`AI_PREVIEW_DAILY_LIMIT`, default 20 submitted previews). Each attempt requests a maximum of 450 output tokens and supplies no tools.

Provider-reported usage and template source are recorded in PostgreSQL per attempt. Draft, inline and published templates are traced separately. Preview output requires review before copying into a listing. Equipment prompts direct the model to omit unverified technical claims.

## Artist writing suggestions

Verified artist accounts can request a biography at `POST /api/v1/ai/generations/bio` with `requestKey` and `fields` containing `artist_name`, `genres` and `event_type`. For a gig title and description, use `POST /api/v1/ai/generations/gig` with `artist_name`, `performance` and `event_type`. Each request uses the latest published template at acceptance. The result can be retrieved by its owner from `GET /api/v1/ai/generations/:id`. Artists review and copy suggestions into their own drafts before saving.

Supply a fresh UUID for each intended generation. Reuse that key and the same fields to recover the existing result after a network interruption. Pending results stay processing for up to 30 seconds. User input fields are sent to the configured provider as data. The job retains a request fingerprint, the suggested text, the prompt version and links to usage records. The rolling 24-hour limits are five requests per artist and `AI_GENERATION_DAILY_LIMIT` (default 20) across all artists. Configured provider fallback follows the same rules as administrator previews.

## Equipment specification suggestions

Administrators review source documents and approve each manufacturer/model reference with `POST /api/v1/admin/equipment-spec-sources`. Supply `manufacturer`, `model`, `specs`, an HTTPS `url`, a document `title` and an optional `locator` such as the page number. Use listing-format values for wattage, SPL, frequency and weight. One reference can be active per manufacturer and model. List references with the admin GET route and retire a reference with `POST /api/v1/admin/equipment-spec-sources/:id/retire` and a reason.

Verified renters can submit `requestKey`, `model` and optionally `manufacturer` to `POST /api/v1/ai/generations/equipment-specs`. The backend compares the full model name after case and whitespace normalization. An ambiguous or unknown match returns empty specs. Matching suggestions include a source citation and can be reopened by their owner at `GET /api/v1/ai/generations/:id`. After retirement, saved suggestions retain the citation and return `withdrawn` with empty specs. Reuse the request key to reopen a lookup or use a fresh one to check the current catalog. Renters review suggestions and save applicable values through the existing listing editor. The lookup uses approved catalog records and has a rolling limit of 30 new searches per renter over 24 hours.

## Published gig embeddings

Set `AI_EMBEDDING_MODEL` to `text-embedding-3-small` or `text-embedding-3-large` on both the API and private FastAPI service. Configure the shared `AI_INTERNAL_TOKEN` and set `AI_OPENAI_API_KEY` on FastAPI. The API requires `AI_SERVICE_ORIGIN` in host development. Indexing is disabled by default. The shared 24-hour quota defaults to 20 provider requests through `AI_EMBEDDING_DAILY_LIMIT`.

Verified administrators can send `POST /api/v1/admin/ai/listing-embeddings/:gigId` with the current published `expectedVersion` and the normal origin and CSRF headers. The provider receives the public title and description. Repeating an in-progress or completed request returns its status. An expired attempt can be retried after 30 seconds. `GET` on the same path reports the state for the currently published version and configured model. Vectors remain in PostgreSQL. Recommendations use the weighted catalog by default.

## Semantic recommendations

Set `AI_SEMANTIC_RECOMMENDATIONS=true` on the API to allow an opt-in request. Send `useSemantic: true` with a new recommendation request key to authorize sending the current private brief title and description to the configured OpenAI embedding model. Brief requirements and account data stay in StageLink. Repeating a request key reuses its saved result and requires the same opt-in setting. If the first request is still running, the API returns `RECOMMENDATION_PROCESSING` and the caller can retry with the same key.

The API applies the original budget, publication, provider approval and full-day blackout checks before scoring up to 30 weighted candidates. When at least two candidates have compatible embeddings for their current published revision, it blends the weighted catalog score (70%) with nonnegative cosine similarity (30%). Candidates without an embedding retain their weighted score. Insufficient coverage, provider failure and exhausted quotas return weighted results. Rankings remain based on the published weight revision recorded with each run. The semantic result records the embedding model and formats plus candidate scores and listing embedding attempts. The run stores neither the query vector nor another copy of the brief text.

Semantic calls are limited to five per customer per 24 hours and `AI_SEMANTIC_DAILY_LIMIT` across customers (default 20). The feature defaults to off. The deterministic `semantic-ranking.test.ts` evaluation compares reciprocal ranks on three labeled synthetic briefs. Representative catalog evaluation and a live model smoke test remain part of staging verification.

## Provider verification

Providers submit two to five validated private images or PDFs with `POST /api/v1/verification-cases`. Upload them with purpose `verification`, then pass their asset IDs in the case. Providers read their own history at `GET /api/v1/me/verification`. Administrators review pending cases at `GET /api/v1/admin/verification-cases` and record a reasoned decision at `POST /api/v1/admin/verification-cases/:id/decisions`. A rejected provider can submit a new version.

The worker renders each PDF page and reconstructs the download from the resulting images. The rendered copy preserves the visible pages. Embedded text, interactive content and digital signatures are discarded. The PDF download uses a short-lived asset capability checked at download time. The owner can access their copy. A verified administrator can access the copy while it is attached to a pending verification case. The original remains in private asset storage under the existing retention rules.

## Support cases

Members create and read their own cases through `POST /api/v1/cases` and `GET /api/v1/me/cases`. Use the case replies endpoint for the shared conversation. Administrators use `/api/v1/admin/cases` for the queue, replies, private notes, assignment and status changes. Validated private images use upload purpose `support`.

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

## Booking disputes

Booking participants can open a dispute at `POST /api/v1/bookings/:id/disputes` and attach private images uploaded with purpose `evidence`. Administrators review the case and eligible service balance under `/api/v1/admin/disputes`. A dismissal releases the dispute hold. A financial decision requires the reviewed balance and reserves the sandbox refund, fee and provider amounts atomically. `GET /api/v1/arbitrations/:id` reports the reservation as `awaiting_gateway`.

## Booking reminders

Set `BOOKING_EMAIL_REMINDERS=true` to have the worker queue and send email reminders for eligible bookings. Development Compose uses Mailpit. Administrators can inspect and manage rows at `/api/v1/admin/reminders`. SMTP acceptance means the receiving server accepted the message. An unknown send outcome requires reconciliation before any resend.

Members list notifications at `GET /api/v1/me/notifications` and mark a notification read with `PUT /api/v1/me/notifications/:id/read`. The worker materializes notifications from booking and support outbox events. `PATCH /api/v1/me/notification-preferences` updates the booking reminder email preference using the revision returned by the corresponding GET.

For live inbox updates, send `notifications:subscribe` with `{}` on the authenticated Socket.IO connection, wait for the acknowledgment, then load the inbox over REST. On `notifications:changed`, a signal with payload `{}`, reload the list and unread count. Redis Pub/Sub fans out signals to API replicas after database commits. Reconnect, subscribe again and reload to recover missed changes. Keep the REST inbox available during broker outages and reload periodically while the inbox is open.

## Administrator system controls

Read maintenance state at `GET /api/v1/system/public-status`. Administrators use `PUT /api/v1/admin/system/maintenance` with the current revision, an enabled flag and a reason. While enabled, new business writes receive `503 MAINTENANCE_MODE`. Reads, sign-in, account recovery, payment callbacks, and these recovery controls remain available. Background workers continue running.

Administrators list and schedule announcements under `/api/v1/admin/announcements`. Publishing or unpublishing refreshes the public announcement cache. `POST /api/v1/admin/cache/invalidate` accepts the `public_announcements` scope. `POST /api/v1/admin/sessions/revoke` accepts one user ID and an optional session ID. `GET /api/v1/admin/audit` lists recorded control changes.

## Promotional campaigns

Members manage opt-in with `GET` and `PUT /api/v1/me/marketing-preferences`. Consent applies to the verified address at the time of opt-in and is independent of booking reminders. Administrators create campaigns under `/api/v1/admin/campaigns`. Preview returns the eligible recipient count and an audience fingerprint to submit with a schedule. The recipient cap is 100 per campaign. Scheduled rows are stored for the future delivery worker.

## Analytics

Administrators use `GET /api/v1/admin/analytics`. Providers use `GET /api/v1/me/analytics` for their own bookings. Both accept `from` (inclusive) and `to` (exclusive) as UTC calendar dates, defaulting to 30 days through the current UTC day. The maximum range is 366 days. Booking requests, agreements, cancellations and verified completions count on the dates those events occurred. The administrator view includes new user registrations. These operational counts are independent of the payment environment.

Financial activity uses the journal posting date and accepts `currency=LKR` and `environment=sandbox|live`. Amounts are decimal strings in minor units. Service capture is the successfully posted booking payment total before refunds and fees. Deposits and captures posted for reconciliation appear separately. Refund, payout and fee reservations show newly reserved amounts in the period. In sandbox reports, `settled.refundedMinor` includes confirmed Stripe test and PayHere sandbox refunds posted in the period and is also available for each UTC day. Refund reservations count under `money.refundReservedMinor` when posted.

Sandbox `settled.paidOutMinor` and `settled.feeRevenueMinor` report net bank payouts and platform fees from posted Stripe test bank settlement journals. A compensating journal reduces the totals on its own posting date, so a day or period can show a negative amount. An empty sandbox period reports zero. Provider reports include only their own bookings. Live financial activity and settlement amounts return `null` pending supported provider execution.
