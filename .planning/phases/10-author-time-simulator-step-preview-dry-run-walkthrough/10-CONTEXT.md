---
phase: 10
type: context
status: ready-for-planning
date: 2026-04-19
---

# Phase 10: Author-time simulator — step-preview + dry-run walkthrough

**Status:** Ready for planning — conflicts resolved in /gsd-discuss-phase 2026-04-19.
**Depends on:** Phase 7 (locator engine + `.story.targets.json`), Phase 9 (ephemeral Playwright session, CDP screencast pipeline), Phase 9-04 (Editor-surface Live Preview — MUST be extended with two new RPCs before Phase 10 starts; see D-06).

<domain>
## Phase Boundary

Give the Editor page an "execute without recording" mode so authors can validate a DSL without producing a final video. Two user-visible features share one infrastructure layer:

1. **Step-preview ("Preview to here").** Run the DSL from scene start up to the caret line, then pause. Preview panel shows the resulting page state (via Phase 9's live screencast) + the cursor position + the last matched element highlighted. Re-runnable on any caret move.

2. **Dry-run walkthrough.** A "Dry run" button replays the full DSL with per-step screenshots, matched-element bboxes, and cursor trajectories captured into an in-memory timeline. Preview panel becomes a scrubable slideshow; DSL lines are linked to timeline frames (click a step → jump to that frame; scrub timeline → highlight step).

**Out of scope:**
- Producing a final video during dry-run (user must use the Record button for that).
- Running against the live recording session (dry-run always uses a separate author-time browser).
- Persistent dry-run archives across sessions (deferred — in-memory + ≤ 5 recent on disk for v1).
- Deleting Phase 3's shipped `intelligence::dryrun` module in this phase (deprecation scheduled for a later phase; see Deferred Ideas).

</domain>

<decisions>
## Implementation Decisions

### Naming (resolves Design Conflict #1)

- **D-00: Phase 10's feature is called "Simulator" in all new code and UI.** New surfaces are `SimulatorTimeline.tsx`, `simulatorStore.ts`, `simulator_*` Tauri commands, `SimulatorEvent` IPC type, `.story.simulator/` on-disk dir. This leaves the shipped Phase 3 `DryRunPanel.tsx` + `dryrun_start` / `dryrun_cancel` + `intelligence::dryrun::*` + `dryRunStore.ts` entirely untouched. Deprecation of Phase 3 dry-run is deferred (see Deferred Ideas); the two features can co-exist for the duration of Phase 10. ROADMAP.md keeps "dry-run" in the phase title because it's the user-visible concept; internal identifiers use "simulator".

### Runtime

- **D-01: Reuse Phase 9-04's ephemeral author-time Playwright session.** Simulator (step-preview + dry-run) calls into the same long-lived author session that backs Editor-surface Live Preview. No third Chromium instance. Requires two new RPCs on 9-04 — see D-06.
- **D-02: Executor gains `run_to_step` parameterization.** `crates/automation/src/executor.rs` — thread `stop_after_ordinal: Option<u32>` + `capture_frames: bool` + `frame_dir: Option<PathBuf>` + `self_heal: bool` through the existing `run_story` function. Add `ExecutorEvent::RunPaused { ordinal }` and `ExecutorEvent::StepFrameCaptured { ordinal, frame }`. Existing recording path passes `stop_after_ordinal=None, capture_frames=false, self_heal=true` — unchanged behavior.
- **D-03: Simulator and step-preview share the same artifact schema.** Both produce `Vec<StepFrame { ordinal, screenshot_path, cursor_xy, matched_selector, matched_bbox: Option<Bbox>, duration_ms }>`. `matched_bbox` is `None` for commands without a target (Navigate, Wait, Screenshot). Step-preview is a simulator run with `stop_after_ordinal = caret_line`. One codepath.
- **D-04: Simulator frames stored in `project_dir/.story.simulator/<run-uuid>/`.** Reuses the existing per-step screenshot storage convention already used by Phase 1 recording. Retention: keep 5 most recent runs per project; older runs pruned at `simulator_start`. No GC at project close (trim-to-5 is sufficient).
- **D-05: Timeline UI is a thin React component over `StepFrame[]`.** Driven by `simulatorStore` (Zustand); CodeMirror line decoration syncs via a shared `currentFrameOrdinal` signal using `StateField + StateEffect`.

### Coordination with Phase 9-04 (resolves Design Conflict #3)

- **D-06: Phase 9-04 scope MUST be extended BEFORE Phase 10 implementation starts.** Two additions to 09-04-PLAN.md `must_haves`:
  - **(a) Expose the author-session's `Page` handle** so the simulator's executor can run verbs against it (click, type, goto, etc.) — not just view via screencast. The sidecar must allow `PlaywrightSidecarDriver` construction against a `{sidecarConnection, streamId}` pair, or equivalent.
  - **(b) Add `pauseStream(streamId)` and `resumeStream(streamId)` sidecar RPCs** + matching Tauri commands `pause_author_preview` / `resume_author_preview`. Wraps CDP `Page.stopScreencast` / `Page.startScreencast` on the existing session. Required so the simulator can take exclusive CDP control during a run and hand back cleanly.
  These two must_haves are tracked under PHASE-9.8 and PHASE-9.9 (new). Planner must NOT start Phase 10 plans until they are shipped.

### Self-healing behavior (resolves Design Conflict #2 + Pitfall 3)

- **D-07: Simulator runs are READ-ONLY by default.** `Executor::run_story` gets a new `self_heal: bool` parameter. Recording path passes `true` (unchanged). Simulator passes `false` — `try_promote_fallback` is NOT called during a simulator run. The UI exposes a "Promote to fallback" action on any timeline frame whose step had a fuzzy match; clicking it triggers an explicit `.story.targets.json` mutation via a new `simulator_promote_fallback(run_id, ordinal)` command. Users never get surprise on-disk changes from a dry-run.

### Editor lock (resolves Design Conflict #4 + Pitfall 5)

- **D-08: Editor becomes read-only during an active simulator run.** `EditorState.readOnly = true` for the duration of a dry-run or step-preview execution. A banner renders at the top of the editor: "Simulator running — edits paused". Scrubbing the timeline + highlighting the active line STAY functional while read-only. Banner dismisses and editor re-enables on `RunPaused`, `StoryEnded`, or `SimulatorCancelled`.

### IPC / event hygiene (resolves Design Conflict #4)

- **D-09: Phase 10 IPC types are namespaced to avoid Phase 3 collisions.** `SimulatorEvent` (not `DryRunEvent`). `simulatorStore` (not `dryRunStore`). `simulator_start` / `simulator_cancel` / `simulator_promote_fallback` Tauri commands. The two worlds never share a discriminated union.
- **D-10: Adding `ExecutorEvent::RunPaused` + `::StepFrameCaptured` is a breaking change on any exhaustive TS switch.** Grep `apps/desktop/src/` for `switch` over `ev.type` before shipping 10-01; add `default: break` branches to any consumer that doesn't need the new variants (hud.tsx, recording-view.tsx).

### Session registry

- **D-11: The simulator session registry lives in `apps/desktop/src-tauri/src/commands/simulator.rs`.** A `HashMap<SimulatorSessionId, ResumableSession>` behind a `tokio::Mutex`. Each session holds the `AppHandle`, the 9-04 `streamId`, the executor JoinHandle, a `RunControl` for cancellation, and the driver snapshot for resuming after a "Preview to here" pause. No new crate-level API in `automation::`.

### Claude's Discretion

- Exact UI layout of `SimulatorTimeline.tsx` (scrubber style, frame thumbnail grid vs filmstrip, step-row card style) — planner picks, consistent with existing editor chrome.
- Whether to render a cursor trail across frames or just the current-frame cursor — planner picks.
- Keyboard shortcuts beyond Cmd-. for "Preview to here" — planner picks.
- Error-state UI when a step fails mid-simulation — planner picks.

</decisions>

<plans>
## Plan breakdown (revised after discuss-phase)

- **10-01 — Executor parameterization + `StepFrame` capture.**
  Thread `stop_after_ordinal`, `capture_frames`, `frame_dir`, `self_heal` through `Executor::run_story`. Add `ExecutorEvent::RunPaused` + `::StepFrameCaptured`. Add `BrowserDriver::element_state` method wrapping sidecar `elementState` RPC (NoopDriver returns `None`). Unit tests: run-to-step pause, frame capture on each succeeded step, self_heal=false bypasses `try_promote_fallback`, Navigate/Wait/Screenshot produce `matched_bbox=None`. Update `hud.tsx` / `recording-view.tsx` switches to add `default` branches (D-10).

- **10-02 — Simulator Tauri commands + frame storage + session registry.**
  New `commands/simulator.rs` with `simulator_start`, `simulator_step_to`, `simulator_cancel`, `simulator_promote_fallback` commands. `ResumableSession` registry. Writes frames to `project_dir/.story.simulator/<run-uuid>/`; prune-to-5 at start. Emits `SimulatorEvent` via Tauri `Channel<T>`. Coordinates with 9-04's author session via `pause_author_preview` / `resume_author_preview`. New TS IPC file `ipc/simulator.ts` with typed wrappers.

- **10-03 — Editor UI: SimulatorTimeline + "Preview to here".**
  New `SimulatorTimeline.tsx` + `simulatorStore.ts` (Zustand). CodeMirror `StateField` + `StateEffect` for line decoration synced via `currentFrameOrdinal`. "Preview to here" caret-context-menu action + Cmd-. shortcut. Editor readOnly + banner during active run (D-08). Preview-panel dims its live canvas while simulator frames are active; swaps back on idle. Explicit "Promote to fallback" button on fuzzy-matched frames (D-07 wiring).

- **10-04 — 9-04 extensions for Phase 10.**
  **Not a Phase 10 plan — this is a scope addition to Phase 9-04.** Add two must_haves to 09-04-PLAN.md: (a) expose author-session `Page` handle to the automation driver; (b) add `pauseStream` / `resumeStream` sidecar RPCs + Tauri commands. These land as part of 09-04's execute phase. Phase 10 plans (10-01/02/03) are blocked until 9-04 ships with the extensions.

**Dependency chain:** 09-04 (with D-06 extensions) → 10-01 → 10-02 → 10-03.

</plans>

<risks>
## Risk Flags

- **9-04 not yet implemented.** Entire phase is blocked on 9-04 execute. Phase 10 plans should not begin until 9-04 is green. Mitigation: 10-01 (executor extension) is independent of 9-04 session plumbing and could start in parallel.
- **Simulator determinism.** A story with network-dependent verbs (external URL, waitFor) produces different screenshots across runs. Document as expected. Consider a "snapshot-only / offline" mode in a future phase.
- **Frame storage bloat.** 20-step story × 1280×800 PNG ≈ 6 MB per run × 5 retained = 30 MB per project. Acceptable. Retention enforced at run start.
- **Breaking change on `ExecutorEvent`.** `RunPaused` + `StepFrameCaptured` variants may silently drop on TS consumers with exhaustive switches. Mitigation: D-10 — audit + add defaults in 10-01.
- **Parallel Phase 3 dry-run remains.** While Phase 10 ships, `DryRunPanel.tsx` (Phase 3) continues to work against its stub driver. Two features co-exist until deprecation. Users may find two "run without recording" UIs confusing — add a note in 10-03 UI copy that simulator is the canonical tool.

</risks>

<deferred>
## Deferred Ideas

- **Delete Phase 3 `intelligence::dryrun::*` + `commands/dryrun.rs` + `DryRunPanel.tsx` + `dryRunStore.ts` + `useDryRun.ts` + Phase 3 i18n strings.** Scheduled for a later phase once Phase 10 simulator is stable and users have migrated. Explicitly NOT in Phase 10 scope per D-00.
- **Persistent simulator archives across sessions.** Trim-to-5 is v1; richer history UI deferred.
- **Snapshot-only / offline simulator mode.** A mode that replays against cached DOM/screenshots without re-hitting the network. Useful for selector validation in CI. Deferred.
- **Cross-simulator diff view** — compare two runs of the same story. Deferred.

</deferred>
