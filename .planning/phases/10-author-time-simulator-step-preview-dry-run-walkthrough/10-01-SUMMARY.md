---
phase: 10
plan: 01
wave: 1
subsystem: automation
tags: [executor, simulator, self-healing, ipc]
dependency-graph:
  requires:
    - "PHASE-9.8/9.9 (AuthorPreviewSession + attach_author_driver + pause/resume shipped in 09-04)"
  provides:
    - "automation::ExecutorEvent::RunPaused + StepFrameCaptured"
    - "automation::StepFrame + MatchKind types"
    - "automation::Executor::run_simulator public entry point"
    - "automation::continue_run public entry point"
    - "automation::RunControl::{cancel,is_cancelled}"
    - "automation::try_promote_fallback (now pub)"
    - "TS ExecutorEvent union + StepFrame mirror in apps/desktop/src/ipc/automation.ts"
  affects:
    - "apps/desktop/src/features/recorder/recording-view.tsx (D-10 comment; switch keeps default: break)"
tech-stack:
  added: []
  patterns:
    - "Parameterized run_story — legacy callers pass defaults (None/false/None/true/0/false)"
    - "run_command returns Option<(ResolvedSelector, MatchKind)> — first-resolve-wins for Drag-style multi-target verbs"
    - "try_promote_fallback persist=bool — read-only probe detects Fuzzy without rewriting sidecar"
key-files:
  created:
    - "crates/automation/tests/simulator_run_to_step.rs"
    - ".planning/phases/10-author-time-simulator-step-preview-dry-run-walkthrough/10-01-SUMMARY.md"
  modified:
    - "crates/automation/src/events.rs"
    - "crates/automation/src/executor.rs"
    - "crates/automation/src/control.rs"
    - "crates/automation/src/lib.rs"
    - "apps/desktop/src/ipc/automation.ts"
    - "apps/desktop/src/features/recorder/recording-view.tsx"
decisions:
  - "D-00: 'Simulator' naming — new surfaces are simulator_*; Phase 3 DryRunPanel untouched"
  - "D-02: run_story parameterized with stop_after_ordinal / capture_frames / frame_dir / self_heal"
  - "D-07: Simulator runs are read-only by default — self_heal=false bypasses atomic_write but still surfaces match_kind=Fuzzy so the UI can offer Promote-to-fallback"
  - "D-10: ExecutorEvent union extension — dispatchAutomation switch keeps default: break; recording path never receives run_paused / step_frame_captured"
  - "D-11 (partial): RunControl gained cancel() for the simulator session registry 10-02 will build"
metrics:
  duration: "~45min"
  completed: "2026-04-22"
---

# Phase 10 Plan 01: Executor Parameterization + StepFrame Capture Summary

One-liner: Threaded four simulator knobs + two new ExecutorEvent variants through `automation::run_story`, exposed `continue_run` / `try_promote_fallback` / `RunControl::cancel` publicly, and mirrored StepFrame + MatchKind in TS — the pure-Rust surface the Phase 10-02 Tauri command layer will consume.

## Scope

- Extend `ExecutorEvent` with `RunPaused { ordinal }` and `StepFrameCaptured { ordinal, frame: StepFrame }`.
- Add `StepFrame` struct with `match_kind: MatchKind` discriminator (`Primary | Fuzzy | None`).
- Parameterize `run_story` with `stop_after_ordinal / capture_frames / frame_dir / self_heal` + simulator-only `start_after_ordinal / already_launched`.
- Add `Executor::run_simulator` public async entry point (mirror of `run_with_story_path` with the four knobs).
- Add `continue_run` free function for resumable sessions (no relaunch).
- Add `RunControl::cancel` + `is_cancelled`; scene loop checks at step boundaries.
- Promote `try_promote_fallback` to `pub` + add a `persist: bool` flag so simulator runs can observe Fuzzy matches without rewriting `.story.targets.json`.
- Mirror all new types on the TS side; annotate the recording-path `dispatchAutomation` switch with the D-10 comment (default: break stays).

## Commits

| # | Hash | Subject |
|---|------|---------|
| 1 | 678eca6 | `feat(10-01): add MatchKind + StepFrame + RunPaused/StepFrameCaptured events` |
| 2 | d1fd0ef | `feat(10-01): parameterize run_story with simulator knobs + StepFrameCaptured emission` |
| 3 | 7f2566a | `feat(10-01): mirror StepFrame + RunPaused/StepFrameCaptured in TS ExecutorEvent` |
| 4 | c8cbf4e | `feat(10-01): add RunControl::cancel + pub continue_run for resumable sessions` |

## Public Surface Added

```rust
// crates/automation/src/events.rs
pub enum MatchKind { Primary, Fuzzy, None }
pub struct StepFrame {
    pub ordinal: u32,
    pub screenshot_path: Option<PathBuf>,
    pub cursor_xy: (i32, i32),
    pub matched_selector: Option<String>,
    pub matched_bbox: Option<BoundingBox>,
    pub match_kind: MatchKind,
    pub duration_ms: u64,
}
pub enum ExecutorEvent { /* ... */ RunPaused { ordinal }, StepFrameCaptured { ordinal, frame } }

// crates/automation/src/executor.rs
impl Executor {
    pub fn run_simulator(
        story, story_path, primary, fallback, persistence,
        screenshot_dir, launch_opts, control,
        stop_after_ordinal: Option<u32>, capture_frames: bool,
        frame_dir: Option<PathBuf>, self_heal: bool,
    ) -> mpsc::Receiver<ExecutorEvent>;
}
pub async fn continue_run(
    story, story_path, primary, fallback, persistence,
    screenshot_dir, control,
    start_after_ordinal: u32, stop_after_ordinal: Option<u32>,
    capture_frames: bool, frame_dir: Option<PathBuf>, self_heal: bool,
    tx: mpsc::Sender<ExecutorEvent>,
) -> Result<()>;
pub async fn try_promote_fallback(
    driver, cmd_step_id, story_path, action, persist: bool,
) -> Result<Option<ResolvedSelector>>;

// crates/automation/src/control.rs
impl RunControl {
    pub fn cancel(&self);
    pub fn is_cancelled(&self) -> bool;
}
```

```typescript
// apps/desktop/src/ipc/automation.ts
export interface BoundingBox { x: number; y: number; w: number; h: number; }
export type MatchKind = "primary" | "fuzzy" | "none";
export interface StepFrame {
  ordinal: number;
  screenshot_path: string | null;
  cursor_xy: [number, number];
  matched_selector: string | null;
  matched_bbox: BoundingBox | null;
  match_kind: MatchKind;
  duration_ms: number;
}
export type ExecutorEvent =
  | /* existing 7 variants */
  | { type: "run_paused"; ordinal: number }
  | { type: "step_frame_captured"; ordinal: number; frame: StepFrame };
```

## Test Coverage

`crates/automation/tests/simulator_run_to_step.rs` — 7 tests, all green:

1. `run_stops_at_ordinal` — RunPaused after step N, no StoryEnded.
2. `frame_capture_writes_png_and_bbox` — per-succeeded-step StepFrameCaptured with screenshot_path, bbox, match_kind=Primary.
3. `self_heal_false_bypasses_promote_emits_fuzzy` — sidecar unchanged, match_kind=Fuzzy still emitted.
4. `navigate_and_waitms_yield_null_bbox_and_none_kind` — no-target verbs carry `matched_bbox=None`, `matched_selector=None`, `match_kind=None`.
5. `self_heal_true_promotes_and_emits_fuzzy` — sidecar rewritten AND match_kind=Fuzzy emitted.
6. `continue_run_reuses_already_launched_drivers` — launch() count stays at 0 on resume; steps 3..=5 fire; no StoryStarted.
7. `cancel_exits_scene_loop_after_current_step` — RunControl::cancel() stops the scene loop before the 10th step starts.

## Regression Gates

- `cargo test -p automation --lib` → 61/61 (baseline preserved).
- `cargo test -p automation --tests` → 7 + 5 + 2 + 2 + 10 + 1 = 27 integration tests all green.
- `cargo test -p storycapture --lib -- --test-threads=1` → 70/70 (was 62 in STATE.md, drifted upward from unrelated changes).
- `pnpm --filter @storycapture/desktop typecheck` → clean.
- `cargo check -p automation -p storycapture` → clean.

## Deviations from Plan

None — plan was executed as written. Two implementation notes worth flagging for 10-02:

1. **`try_promote_fallback` gained a `persist: bool` param.** The plan's action-step §4 suggested wrapping the call with `if self_heal { try_promote_fallback(...) }`, but that would have prevented Fuzzy detection in simulator runs (violating Test C + E behavior specs). Instead, the fallback probe always runs and `persist` gates only the `atomic_write` step. Callable from 10-02's Tauri command for explicit user-initiated promotes by passing `persist=true`.

2. **`continue_run` signature differs slightly from the plan sketch.** It omits `launch_opts: LaunchOptions` (drivers are already launched; launch config is irrelevant on resume) and uses `LaunchOptions::default()` internally to satisfy the `run_story` signature. Recording path unaffected.

## What Phase 10-02 Can Now Consume

```rust
use automation::{
    continue_run,
    try_promote_fallback,
    Executor,           // for run_simulator
    RunControl,
    StepFrame,
    MatchKind,
    ExecutorEvent,      // with RunPaused + StepFrameCaptured variants
};
```

The `ResumableSession` registry in `apps/desktop/src-tauri/src/commands/simulator.rs` (Phase 10-02) holds:
- The AuthorPreviewSession's `Arc<Mutex<PlaywrightSidecarDriver>>` (from 09-04)
- A `RunControl` for pause/resume/cancel
- The JoinHandle of the spawned `run_simulator` / `continue_run` task
- The last observed `RunPaused.ordinal` for the next `simulator_step_to` call

## Self-Check: PASSED

- `[x]` crates/automation/src/events.rs — contains `pub enum MatchKind`, `pub struct StepFrame`, `RunPaused`, `StepFrameCaptured`.
- `[x]` crates/automation/src/executor.rs — contains `pub async fn continue_run`, `pub async fn try_promote_fallback`, `pub fn run_simulator`.
- `[x]` crates/automation/src/control.rs — contains `pub fn cancel`, `pub fn is_cancelled`.
- `[x]` crates/automation/src/lib.rs — re-exports `MatchKind`, `StepFrame`, `continue_run`, `try_promote_fallback`, `RunControl`.
- `[x]` crates/automation/tests/simulator_run_to_step.rs — 7 tests present, all pass.
- `[x]` apps/desktop/src/ipc/automation.ts — `export type MatchKind`, `export interface StepFrame`, union extended with `run_paused` + `step_frame_captured`.
- `[x]` apps/desktop/src/features/recorder/recording-view.tsx — D-10 comment above dispatchAutomation switch; RecordingEvent switch at line ~365 untouched.
- `[x]` All four commits present in git log: `678eca6 d1fd0ef 7f2566a c8cbf4e`.
