# Manufacturer reference bundle

P15 / BE-031. The bundle contains 12 reviewed models. A verified administrator previews and approves the references before renters can use them in equipment lookup. Staging approval is tracked in the completion backlog.

| Manufacturer | Exact model | Facts available |
| --- | --- | --- |
| Yamaha | DXR15mkII | Dynamic output 1100 W, max SPL 134 dB, range 49 Hz–20 kHz at -10 dB, net weight 21.8 kg |
| Yamaha | DXR12mkII | Dynamic output 1100 W, max SPL 134 dB, range 52 Hz–20 kHz at -10 dB, net weight 18.6 kg |
| Yamaha | DXR10mkII | Dynamic output 1100 W, max SPL 132 dB, range 56 Hz–20 kHz at -10 dB, net weight 13.9 kg |
| Yamaha | DXR8mkII | Dynamic output 1100 W, max SPL 130 dB, range 57 Hz–20 kHz at -10 dB, net weight 12.8 kg |
| CHAUVET DJ | Intimidator Spot 160 ILS | Net weight 3.8 kg |
| CHAUVET DJ | Intimidator Spot 160 | Net weight 4.0 kg |
| Shure | SM58 | Frequency response 50 Hz–15 kHz, weight 0.33 kg |
| Shure | SM57 | Frequency response 40 Hz–15 kHz |
| Yamaha | DBR10 | Peak SPL 129 dB, range 55 Hz–20 kHz at −10 dB, net weight 10.5 kg |
| Yamaha | DBR12 | Peak SPL 131 dB, range 52 Hz–20 kHz at −10 dB, net weight 15.8 kg |
| Yamaha | DBR15 | Peak SPL 132 dB, range 50 Hz–20 kHz at −10 dB, net weight 19.3 kg |
| QSC | K12.2 | Maximum rated SPL 132 dB, response 50 Hz–20 kHz at −6 dB, net weight 17.7 kg |

Sources reviewed on 20 November 2026. [Yamaha DXR mkII specifications](https://europe.yamaha.com/en/audio/portable-pa/products/speakers/dxr/specs.html), [Yamaha DBR specifications](https://data.yamaha.com/files/download/other_assets/4/332514/VHN5580_DBR15_TS_En_B0_views.pdf), [CHAUVET DJ Spot 160 ILS](https://www.chauvetdj.com/products/intimidator-spot-160-ils/), [CHAUVET DJ Spot 160](https://www.chauvetdj.com/products/intimidator-spot-160/), [Shure SM58 guide](https://www.shure.com/en-US/docs/guide/sm58), [Shure SM57 guide](https://www.shure.com/en-US/docs/guide/SM57), [QSC K.2 manual, page 22](https://www.qsc.com/resource-files/productresources/spk/k.2/q_spk_k2_usermanual.pdf).

The DXR mkII dynamic rating is 1100 W and its continuous rating is 700 W. The original DXR models have different specifications and require their own references. The DBR series peak SPL uses IEC noise at one metre. The two CHAUVET DJ references supply net weight. The SM57's published weight of 0.284 kg exceeds the current field precision and is left unset. Owners set package inclusions, deposits and rental rates for their own listings.

## Preview and approve

`GET /api/v1/admin/equipment-spec-sources/reference-bundle` requires a verified administrator. It returns the version, review date, SHA-256 digest, values, source citation, qualification notes and the current `new`, `approved`, `conflict` or `retired` state for each model.

`POST /api/v1/admin/equipment-spec-sources/reference-bundle/approve` requires the same administrator role plus the normal Origin and CSRF checks. Send the digest returned by preview and optionally `models`, an array of distinct exact model names from the bundle. Omitting `models` selects all 12. The API rejects empty selections, duplicate or unknown model names, and extra body fields. A changed digest returns `409 REFERENCE_BUNDLE_CHANGED` and requires a new review.

Approval is atomic. A conflicting active reference or retired selected model returns `409 REFERENCE_BUNDLE_CONFLICT` with no rows saved. Resolve these records through the individual reference workflow. An identical active reference keeps its ID and original approving administrator. PostgreSQL serializes bundle approval, individual approval and retirement.

After approval, the existing renter endpoint `POST /api/v1/ai/generations/equipment-specs` returns exact-model factual suggestions and their database citation. Unknown models remain empty; retired sources remain withdrawn on saved jobs. No external model call is needed and no arbitrary manufacturer URL is fetched by the server.

## Validation

The integration scenario exercises administrator access, verification, Origin and CSRF checks, stale digests, invalid selections, atomic conflicts, retirement preservation and concurrent approval. It checks all 12 exact model lookups and confirms that the original DXR15 needs its own reference.

Repeated local suite runs also exposed fixed mock gateway refund IDs colliding with the test database's retained immutable journal. The refund integration fixture now generates unique provider refund IDs per run while preserving retry/reconciliation assertions. No production payment behavior changes, and no journal records are deleted to make tests pass.

Local validation on 20 November 2026: 53 Node unit tests, all 27 PostgreSQL/Redis/Mailpit/S3Mock integration scenarios, TypeScript compilation, API contract generation and `git diff --check` passed. The migration deployment was repeated safely. No staging catalog was populated and no merchant request was sent; integration used disposable accounts and mocked gateway responses.
