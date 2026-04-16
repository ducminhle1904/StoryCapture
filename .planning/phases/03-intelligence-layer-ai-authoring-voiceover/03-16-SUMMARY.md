---
phase: 03-intelligence-layer-ai-authoring-voiceover
plan: 16
subsystem: intelligence
tags: [rust, dryrun, orchestrator, browser-driver, tauri-ipc, abort-handle, phase3]
requirements: [AI-04]
dependency_graph:
  requires:
    - "crates/intelligence (Phase 3 Plan 01 — crate scaffold)"
  provides:
    - "crates/intelligence::dryrun::DryRunOrchestrator + run() function"
    - "crates/intelligence::dryrun::DryRunEvent (6 event kinds)"
    - "crates/intelligence::dryrun::trait_stub (BrowserDriver + ExecStep + StepResult + SelectorAttempt + DriverError)"
    - "storycapture::commands::dryrun::{dryrun_start, dryrun_cancel} Tauri commands"
    - "DryRunTaskRegistry with AbortHandle for cancel support"
  affects:
    - "Phase 1 automation crate — when merged, enable phase1-wired feature flag to swap stub for real BrowserDriver"
    - "Frontend dry-run panel — consume dryrun_start/dryrun_cancel IPC + DryRunEventDto channel"
tech_stack:
  added: []
  patterns:
    - "Trait-stub pattern with cfg(feature) toggle for Phase-1 hand-off"
    - "Global OnceLock registry for abort handles (mirrors CaptureRegistry)"
    - "Channel<DryRunEventDto> for streaming orchestrator events to webview"
key_files:
  created:
    - crates/intelligence/src/dryrun/mod.rs
    - crates/intelligence/src/dryrun/orchestrator.rs
    - crates/intelligence/src/dryrun/trait_stub.rs
    - crates/intelligence/tests/dryrun_orchestrator_tests.rs
    - apps/desktop/src-tauri/src/commands/dryrun.rs
  modified:
    - crates/intelligence/src/lib.rs
    - crates/intelligence/Cargo.toml
    - apps/desktop/src-tauri/src/commands/mod.rs
    - apps/desktop/src-tauri/src/ipc_spec.rs
decisions:
  - "Used local trait stub (BrowserDriver/ExecStep/StepResult/SelectorAttempt/DriverError) rather than depending on crates/automation, gated by phase1-wired feature flag for future swap"
  - "DryRunTaskRegistry uses global OnceLock + parking_lot::Mutex pattern (mirrors CaptureRegistry from commands/capture.rs) rather than Tauri managed state"
  - "StubBrowserDriver in commands/dryrun.rs returns instant success for all steps — placeholder until Phase 1 real driver is wired"
metrics:
  tasks_completed: 2
  tasks_total: 2
  files_created: 5
  files_modified: 4
  completed: 2026-04-16
  duration_minutes: ~4
---

# Phase 03 Plan 16: Dry-Run Orchestrator Summary

Dry-Run orchestrator that drives BrowserDriver through DSL steps without capture/encode, streaming 6 per-step event kinds via mpsc channel, with Tauri IPC commands (dryrun_start + dryrun_cancel) and AbortHandle-based cancellation — tested against a mock driver with 5 integration tests covering happy path, failure stop, selector fallback chain, cancel, and timing.

## What Was Built

**Task 1 -- DryRunOrchestrator + mock driver tests.** Created `crates/intelligence/src/dryrun/` module with three files:

- `trait_stub.rs` -- Local BrowserDriver trait-shape mirroring Phase 1's API (ExecStep, StepResult, SelectorAttempt, DriverError with selector_attempts() accessor). Gated behind `#[cfg(not(feature = "phase1-wired"))]` so it disappears when the real automation crate is wired.
- `orchestrator.rs` -- `run()` async function that iterates steps, emits Queued for all steps up front, then Running/Pass/Fail per step. Stops on first failure (`break`). Emits Summary (total_steps, passed, failed, total_ms) and Done at the end.
- `mod.rs` -- Module root with cfg-gated re-exports: local trait_stub when `phase1-wired` is absent, `automation::*` when present.

Added `phase1-wired` feature flag to `crates/intelligence/Cargo.toml` to silence cfg warnings and prepare for Phase 1 integration.

5 integration tests in `dryrun_orchestrator_tests.rs` using `MockBrowserDriver { plan: VecDeque<Result<StepResult, MockDriverError>> }`:
1. Happy path: 3 steps pass, emits Queued*3 + Running*3 + Pass*3 + Summary + Done
2. Failure: step 2 fails, orchestrator stops, Summary shows passed=1/failed=1
3. Selector chain: mock returns multi-attempt chain, Pass event preserves it verbatim
4. Cancel: 10-step run aborted after 3 passes, fewer than 10 Pass events emitted
5. Timing: Summary.total_ms equals sum of per-step elapsed_ms

**Task 2 -- dryrun_start + dryrun_cancel Tauri commands.** Created `apps/desktop/src-tauri/src/commands/dryrun.rs`:

- `DryRunTaskRegistry` with `parking_lot::Mutex<HashMap<String, AbortHandle>>` (mirrors CaptureRegistry pattern from commands/capture.rs using global `OnceLock`)
- `dryrun_start(steps, on_event)`: validates non-empty steps, converts DryRunStepDto to ExecStep, spawns tokio task wrapping `dryrun::run()`, stores AbortHandle, forwards DryRunEvent to Channel<DryRunEventDto>, returns task_id
- `dryrun_cancel(task_id)`: looks up and aborts the task, returns NotFound if missing
- `DryRunEventDto` wrapper (JSON-stringified DryRunEvent) for specta/IPC compatibility
- `DryRunStepDto` input type with specta::Type derive
- `StubBrowserDriver` placeholder returning instant success (TODO comment for Phase 1 swap)

Registered both commands + both DTO types in `ipc_spec.rs`.

## Decisions Made

1. **Local trait stub over automation crate dependency** -- The DryRunOrchestrator depends on `BrowserDriver` at the trait level only. Since the automation crate's BrowserDriver has a different method surface (launch/goto/click/type_text vs the simplified execute/navigate/close), a local stub matching the plan's expected API is cleaner. The `phase1-wired` feature flag enables the switch when Phase 1 refactors to expose a compatible `execute` method.

2. **Global OnceLock registry over Tauri managed state** -- Matches the CaptureRegistry pattern already established in the codebase. Avoids threading `State<'_, DryRunTaskRegistry>` through every command signature.

3. **StubBrowserDriver as placeholder** -- Returns instant success for all steps. This allows the IPC surface to be exercised end-to-end from the frontend before the real driver is available.

## Task Commits

| Task | Message | Hash |
|------|---------|------|
| 1 | feat(03-16): DryRunOrchestrator + mock driver tests | e40d834 |
| 2 | feat(03-16): dryrun_start + dryrun_cancel Tauri commands + registry | 6924337 |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Critical] Added `phase1-wired` feature flag to Cargo.toml**
- **Found during:** Task 1
- **Issue:** The `#[cfg(feature = "phase1-wired")]` gates in `dryrun/mod.rs` produced `unexpected_cfgs` warnings without a corresponding feature declaration in Cargo.toml.
- **Fix:** Added `[features] phase1-wired = []` section to `crates/intelligence/Cargo.toml`.
- **Files modified:** crates/intelligence/Cargo.toml
- **Commit:** e40d834

No other deviations. Plan executed as written.

## Verification

```bash
cargo test -p intelligence --test dryrun_orchestrator_tests    # 5/5 passed
cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml  # exit 0, no warnings
```

**Task 1 acceptance criteria:**
- All 5 tests green
- `grep -c "DryRunEvent::Pass\|DryRunEvent::Fail\|DryRunEvent::Summary" orchestrator.rs` = 3
- `grep -c "break" orchestrator.rs` = 1 (stop-on-first-fail)

**Task 2 acceptance criteria:**
- `grep "dryrun_start\|dryrun_cancel" ipc_spec.rs` returns 2 matches inside collect_commands
- `cargo check --manifest-path src-tauri/Cargo.toml` exits 0

## Threat Register Disposition

| Threat ID | Disposition | Evidence |
|-----------|-------------|----------|
| T-03-16-01 (Tampering - ExecStep injection) | mitigated | ExecStep is a typed struct with string fields; the BrowserDriver trait validates verb semantics; unknown verbs handled by the driver implementation |
| T-03-16-02 (DoS - Long-running dry-run) | mitigated | tokio::spawn decouples from command queue; AbortHandle via dryrun_cancel allows user-initiated cancellation; per-step timeout is Phase 1 driver responsibility |
| T-03-16-03 (Info Disclosure - Screenshot bytes) | accepted | StepResult.screenshot is Option<Vec<u8>> stored only in session memory; not persisted to sqlite; user-visible only |
| T-03-16-04 (EoP - file:// URL navigation) | mitigated | Phase 1 AUTO-04 mandates URL scheme validation; this plan inherits via the BrowserDriver trait contract |

No new threat surface introduced beyond the plan's register.

## Known Stubs

| Stub | File | Line | Reason |
|------|------|------|--------|
| StubBrowserDriver | apps/desktop/src-tauri/src/commands/dryrun.rs | 105 | Placeholder until Phase 1 BrowserDriver is wired via phase1-wired feature |

The stub returns instant success for all steps. This is intentional -- it allows the IPC surface to be tested end-to-end while the real driver integration is pending. The plan explicitly calls for this: "Works with Phase-1 mock BrowserDriver trait if Phase 1 not yet merged."

## Handoff Notes

- **Phase 1 wiring:** When `crates/automation` exposes an `execute(&ExecStep) -> Result<StepResult, DriverError>` method (or equivalent), enable `phase1-wired` in Cargo.toml and update `dryrun/mod.rs` re-exports. The `StubBrowserDriver` in `commands/dryrun.rs` should be replaced with real driver construction.
- **Frontend integration:** The renderer calls `dryrun_start({ steps, on_event })` and receives `DryRunEventDto { json: string }` payloads. Parse the JSON to get typed `DryRunEvent` variants (queued/running/pass/fail/summary/done).
- **Cancel:** Call `dryrun_cancel(task_id)` with the string returned by `dryrun_start`. The AbortHandle aborts the tokio task immediately; the orchestrator stops emitting events cleanly.

## Self-Check: PASSED

File existence:
- crates/intelligence/src/dryrun/mod.rs -- FOUND
- crates/intelligence/src/dryrun/orchestrator.rs -- FOUND
- crates/intelligence/src/dryrun/trait_stub.rs -- FOUND
- crates/intelligence/tests/dryrun_orchestrator_tests.rs -- FOUND
- apps/desktop/src-tauri/src/commands/dryrun.rs -- FOUND

Commits:
- e40d834 -- FOUND
- 6924337 -- FOUND

Verification:
- cargo test -p intelligence --test dryrun_orchestrator_tests -- 5/5 passed
- cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml -- exit 0
