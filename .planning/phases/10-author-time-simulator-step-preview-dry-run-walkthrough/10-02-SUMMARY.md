---
phase: 10
plan: 02
wave: 2
subsystem: automation-host
tags: [simulator, ipc, tauri-command, session-registry]
dependency-graph:
  requires:
    - "10-01 (automation::continue_run / RunControl::cancel / try_promote_fallback pub)"
    - "09-04 (AuthorPreviewSession with Arc<Mutex<PlaywrightSidecarDriver>> + pause/resume/attach)"
  provides:
    - "commands::simulator::{simulator_start, simulator_step_to, simulator_cancel, simulator_promote_fallback}"
    - "commands::simulator::SimulatorRegistry state container"
    - "commands::simulator::SimulatorEvent / SimulatorStepFrame / SimulatorBbox / SimulatorMatchKind IPC types"
    - "commands::simulator::prune_runs_retain_5 retention helper"
    - ".story.simulator/<run-uuid>/ on-disk archive layout"
    - "TS facade apps/desktop/src/ipc/simulator.ts (simulatorStart/stepTo/cancel/promoteFallback)"
  affects:
    - "packages/shared-types/src/ipc.ts (regenerated — simulator commands + types registered)"
tech-stack:
  added:
    - "filetime (dev-dep) — mtime control in retention tests"
  patterns:
    - "Cheap per-call SharedPlaywrightDriver wrappers over the shared Arc<Mutex<PlaywrightSidecarDriver>> (launch never called)"
    - "continue_run(start_after_ordinal=0) as the ONLY simulator entry point — no run_story path, no re-launch"
    - "Per-session Channel<SimulatorEvent> + ExecutorEvent forwarder task; registry holds stream_id/run_id/last_ordinal AtomicU32/frames HashMap"
    - "AppError envelopes throughout (matches codebase) — InvalidArgument for bad ordinals, UnavailableOnBackend for preview-off, NotFound for missing sessions"
key-files:
  created:
    - "apps/desktop/src-tauri/src/commands/simulator.rs"
    - "apps/desktop/src-tauri/tests/simulator_retention.rs"
    - "apps/desktop/src-tauri/tests/simulator_step_to_reuse.rs"
    - "apps/desktop/src/ipc/simulator.ts"
    - ".planning/phases/10-author-time-simulator-step-preview-dry-run-walkthrough/10-02-SUMMARY.md"
  modified:
    - "apps/desktop/src-tauri/src/commands/mod.rs"
    - "apps/desktop/src-tauri/src/lib.rs"
    - "apps/desktop/src-tauri/src/ipc_spec.rs"
    - "apps/desktop/src-tauri/Cargo.toml"
    - "Cargo.lock"
    - "packages/shared-types/src/ipc.ts"
decisions:
  - "D-00: namespace isolation — zero references to dryrun/DryRun/intelligence::dryrun from new code"
  - "D-01: ALL simulator runs route through continue_run; SharedPlaywrightDriver wraps the 9-04 author Arc; primary.launch() is never called from the simulator path"
  - "D-07: self_heal=false passed through on every continue_run call; try_promote_fallback is only ever invoked from simulator_promote_fallback with persist=true"
  - "D-09: SimulatorEvent is its own discriminated union, not a shared ExecutorEvent/DryRunEvent"
  - "D-11: SimulatorRegistry is a HashMap<String, ResumableSession> behind tokio::Mutex, managed via .manage() on AppState"
metrics:
  duration: "~90min"
  completed: "2026-04-21"
---

# Phase 10 Plan 02: Simulator Tauri Commands + Frame Storage + Session Registry Summary

One-liner: Ships the 4 simulator Tauri commands, a ResumableSession registry, SimulatorEvent IPC union, and `.story.simulator/` 5-run retention archive — all consuming the public automation APIs shipped by 10-01 without touching `crates/automation/`.

## Scope

- `commands/simulator.rs` — new module (~530 LOC) with `ResumableSession`, `SimulatorRegistry`, `SimulatorEvent` enum, `SimulatorStepFrame` / `SimulatorBbox` / `SimulatorMatchKind` DTOs, and `prune_runs_retain_5` helper.
- 4 Tauri commands: `simulator_start`, `simulator_step_to`, `simulator_cancel`, `simulator_promote_fallback`.
- Registry managed via `.manage(SimulatorRegistry::default())` on app startup.
- TS facade in `apps/desktop/src/ipc/simulator.ts` with typed wrappers + SimulatorEvent union.
- Retention test (3 cases) + no-relaunch test (simulating start + 2× step_to).

## Commits

| # | Hash | Subject |
|---|------|---------|
| 1 | 88afc4d | `feat(10-02): scaffold simulator command surface + retention trim` |
| 2 | b952505 | `feat(10-02): no-relaunch test + TS simulator IPC facade` |

## Public Surface Added

```rust
// apps/desktop/src-tauri/src/commands/simulator.rs
pub struct SimulatorRegistry { pub sessions: Mutex<HashMap<String, ResumableSession>>; }
pub enum SimulatorEvent { Started, FrameCaptured, Paused, Failed, Completed, Cancelled }
pub struct SimulatorStepFrame { /* ordinal, screenshot_path, cursor_xy, matched_selector, matched_bbox, match_kind, duration_ms */ }
pub fn prune_runs_retain_5(project_folder: &Path) -> std::io::Result<usize>;

#[tauri::command] pub async fn simulator_start(...)  -> Result<String, AppError>;
#[tauri::command] pub async fn simulator_step_to(...) -> Result<(), AppError>;
#[tauri::command] pub async fn simulator_cancel(...) -> Result<(), AppError>;
#[tauri::command] pub async fn simulator_promote_fallback(...) -> Result<(), AppError>;
```

```typescript
// apps/desktop/src/ipc/simulator.ts
export type SimulatorMatchKind = "primary" | "fuzzy" | "none";
export interface SimulatorStepFrame { /* mirror of Rust DTO */ }
export type SimulatorEvent =
  | { type: "started"; session_id; run_id; total_steps }
  | { type: "frame_captured"; ordinal; frame: SimulatorStepFrame }
  | { type: "paused"; ordinal }
  | { type: "failed"; ordinal; error_message }
  | { type: "completed"; succeeded; failed }
  | { type: "cancelled" };
export function simulatorStart(args, onEvent): Promise<string>;
export function simulatorStepTo(sessionId, ordinal): Promise<void>;
export function simulatorCancel(sessionId): Promise<void>;
export function simulatorPromoteFallback(sessionId, ordinal): Promise<void>;
```

## Test Coverage

- `simulator_retention.rs` — 3 tests, all green:
  1. `retains_only_5_most_recent` — 7 dummy run dirs with explicit mtimes → 2 deleted, 5 newest remain.
  2. `under_5_keeps_all` — 3 dirs → 0 deleted, all kept.
  3. `missing_dir_is_created` — non-existent `.story.simulator/` is created on first call.
- `simulator_step_to_reuse.rs` — 1 test, green: three sequential `continue_run` calls (start + 2× step_to pattern) keep `primary.launches == 0` and `fallback.launches == 0`. The real Chromium launch lives in `start_author_preview` (9-04), outside the simulator code path.

## Regression Gates

- `cargo check -p automation -p storycapture` → clean.
- `cargo test -p storycapture --test simulator_retention` → 3/3.
- `cargo test -p storycapture --test simulator_step_to_reuse` → 1/1.
- `cargo test -p storycapture --lib` → 70/70 (baseline preserved).
- `cargo test -p automation --lib` → 61/61 (baseline preserved).
- `pnpm --filter @storycapture/desktop exec tsc --noEmit` → clean.
- `npx vitest run live-preview recorder` (from apps/desktop) → 72/72 passed across 10 files (baseline preserved and improved from 60/60).
- `git diff --name-only crates/automation/` at end of plan → 0 files (scope discipline).
- `grep -rn "dryrun\|DryRunPanel\|intelligence::dryrun" apps/desktop/src-tauri/src/commands/simulator.rs apps/desktop/src/ipc/simulator.ts` → 0 matches (D-00 isolation).

## Deviations from Plan

### 1. [Rule 3 - Architectural] All runs use `continue_run`, not `run_story`

**Found during:** Task 2 design review.
**Issue:** The plan specified `simulator_start` should call `automation::run_story(..., capture_frames=true, self_heal=false)`. Since `run_story` calls `.launch()` on the primary driver unless `already_launched=true`, and our driver is a `SharedPlaywrightDriver` wrapping the 9-04 author session's already-launched `Arc<Mutex<PlaywrightSidecarDriver>>`, invoking `.launch()` would call the sidecar's `launch` JSON-RPC a second time — which re-initializes Playwright's browser context and breaks the author preview.
**Fix:** Both `simulator_start` and `simulator_step_to` route through `automation::continue_run` (which sets `already_launched=true` internally). `simulator_start` passes `start_after_ordinal=0`. This honors D-01 (reuse author session) by construction — the crate contract guarantees `launch()` is never called from the simulator.
**Files modified:** `apps/desktop/src-tauri/src/commands/simulator.rs`.
**Commit:** 88afc4d.
**Grep verification:** `grep -n "automation::run_story" apps/desktop/src-tauri/src/commands/simulator.rs` returns 0; `grep -n "automation::continue_run\|automation::try_promote_fallback" apps/desktop/src-tauri/src/commands/simulator.rs` returns 2 references (one per API consumed).

### 2. [Rule 2 - Correctness] `AppError` instead of new `SimulatorError` enum

**Found during:** Task 1 skeleton.
**Issue:** Plan proposed a standalone `SimulatorError` enum with typed variants. The codebase uniformly returns `Result<T, AppError>` from every `#[tauri::command]` and has a hand-rolled `Serialize` impl producing `{kind, message}` shape; introducing a second error type would duplicate that infrastructure and fragment the renderer's error handling.
**Fix:** Use `AppError` variants (`InvalidArgument`, `UnavailableOnBackend`, `NotFound`, `Automation`, `Io`) with explicit messages. The plan's `must_haves` truth "simulator_start returns a typed error if previewEnabled=false" is satisfied by `AppError::UnavailableOnBackend("preview is disabled — enable Preview...")`. Renderer consumers pattern-match on `err.kind`.
**Files modified:** `apps/desktop/src-tauri/src/commands/simulator.rs`.
**Commit:** 88afc4d.

### 3. [Rule 3 - Correctness] `story_path` added to `simulator_start` args

**Found during:** Task 2 wiring `try_promote_fallback`.
**Issue:** `try_promote_fallback` needs the `.story` file path to locate the `.story.targets.json` sidecar. The plan's `simulator_start` signature omitted `story_path`, only passing `story_source` (the DSL text). Without the path, promote-to-fallback cannot mutate the correct sidecar file.
**Fix:** Added `story_path: String` to `simulator_start`. The TS facade `SimulatorStartArgs` mirrors it as `storyPath`.
**Files modified:** `commands/simulator.rs`, `apps/desktop/src/ipc/simulator.ts`.
**Commit:** 88afc4d / b952505.

### 4. [Rule 3 - Plan interpretation] No-relaunch test validates the invariant, not the specific "1" count

**Found during:** Task 3 test design.
**Issue:** Plan asserted `primary.launch_count == 1` across two sequential step_to's, reflecting a mental model where `run_story` performs one launch. Under the architecture we shipped (Deviation 1), the simulator layer never calls `.launch()` at all — the author preview is already launched, and our simulator drivers are Arc-shared cheap wrappers.
**Fix:** The test now asserts `primary.launches == 0` and `fallback.launches == 0` across three sequential `continue_run` calls (start + 2× step_to). This proves the stronger invariant the plan actually needs: the simulator never re-launches Chromium. Documented in the test preamble.
**Files:** `apps/desktop/src-tauri/tests/simulator_step_to_reuse.rs`.
**Commit:** b952505.

## Authentication Gates

None — Wave 2 is pure-IPC plumbing over already-launched resources. No keychain/OAuth interaction.

## What Wave 3 (10-03) Can Consume

All slots the UI layer needs are in place:

- **simulatorStore slot for Promote-to-fallback:** `SimulatorStepFrame.match_kind === "fuzzy"` drives the per-frame "Promote to fallback" button; the button calls `simulatorPromoteFallback(sessionId, ordinal)`.
- **Locked-run dry-run variant hook:** `simulatorStart` accepts `stopAfterOrdinal` — omit it to run to completion (full dry-run), set it to the caret-line ordinal for "Preview to here". Same command, different knob.
- **Paused-run pattern:** after the pause the session stays in the registry and `simulatorStepTo` extends the run; the editor can stay in read-only mode until `runState === "idle"`.
- **Cancellation:** `simulatorCancel` triggers `RunControl::cancel`, awaits the forwarder with a 2s timeout, calls `call_resume_stream` on the author sidecar, and emits `SimulatorEvent::Cancelled`.
- **Frame thumbnails:** `frame.screenshot_path` is an absolute filesystem path inside the project's `.story.simulator/<run-uuid>/` dir — the UI uses `convertFileSrc` to render.
- **Retention:** every `simulator_start` prunes older run dirs down to 5 before creating the new one.

## Self-Check: PASSED

- [x] `apps/desktop/src-tauri/src/commands/simulator.rs` exists (530 LOC, declares all required items).
- [x] `apps/desktop/src-tauri/src/commands/mod.rs` has `pub mod simulator;`.
- [x] `apps/desktop/src-tauri/src/lib.rs` has `app.manage(commands::simulator::SimulatorRegistry::default());` and `pub use commands::simulator::prune_runs_retain_5;`.
- [x] `apps/desktop/src-tauri/src/ipc_spec.rs` registers all 4 commands + all 4 simulator types.
- [x] `apps/desktop/src-tauri/tests/simulator_retention.rs` — 3/3 pass.
- [x] `apps/desktop/src-tauri/tests/simulator_step_to_reuse.rs` — 1/1 pass.
- [x] `apps/desktop/src/ipc/simulator.ts` exists (SimulatorEvent + 4 typed wrappers).
- [x] `packages/shared-types/src/ipc.ts` regenerated — contains `SimulatorEvent`, `SimulatorStepFrame`, `SimulatorBbox`, `SimulatorMatchKind`, and all 4 simulator commands.
- [x] Both commits present in git log: `88afc4d`, `b952505`.
- [x] `git diff --name-only crates/automation/` returns 0 files (crate-surface discipline).
