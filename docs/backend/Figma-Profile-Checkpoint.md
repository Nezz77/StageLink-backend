# P03 profile design checkpoint

Final verification: 2026-11-03. Source: persistent React profile workspace, using StageLink Geist/Fraunces typography, existing local button/input masters and color tokens.

- [Editable design](https://www.figma.com/design/T5OZJHgSNwPIXYwHnM85yj/StageLINK?node-id=516-80666)
- [Wireframes](https://www.figma.com/design/T5OZJHgSNwPIXYwHnM85yj/StageLINK?node-id=517-23856)
- [Prototype](https://www.figma.com/proto/T5OZJHgSNwPIXYwHnM85yj/StageLINK?page-id=60%3A1117&node-id=517-138200&starting-point-node-id=517%3A138200&scaling=scale-down)

Each contains 15 states, including mobile and light contact views, artist/renter applications, masked bank destination, review and email confirmation outcomes. The prototype has 59 valid native connections and four starting flows. It simulates outcomes; the local website executes the APIs.

The final layout uses width-specific editable field components, avoiding unsupported nested-instance geometry overrides. All rendered field text boxes have their expected widths. Final artist, contact wireframe and review prototype screenshots were inspected after this repair. No rasterized UI fills were found. Full node mappings and final geometry checks are in `figma-profile-mapping.json`. Earlier frontend/account journeys remain intact.
