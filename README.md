# StageLink backend

StageLink uses a layered architecture. The core is a modular NestJS REST API, with a separate BullMQ worker process and an internal FastAPI service. Prisma connects the Node services to PostgreSQL, Redis backs the queue and rate limiting, and an S3 adapter stores media. The FastAPI service currently exposes health endpoints.

| Path | Responsibility |
| --- | --- |
| `backend/api/` | REST controllers and account, profile, media, and catalog logic |
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

See [backend setup and verification](docs/backend/README.md), [architecture decisions](docs/backend/ADR-001-foundation.md), and the [completion backlog](docs/backend/StageLink-Completion-Backlog.md).
