# Cursor synchronization fixtures

These fixtures are synthetic and contain no captured user content.

- `*.actions.json` preserves representative v1/v2 sidecar input.
- `*.normalized.json` freezes the approved normalized contract for Phase 1.
- `recording-scenarios.json` provides deterministic observation sequences for
  readiness, layout shift, pause, and decoder-stall regressions.

Phase 0 only validates fixture integrity and records the legacy scheduling bug.
The shared parser introduced in Phase 1 owns executable raw-to-normalized
golden assertions.
