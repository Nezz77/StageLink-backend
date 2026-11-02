# P02 account design checkpoint

The account backend introduces separate persistent-account screens while preserving the earlier frontend demonstration.

- [Editable UI screens](https://www.figma.com/design/T5OZJHgSNwPIXYwHnM85yj/StageLINK?node-id=504-6267): 18 states on Public & authentication.
- [Wireframes](https://www.figma.com/design/T5OZJHgSNwPIXYwHnM85yj/StageLINK?node-id=505-23872): 18 states on Wireframes.
- [Interactive account flow](https://www.figma.com/proto/T5OZJHgSNwPIXYwHnM85yj/StageLINK?page-id=60%3A1117&node-id=509-118195&starting-point-node-id=509%3A118195&scaling=scale-down): 18 states, 80 native Figma reactions, four named starting flows.

Covered states: sign-in, registration, accepted registration, invalid credentials, artist/customer account views, verification requested/code/success, verified account, recovery email/code/new password/completion, service unavailable, light account, mobile account and mobile sign-in. Clickable transitions demonstrate these outcomes; Figma does not run the account API, accept live credentials or send email.

Use Figma's Prototype tab to view the connection wires. The screen IDs, destinations, counts and zero-broken-destination audit are in `figma-auth-mapping.json`. Screens are native editable text, component instances, auto-layout and SVG icons, with no screenshot-filled UI layers. Existing StageLink button masters and color variables are reused. The new input is a reusable local component. Source Geist Variable maps to Figma Geist; display titles use Fraunces.

`figma-auth-builder.js` is a record of the initial Plugin API composition, not a browser or Node program. Before running it through `use_figma`, replace **all** `__AUTH_ICONS__` placeholders with the JSON from `figma-auth-icons.json` (SVGs rendered from the application's Lucide components). It guards against duplicate initial creation. Use existing IDs for subsequent edits rather than rerunning the initial builder. Wireframes and prototype were subsequently cloned from these editable screens and wired natively; the mapping is the authoritative final result.

Inspected browser and Figma previews are under `outputs/stagelink-auth-checkpoint-2026-11-02`. Browser QA used a disposable local `.test` account, which was signed out and removed after verification. No real user data or account secrets are included.
