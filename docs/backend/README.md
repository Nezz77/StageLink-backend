# StageLink backend

Backend development stays on `backend` in the [StageLink repository](https://github.com/Nezz77/StageLink/tree/backend). See the [whole-backend plan](StageLink-Backend-Implementation-Plan.md), [backlog](backend-backlog.json), [coverage](UI-Backend-Coverage.csv), [foundation decisions](ADR-001-foundation.md), [account decisions](ADR-002-accounts.md), and [progress](PROGRESS.md).

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

The local Compose stack includes persistent S3Mock on loopback port 59090 (test: 59091). Host configuration uses `MEDIA_DRIVER=local-s3`, `S3_BUCKET=stagelink-media`, `S3_REGION=us-east-1` and `S3_ENDPOINT=http://127.0.0.1:59090`. Production must use `MEDIA_DRIVER=aws`, the intended private bucket/region and the AWS credential chain; do not use the emulator for real hosted evidence. Live AWS has not been configured/tested. FFmpeg/FFprobe are required for the host worker/tests and included in the backend image. CI installs them explicitly.

Images: JPEG/PNG/WebP ≤8 MiB and 16 MP. Artist audio: MP3/WAV ≤20 MiB. Artist video: MP4/WebM ≤40 MiB. Audio/video ≤10 minutes, with actual previews up to 30 seconds. PDF/SVG/archive/executable formats are not accepted. See [ADR 004](ADR-004-media.md) for processing, retention, capability and future business-reference boundaries.

## PayHere sandbox

Set `PAYHERE_SANDBOX_MERCHANT_ID`, `PAYHERE_SANDBOX_MERCHANT_SECRET`, and `PAYHERE_SANDBOX_NOTIFY_URL` together. Use the sandbox merchant details and a publicly reachable HTTPS endpoint at `/api/v1/payments/webhooks/payhere`. With all three settings empty, checkout is disabled.

The booking customer creates an advance or deposit order and requests a hosted checkout session. Submit the returned fields to its sandbox action URL. After returning, fetch the payment order to see the state recorded from the verified callback. Expired or ambiguous outcomes require reconciliation before a new attempt. Balance collection opens after the provider reports completion. See the [PayHere Checkout API](https://support.payhere.lk/api-%26-mobile-sdk/checkout-api).

## Stripe test Checkout

Set `STRIPE_TEST_SECRET_KEY` and `STRIPE_TEST_WEBHOOK_SECRET` together to enable Stripe test Checkout. Configure the test webhook endpoint at `/api/v1/payments/webhooks/stripe` for `checkout.session.completed`, `checkout.session.expired`, `checkout.session.async_payment_succeeded`, and `checkout.session.async_payment_failed`. Use a public HTTPS endpoint for delivery from Stripe. See [Stripe webhooks](https://docs.stripe.com/webhooks).

The booking customer sends `{}` to `POST /api/v1/payment-orders/:id/sessions/stripe` for an eligible advance, deposit or balance order and opens the returned URL. Advance and deposit sessions require more than 30 minutes before the booking starts. Fetch the payment order after returning for the state recorded by the webhook. Each order stays with the first gateway selected. Expired or ambiguous attempts require reconciliation before replacement. Test account LKR support, actual webhook delivery and Connect settlement still need verification.

## Booking completion

Booking participants can read `GET /api/v1/bookings/:id/journey`. The provider submits `{"confirmed":true}` to the booking's `check-ins` route during its scheduled window and to its `completion` route after the scheduled and approved overtime end. Both require a paid advance. A check-in records the provider's manual confirmation. Either gig participant can propose overtime after check-in, and the other participant must resolve the proposal before completion.

After the completion report, the customer can open a balance payment order for the original price plus approved overtime less the paid advance. A separate admin verification records the reviewer, time and reason. Completion and verification leave settlement to the payout workflow.

## Cancellations and refund review

The customer can cancel an unpaid upcoming booking using `POST /api/v1/bookings/:id/cancellations` or request a refund review for captured funds using `POST /api/v1/bookings/:id/refund-requests`. Both take a reason. Administrators review pending requests at `GET /api/v1/admin/refund-requests` and submit a decision and reason to `POST /api/v1/admin/refund-requests/:id/decisions`. Approval reserves sandbox funds by payment and remains pending gateway execution. A gateway-confirmed refund is required to close a paid booking through this flow.

## Payout reservations

Providers can read `GET /api/v1/me/earnings`. Administrators can read `GET /api/v1/admin/payments` and submit `{expectedRevision, held, reason}` to `POST /api/v1/admin/bookings/:id/holds`. Use hold revision `0` for a booking without a prior hold.

`POST /api/v1/admin/payouts` takes `{bookingId, destinationRevision}` and reserves the sandbox service funds once. It requires administrator-verified completion, paid service orders and the current approved destination. `GET /api/v1/payouts/:id` is scoped to the provider and administrators. A reservation status of `review_required` signals a hold, destination change or payment review. Provider submission and reconciliation remain pending.

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

## Provider verification

Providers submit two to five validated private images with `POST /api/v1/verification-cases`. Upload them with purpose `verification`, then pass their asset IDs in the case. Providers read their own history at `GET /api/v1/me/verification`. Administrators review pending cases at `GET /api/v1/admin/verification-cases` and record a reasoned decision at `POST /api/v1/admin/verification-cases/:id/decisions`. A rejected provider can submit a new version.

## Support cases

Members create and read their own cases through `POST /api/v1/cases` and `GET /api/v1/me/cases`. Use the case replies endpoint for the shared conversation. Administrators use `/api/v1/admin/cases` for the queue, replies, private notes, assignment and status changes. Validated private images use upload purpose `support`.

## Booking disputes

Booking participants can open a dispute at `POST /api/v1/bookings/:id/disputes` and attach private images uploaded with purpose `evidence`. Administrators review the case and eligible service balance under `/api/v1/admin/disputes`. A dismissal releases the dispute hold. A financial decision requires the reviewed balance and reserves the sandbox refund, fee and provider amounts atomically. `GET /api/v1/arbitrations/:id` reports the reservation as `awaiting_gateway`.

## Booking reminders

Set `BOOKING_EMAIL_REMINDERS=true` to have the worker queue and send email reminders for eligible bookings. Development Compose uses Mailpit. Administrators can inspect and manage rows at `/api/v1/admin/reminders`. SMTP acceptance means the receiving server accepted the message. An unknown send outcome requires reconciliation before any resend.
