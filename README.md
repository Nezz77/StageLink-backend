# StageLink backend

Backend changes go through feature branches and pull requests into `main` in [Nezz77/StageLink-backend](https://github.com/Nezz77/StageLink-backend). Frontend development lives in [Nezz77/StageLink](https://github.com/Nezz77/StageLink).

## Current status

On 28 November 2026, **116 of 127 backend build checklist items were complete (91.3%)**. The verified `main` build at `b5abf9a` passed 90 Node unit tests, 44 integration tests, 21 Python tests, the PostgreSQL restore drill, contract validation, and both container builds. Hosted provider checks, remaining frontend integration, and release sign-off are open. [GitHub build](https://github.com/Nezz77/StageLink-backend/actions/runs/46133760621) · [Completion checklist](docs/backend/StageLink-Completion-Backlog.md)

StageLink uses a layered architecture. The core is a modular NestJS REST API, with a separate BullMQ worker process and an internal FastAPI service. Prisma connects the Node services to PostgreSQL, Redis backs the queue and rate limiting, and an S3 adapter stores media. The private FastAPI service exposes health checks and supports opt-in model previews, artist writing suggestions and public gig embeddings.

| Path | Responsibility |
| --- | --- |
| `backend/api/` | REST and Socket.IO for accounts, listings, bookings, payments, support, and administration |
| `backend/worker/` | Background jobs and transactional outbox dispatch |
| `backend/shared/` | Configuration, database and Redis access, mail, and storage |
| `backend/prisma/` | PostgreSQL schema and migrations |
| `backend/ai/` | Internal FastAPI service |
| `contracts/`, `packages/contracts/` | OpenAPI schema and generated transport types |
| `infra/` | Local backend and integration-test services |

From the repository root, using the Node version in `backend/.node-version` and Docker Compose:

```sh
node backend/scripts/setup-env.mjs
docker compose --env-file infra/.env -f infra/compose.backend.yml up --build -d --wait
```

The API listens on [port 4000](http://localhost:4000/api/v1/health/ready). Open [API documentation](http://localhost:4000/api/docs) or the [local test inbox](http://127.0.0.1:8025).

See the [backend setup guide](docs/backend/README.md), [implementation plan](docs/backend/StageLink-Backend-Implementation-Plan.md), [build history](docs/backend/PROGRESS.md), and [architecture decisions](docs/backend/ADR-001-foundation.md).
