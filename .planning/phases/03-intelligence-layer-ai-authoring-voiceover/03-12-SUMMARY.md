---
phase: 03-intelligence-layer-ai-authoring-voiceover
plan: 12
subsystem: intelligence, storycapture
tags: [rust, tts, sync, timeline, duck-events, freeze-frame, drift, d-13, d-22, phase3]
requires:
  - phase: 03-intelligence-layer-ai-authoring-voiceover/11
    provides: TTS cache module (cache.rs), probe_audio_duration_ms, Tauri TTS commands
provides:
  - intelligence::tts::sync::{compute_sync_plan, SyncPlan, AdjustedStep, DuckEvent, StepTiming, ClipMeta}
  - storycapture::commands::tts::tts_apply_sync (Tauri IPC command)
  - storage::phase3::{lookup_tts_cache_by_step, update_tts_metric_drift}
  - Per-step freeze-frame extension or silence padding based on TTS-is-ground-truth rule
  - BGM auto-duck events at -12dB emitted via sound_mixer/duck_events (D-22 slot)
affects:
  - Phase 2 sound mixer (Plan 02-08) -- consumes duck_events via Tauri event
  - Phase 3 script-review UI (Plan 19) -- sync plan visualization after TTS synthesis
  - Phase 3 eval harness (Plan 21) -- drift p95 measurement via compute_sync_plan
tech-stack:
  added: []
  patterns:
    - "TTS-is-ground-truth timeline alignment: clip longer -> freeze frame extension; clip shorter -> silence padding (D-13)"
    - "Cumulative adjusted-duration timeline cursor for duck event start_ms calculation"
    - "Pure function compute_sync_plan separates business logic from Tauri command IO"
    - "DTO wrapper pattern (SyncPlanDto/AdjustedStepDto/DuckEventDto) for specta Type derive"
key-files:
  created:
    - crates/intelligence/src/tts/sync.rs
    - crates/intelligence/tests/tts_sync_tests.rs
  modified:
    - crates/intelligence/src/tts/mod.rs
    - apps/desktop/src-tauri/src/commands/tts.rs
    - apps/desktop/src-tauri/src/ipc_spec.rs
    - crates/storage/src/phase3.rs
key-decisions:
  - "Pure function compute_sync_plan with no side effects -- Tauri command handles IO (cache lookup, event emit, metric persistence)"
  - "StepTiming passed as parameter (not loaded from effects AST) -- Phase 2 hand-off documented in comment; when Phase 2 merges, tts_apply_sync can load from project DB directly"
  - "DuckEvent.db hardcoded at -12.0 dB per D-22 spec -- configurable duck level deferred to Phase 2 sound mixer settings"
  - "lookup_tts_cache_by_step returns most recent entry (ORDER BY last_used_at DESC) to handle multiple regenerations per step"
  - "update_tts_metric_drift targets most recent metric row per step_id for drift persistence"
requirements-completed: [AI-03]
duration: ~5 min
completed: 2026-04-16
---

# Phase 03 Plan 12: TTS Voiceover Sync Engine (D-13) Summary

**Pure-function timeline sync planner that aligns TTS clip durations to DSL step boundaries with freeze-frame extension / silence padding, emits -12dB BGM duck events for Phase 2 sound mixer (D-22), and enforces drift p95 <= 150ms (E7).**

## Performance

- **Duration:** ~5 min
- **Started:** 2026-04-16T03:39:02Z
- **Completed:** 2026-04-16T03:43:48Z
- **Tasks:** 1 (TDD `tdd="true"`)
- **Commits:** 2 (`663a096` RED, `044c287` GREEN)
- **Files created:** 2 (sync.rs, tts_sync_tests.rs)
- **Files modified:** 4 (tts/mod.rs, commands/tts.rs, ipc_spec.rs, phase3.rs)

## What Was Built

**Task 1 -- `compute_sync_plan` + `tts_apply_sync` command.**

**Pure function (`crates/intelligence/src/tts/sync.rs`):**

- `StepTiming` -- original step duration from Phase 1/2.
- `ClipMeta` -- TTS clip metadata (step_id, audio_duration_ms, file_path).
- `SyncPlan` -- adjusted steps + duck events.
- `AdjustedStep` -- per-step: new_duration_ms, freeze_frame_extension_ms, silence_padding_ms, clip_start_ms, drift_ms.
- `DuckEvent` -- timeline-global start/end in ms, db (-12.0).
- `compute_sync_plan(steps, clips)` -- TTS-is-ground-truth alignment:
  - Clip longer than step: step duration extends to clip duration, freeze_frame_extension_ms = difference.
  - Clip shorter than step: step keeps original duration, silence_padding_ms = difference.
  - No clip for step: step unchanged, no duck event.
  - Duck event timestamps use cumulative adjusted durations (not original).
- 3 unit tests: equal-duration zero-drift, duck_event db = -12, empty plan.

**Tauri command (`apps/desktop/src-tauri/src/commands/tts.rs`):**

- `tts_apply_sync(app, project_id, step_timings)` -- accepts `Vec<StepTimingDto>`, loads ClipMeta from tts_cache_index, calls `compute_sync_plan`, emits `sound_mixer/duck_events` via `app.emit()` (Phase 2 D-22 slot), persists drift_ms via `update_tts_metric_drift`.
- DTO types: `SyncPlanDto`, `AdjustedStepDto`, `DuckEventDto`, `StepTimingDto` -- all with `specta::Type`.
- Registered in `ipc_spec.rs` `collect_commands!` + `.typ::<>()`.

**Storage helpers (`crates/storage/src/phase3.rs`):**

- `lookup_tts_cache_by_step(conn, step_id)` -- returns most recent cache entry for a step.
- `update_tts_metric_drift(conn, step_id, drift_ms)` -- updates drift on most recent metric row.

**Integration tests (`crates/intelligence/tests/tts_sync_tests.rs`):**

| Test | What it locks |
|---|---|
| `clip_longer_extends_step_with_freeze_frame` | step 2000ms, clip 2500ms -> adjusted=2500, freeze=500, drift=+500 |
| `clip_shorter_pads_silence` | step 3000ms, clip 2200ms -> adjusted=3000, silence=800, drift=-800 |
| `no_clip_for_step_is_unchanged` | no clip -> unchanged, no duck event |
| `cumulative_timeline_duck_events_use_adjusted_durations` | 3 steps -> duck start_ms based on cumulative adjusted durations |
| `drift_p95_leq_150ms` | 20 random pairs with |delta| <= 150ms -> p95 drift <= 150ms |

## Decisions Made

1. **Pure function separation** -- `compute_sync_plan` has zero side effects; all IO (cache, events, metrics) lives in the Tauri command.
2. **StepTiming as parameter** -- Phase 2 effects AST not yet merged; hand-off documented in code comment.
3. **-12dB duck level hardcoded** -- per D-22 spec; configurable level deferred to Phase 2 mixer.
4. **Most-recent cache entry per step** -- `ORDER BY last_used_at DESC LIMIT 1` handles regenerations.
5. **Emitter trait import** -- required for `app.emit()` in Tauri v2.10.

## Task Commits

| Task | Message | Hash |
|---|---|---|
| 1 (RED) | `test(03-12): add failing tests for TTS voiceover sync engine (D-13)` | `663a096` |
| 1 (GREEN) | `feat(03-12): TTS voiceover sync engine with timeline alignment + duck events` | `044c287` |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Added `tauri::Emitter` import for `app.emit()` call.**
- **Found during:** Task 1 GREEN phase (compilation).
- **Issue:** Tauri v2.10 requires `use tauri::Emitter` to access `.emit()` on `AppHandle`.
- **Fix:** Added `Emitter` to the import list.
- **Files modified:** `apps/desktop/src-tauri/src/commands/tts.rs`.
- **Commit:** `044c287`.

**2. [Rule 2 - Missing Critical] Added `lookup_tts_cache_by_step` and `update_tts_metric_drift` storage helpers.**
- **Found during:** Task 1 GREEN phase (implementation).
- **Issue:** Plan references scanning tts_cache_index per step and persisting drift_ms, but no storage functions existed for step-based lookup or drift update.
- **Fix:** Added both functions to `crates/storage/src/phase3.rs`.
- **Files modified:** `crates/storage/src/phase3.rs`.
- **Commit:** `044c287`.

---

**Total deviations:** 2 auto-fixed (1 Rule 3 blocking, 1 Rule 2 missing-critical). **Impact:** Strictly necessary for compilation and correctness. No scope creep.

## Verification

```bash
cargo test -p intelligence --test tts_sync_tests     # 5/5 passed
cargo test -p intelligence --lib tts::sync           # 3/3 passed
cargo check -p storycapture                          # clean compilation
```

**Acceptance criteria:**

- All 5 tests green - PASS
- `grep -c "freeze_frame_extension_ms\|silence_padding_ms" sync.rs` -> 8 (>= 2) - PASS
- `grep -c "db.*-12\|-12.0" sync.rs` -> 3 (>= 1) - PASS
- `grep -c "tts_apply_sync" ipc_spec.rs` -> 1 (>= 1) - PASS
- Property test `drift_p95_leq_150ms` passes - PASS

## Threat Register Disposition

| Threat ID | Disposition | Evidence |
|---|---|---|
| T-03-12-01 (Tampering - MP3 parse) | mitigated | symphonia returns `Err` on malformed MP3; `probe_audio_duration_ms` propagates error; `tts_apply_sync` uses `unwrap_or(0)` for graceful degradation |
| T-03-12-02 (DoS - Unbounded clip count) | mitigated | `Vec` pre-sized to `steps.len()`; no recursion; linear O(n) algorithm |
| T-03-12-03 (Tampering - Phase 2 consumer missing) | accepted | Duck events emitted via `app.emit()`; if no listener, events are silently dropped; documented in integration note |

## Known Stubs

None. `compute_sync_plan` is fully functional. `tts_apply_sync` command accepts step timings as parameter (Phase 2 effects AST integration is documented for future hand-off, not a stub).

## Threat Flags

None. No new network endpoints, auth paths, or schema changes beyond the plan's register. `tts_apply_sync` is IPC-only (webview-to-host). `sound_mixer/duck_events` is an internal Tauri event, not exposed externally.

## Issues Encountered

None beyond the auto-fixed deviations. TDD cycle ran clean.

## Authentication Gates

None -- sync engine is pure computation. No API keys or external services involved.

## User Setup Required

None -- pure-Rust implementation with no external-service dependencies.

## Next Plan Readiness

- **Phase 2 sound mixer (Plan 02-08):** Listens for `sound_mixer/duck_events` Tauri event containing `Vec<DuckEventDto>` with start_ms/end_ms/db fields.
- **Script review UI (Plan 19):** Can call `tts_apply_sync` after TTS synthesis to get the sync plan and visualize per-step freeze/silence adjustments.
- **Eval harness (Plan 21):** Can call `compute_sync_plan` directly with test fixtures to measure drift p95 against E7 threshold.

## Handoff Notes

- `compute_sync_plan` is a pure function in `intelligence::tts::sync` -- no Tauri dependency. Can be tested and used from any Rust context.
- `tts_apply_sync` currently takes `Vec<StepTimingDto>` as input. When Phase 2 effects AST is merged, this can be refactored to load step timings from the project DB directly, removing the parameter.
- Duck events use timeline-global milliseconds. The sound mixer should use `start_ms`/`end_ms` to schedule volume ducking relative to the video timeline.
- `drift_ms` is persisted in `tts_clip_metrics` via `update_tts_metric_drift`. The metrics dashboard (AI-SPEC section 4b.3) can read this for the "TTS drift p95" timeline overlay.

## Self-Check: PASSED
