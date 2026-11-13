# StageLink backend

- Server code lives in `backend/api`, `backend/worker`, `backend/shared`, and `backend/ai`.
- Keep migrations under `backend/prisma/migrations`. Add new migrations for schema changes and leave applied migrations intact.
- Run the Node toolchain from `backend/`. Regenerate the API contracts after changes to routes or schemas.
- See `README.md` and `docs/backend/README.md` for local services and validation.

## StageLink design handoff

- When a StageLink UI change is made, update the corresponding screens and interaction flows in the StageLink Figma project as part of the same task. Record any Figma update that remains pending.
