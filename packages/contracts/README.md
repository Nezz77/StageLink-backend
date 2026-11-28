# API transport contracts

`src/api.d.ts` is generated from the committed [OpenAPI schema](../../contracts/openapi.json). After an API change, run `npm run contracts` in `backend/` and commit both generated files. CI regenerates them and checks for drift. Use the schema from the backend build the frontend connects to.

The 28 November 2026 build passed contract validation at `b5abf9a`. The gig and rental browse response types include `ratingSummary.average` and `ratingSummary.count` from published reviews. [GitHub build](https://github.com/Nezz77/StageLink-backend/actions/runs/46133760621) · [Backend API guide](../../docs/backend/README.md)
