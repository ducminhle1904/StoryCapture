# Phase 15 — Pre-answers from the add-phase prompt

The user answered the three open questions posed in the Phase 15 sketch when invoking `/gsd-add-phase 15`. These are locked inputs for `/gsd-discuss-phase 15` — do not re-ask.

**Q1. Is authoring-time validation (LSP + DryRun + SelectorValidator) sufficient, or does Editor need a visual preview?**
A1. *"sufficient, Editor need a visual preview too"* — LSP/DryRun/SelectorValidator are the primary authoring-time feedback, **AND** Editor still keeps a visual preview. Both coexist.

**Q2. Do we want a "Send to Post-Production" affordance in Editor after a successful recording? Explicit handoff or implicit?**
A2. *"i want it"* — **explicit** "Send to Post-Production" affordance after a successful recording. Likely a toolbar button or prompt on recording completion.

**Q3. Should Post-Production be reachable before any recording exists (empty-state) or gated?**
A3. *"empty-state"* — Post-Production is **always reachable**; renders an empty-state when no recordings exist. Not gated.

## Implications for Phase 15 planning

- **Preview decision (Gray area 1):** Both routes keep a preview. Options (a) two distinct components or (b) one shared `PreviewSurface` with mode prop are still open. Option (c) "Editor drops preview" is eliminated by Q1.
- **Recorder route (Gray area 2):** Still open — standalone vs folded-into-Editor.
- **Workflow direction (Gray area 4):** **Freeform** — Q3 rules out strict-linear gating.
- **New UI element needed:** "Send to Post-Production" affordance in Editor (Q2). Small visible button/toast on recording completion.
- **New UI element needed:** Post-Production empty state (Q3). Currently Post-Production requires a storyId in the URL; an index/landing view may be required.
