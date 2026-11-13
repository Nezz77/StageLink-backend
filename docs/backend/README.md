# StageLink backend

Backend development stays on `backend` in the [StageLink repository](https://github.com/Nezz77/StageLink-Frontend/tree/backend). See the [whole-backend plan](StageLink-Backend-Implementation-Plan.md), [backlog](backend-backlog.json), [coverage](UI-Backend-Coverage.csv), [foundation decisions](ADR-001-foundation.md), [account decisions](ADR-002-accounts.md), and [progress](PROGRESS.md).

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
