---
quick_id: 260501-ku1
status: implemented
started_at: "2026-05-01"
---

# Summary

Phase 2 implementation complete:

- Editor UI pick buttons now use the Preview picker, patch structured step targets, and stamp missing step IDs before persisting picker targets.
- `Record & Polish` preflights story step IDs before routing to recorder polish flow.
- Record & Polish automation writes `<recording>.steps.json` timing sidecars with per-step start/end/duration, step ID, scene, verb, selector, match kind, and target bbox when available.
- Post-Production loads step timing sidecars, uses them to place generated zoom/callout clips, and surfaces review fix-list items for missing or low-confidence timing/trajectory.
- IPC bindings were regenerated from `ipc_spec`.
