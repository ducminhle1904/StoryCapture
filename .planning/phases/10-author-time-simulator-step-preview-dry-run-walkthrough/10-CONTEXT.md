---
phase: 10
type: context
status: ready-for-planning
date: 2026-04-18
---

# Phase 10: Author-time simulator — step-preview + dry-run walkthrough

**Status:** Approved — ROADMAP.md updated 2026-04-18.
**Depends on:** Phase 7 (locator engine + `.story.targets.json`), Phase 9 (ephemeral Playwright session, CDP screencast pipeline), Phase 9-04 (Editor-surface Live Preview).

<domain>
## Phase Boundary

Give the Editor page an "execute without recording" mode so authors can validate a DSL without producing a final video. Two user-visible features share one infrastructure layer:

1. **Step-preview ("Preview to here").** Run the DSL from scene start up to the caret line, then pause. Preview panel shows the resulting page state (via Phase 9's live screencast) + the cursor position + the last matched element highlighted. Re-runnable on any caret move.

2. **Dry-run walkthrough.** A "Dry run" button replays the full DSL with per-step screenshots, matched-element bboxes, and cursor trajectories captured into an in-memory timeline. Preview panel becomes a scrubable slideshow; DSL lines are linked to timeline frames (click a step → jump to that frame; scrub timeline → highlight step).

**Out of scope:**
- Producing a final video during dry-run (user must use the Record button for that).
- Running against the live recording session (dry-run always uses a separate author-time browser).
- Persistent dry-run archives across sessions (deferred — in-memory only for v1).

</domain>

<decisions>
## Implementation Decisions

### Runtime

- **D-01: Reuse Phase 9-04's ephemeral author-time Playwright session.** Dry-run + step-preview both call into the same long-lived author session that backs Editor-surface Live Preview. No third Chromium instance.
- **D-02: Executor gains a `run_to_step(n)` entry point.** `crates/automation/src/executor.rs` already produces `ExecutorEvent`s per step; extend it to accept a stop-after-ordinal parameter and emit a `RunPaused` terminal event. Existing recording path (run-to-end) is unchanged — just passes `Some(u32::MAX)`.
- **D-03: Dry-run and step-preview share the same artifact schema.** Both produce `Vec<StepFrame { ordinal, screenshot_path, cursor_xy, matched_selector, matched_bbox, duration_ms }>`. Step-preview is "dry-run with `stop_after = caret_line`". One codepath.
- **D-04: Dry-run frames stored in `project_dir/.story.dryrun/<timestamp>/`.** Reuses existing screenshot storage convention. Cleaned on project close.
- **D-05: Timeline UI is a thin React component over `StepFrame[]`.** Driven by Zustand store slice; CodeMirror line decoration syncs via a shared `currentFrameOrdinal` signal.

### Integration points

- **With Phase 7:** Dry-run writes matched fallbacks into `.story.targets.json` on first success, exactly the self-healing protocol defined in 07-04c. A dry-run effectively warms the fallback cache.
- **With Phase 7-05 (selector validator):** Dry-run produces ground-truth matches per step that the validator can promote to GREEN. Validator falls back to snapshot-based (static) matching when no dry-run has been executed.
- **With Phase 9-04:** Step-preview's live state is rendered via the same `LivePreview` canvas; dry-run's timeline uses static screenshots captured by the dry-run.

</decisions>

<plans>
## Plan breakdown (proposed)

- **10-01 — Executor `run_to_step` + step-frame capture.**
  Extend `Executor::run`; add `ExecutorEvent::RunPaused`; capture `StepFrame` per step (screenshot via `page.screenshot()`, cursor via existing `cursorPosition` RPC). Unit tests against the deterministic test scene already used in Phase 7.

- **10-02 — Author-time dry-run command + storage.**
  New Tauri commands `author_dry_run_start / _stop / _step_to(n)`; writes frames to `.story.dryrun/`. Frame archive is addressed by dry-run uuid. Emits a Tauri `event` channel of `StepFrame` as they're captured.

- **10-03 — Editor UI: timeline + "Preview to here".**
  `DryRunPanel.tsx` existing placeholder becomes the timeline. New "Preview to here" action in the story-editor's caret-context menu (keyboard shortcut: Cmd-.). CodeMirror decoration highlights the "active frame" line during scrub. Preview-panel live canvas dims to 50% opacity while dry-run walkthrough is active (static frames take over).

</plans>

<risks>
## Risk Flags

- **Concurrency with Live Preview.** If both Phase 9-04 live preview AND a dry-run are active, the author-time browser has to switch modes. Mitigation: dry-run takes exclusive lock on the session; live preview pauses until dry-run completes. Clear UI state.
- **Dry-run determinism.** A story with network-dependent verbs (goto external URL, waitFor) will produce different screenshots across runs. Document as expected. Consider a "snapshot-only" mode in a future phase.
- **Frame storage bloat.** A 20-step story at 1280x800 PNG ≈ 20×300 KB = 6 MB per dry-run. Per-project dry-runs accumulate in `.story.dryrun/`. Add retention (keep last 5) to the 10-02 plan.
- **Phase 10 is the largest of the three.** Consider splitting 10-01 into 10-01a (executor change) + 10-01b (sidecar + IPC) if plans exceed the GSD quick budget.
</risks>
