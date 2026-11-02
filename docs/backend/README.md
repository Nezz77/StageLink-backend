# StageLink backend

Development stays on `backend` in the same [StageLink repository](https://github.com/Nezz77/StageLink/tree/backend). GitHub's `frontend` branch remains the original UI baseline. See the [whole-backend plan](StageLink-Backend-Implementation-Plan.md), [backlog](backend-backlog.json), [coverage](UI-Backend-Coverage.csv), [foundation decisions](ADR-001-foundation.md), [account decisions](ADR-002-accounts.md), and [progress](PROGRESS.md).

P01 infrastructure and P02 accounts are implemented. Account creation, sign-in, verification, recovery, assigned-role selection and sign-out use PostgreSQL. Catalog content remains a labeled preview. Profiles, verification approval, uploads, bookings, chat and payments become persistent in their scheduled phases. Public artist/renter registration does not approve a provider to publish or receive payouts.

## Start locally

Use Node 24.22.1 and Docker. From the repository root:

```sh
node backend/scripts/setup-env.mjs
docker compose --env-file infra/.env -f infra/compose.backend.yml --profile web up --build -d --wait
```

Setup creates ignored configuration files with separate random signing/encryption keys. It fills missing settings and preserves valid existing keys and custom values. Do not copy an example over an existing `.env`. If setup reports mismatched existing keys, align the intended configuration explicitly; it does not rotate them silently. Database passwords in these defaults are for this loopback development stack only.

- Website and real account forms: [localhost:3000](http://localhost:3000).
- API docs through the same origin: [localhost:3000/api/docs](http://localhost:3000/api/docs).
- Local verification/recovery inbox: [127.0.0.1:8025](http://127.0.0.1:8025). Mailpit captures mail locally; it does not deliver to external inboxes.
- API health: [localhost:4000/api/v1/health/ready](http://localhost:4000/api/v1/health/ready).

Host ports bind loopback: website 3000, API 4000, PostgreSQL 55432, Redis 56379, Mailpit 8025/1025. AI has no public port. Migrations must succeed before API/worker start. No accounts or business records are seeded automatically.

Create an account through the website, open its verification message in Mailpit, then follow the link or paste its one-time code. Use `localhost:3000` consistently: mutations require the exact configured browser origin. Registration returns the same acceptance message for new and existing addresses and never overwrites an existing password.

Stop while retaining database/Redis volumes:

```sh
docker compose --env-file infra/.env -f infra/compose.backend.yml down
```

This is a local development configuration, not a production deployment.

## Host development

Backend uses npm independently from the pnpm frontend:

```sh
node backend/scripts/setup-env.mjs
docker compose --env-file infra/.env -f infra/compose.backend.yml up -d postgres redis mailpit
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

Root `.env.local` enables API mode and the Vite `/api` proxy. If developing at another website origin, set `WEB_ORIGIN` to that exact origin and restart API/worker processes. Docker reads `infra/.env`; host processes use the explicitly loaded `backend/.env`. Matching keys are required when using both.

API mode is the default on this branch. `VITE_AUTH_MODE=demo` explicitly builds the earlier frontend demonstration, including simulated recovery and sample workspaces. API mode never falls back to a demo identity on errors and never opens sample private dashboards as a real account. Demo mode must not be used as an authentication substitute.

## Validation

```sh
cd backend
npm run db:generate
npm run typecheck
npm test
npm run contracts
cd ..
pnpm typecheck
pnpm test
pnpm build
sh backend/scripts/check-integration.sh
```

Integration uses a separate Compose project, `stagelink_test`, PostgreSQL 55433, Redis 56380 and Mailpit 11025/18025. Tests reject non-test database names and remove only their own rows/jobs/Redis namespace. They do not truncate shared tables or flush Redis. Coverage includes migrations, outages, worker restart and duplicate delivery; accounts also test separate users, privilege rejection, rotation/replay, actual SMTP capture, single-use/expired tokens, password replacement and session revocation.

Tests need permission to listen on a temporary HTTP port. Credential mutation is exercised through real HTTP integration tests; browser QA covers forms, login, reload, role selection, sign-out, errors and responsive themes.

Generated contracts are `contracts/openapi.json` → `packages/contracts/src/api.d.ts`. Regenerate and commit both after endpoint changes; CI rejects drift. Never edit an applied migration. Update the expected migration constant when adding one.

AI remains health-only. Under `backend/ai`, use Python 3.12 / uv 0.11.29, `uv sync --frozen`, then `uv run --frozen pytest -q`. No model/provider is configured.

## Controlled administrator creation

There is no public administrator signup or default password. With database configuration loaded, an operator can create a new administrator using the compiled CLI. Pipe a 12–128 character password from a protected source, such as an approved password manager's stdout, into:

```sh
npm run --silent admin:create -- --email administrator@example.com --name 'StageLink Administrator'
```

The command refuses terminal password input and refuses to overwrite any account. It prints only the new user ID. Replace the example address with the intended administrator. Setup/tests create no real administrator. Provider approval and admin-management screens remain separate backlog work.
