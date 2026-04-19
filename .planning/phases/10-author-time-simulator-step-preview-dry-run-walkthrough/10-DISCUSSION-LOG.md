# Phase 10: Author-time simulator — Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in 10-CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-19
**Phase:** 10-author-time-simulator-step-preview-dry-run-walkthrough
**Areas discussed:** DryRun UI collision, 9-04 coordination surface, Self-healing behavior during simulator, Editor lock behavior
**Triggered by:** `gsd-phase-researcher` flagged four design conflicts between the initial 10-CONTEXT.md and shipped code. /gsd-discuss-phase 10 re-invoked to resolve before /gsd-plan-phase 10 proceeds.

---

## Area 1: DryRun UI collision with Phase 3

**Context:** 10-CONTEXT.md assumed `DryRunPanel.tsx` was a placeholder. Research (10-RESEARCH.md §Conflict 1) proved it's a shipped Phase 3 feature (plan 03-18) with working UI, Zustand store, tests, and Vietnamese i18n, backed by `intelligence::dryrun::run` + `StubBrowserDriver`.

| Option | Description | Selected |
|--------|-------------|----------|
| Rename Phase 10 as "Simulator" | New SimulatorTimeline.tsx + simulatorStore.ts + simulator_* commands; leave Phase 3 untouched. Schedule Phase 3 deprecation as follow-up. | ✓ |
| Merge into DryRunPanel.tsx | Extend existing panel with timeline scrubber; keep flat-list as fallback. Risk: UI clutter. | |
| Replace Phase 3 entirely | Delete intelligence::dryrun + DryRunPanel; rebuild on Phase 10 foundation. Largest blast radius. | |

**User's choice:** Rename Phase 10 as "Simulator" (Recommended)
**Notes:** Lines up with research's Primary Recommendation. User-visible term "dry-run" stays in ROADMAP.md phase title for product clarity; internal identifiers switch to "simulator" to avoid collision. Phase 3 dry-run co-exists for the duration of Phase 10.

---

## Area 2: Phase 9-04 coordination surface

**Context:** Research (10-RESEARCH.md §Conflict 3) found 09-04-PLAN.md today exposes `start_author_preview` / `stop_author_preview` / `setViewport` / `startPreviewStream(streamId)` — but NOT (a) a way to run Playwright verbs against the author page, or (b) pause/resume on the screencast for exclusive-lock concurrency, or (c) a Page handle from Rust. CONTEXT D-01 ("reuse 9-04's session") is unimplementable against the current 9-04 scope.

| Option | Description | Selected |
|--------|-------------|----------|
| Extend 9-04 scope first | Add PHASE-9.8 (expose Page handle to driver) + PHASE-9.9 (pauseStream/resumeStream RPCs) to 09-04-PLAN.md must_haves. Preserve CONTEXT D-01 shared-session. | ✓ |
| Phase 10 spawns its own Chromium | Drop D-01; Phase 10 gets a third Chromium instance. Simpler per-phase, ~200 MB extra memory. | |
| Defer Phase 10 until 9-04 ships | Do nothing now; revisit once 9-04 is concrete. | |

**User's choice:** Extend 9-04 scope first (Recommended)
**Notes:** Preserves memory budget. Phase 10 plans blocked until 9-04 ships with PHASE-9.8/9.9. 09-04-PLAN.md and ROADMAP.md updated in the same session to reflect the new must_haves.

---

## Area 3: Self-healing behavior during simulator

**Context:** Research Pitfall 3 — Phase 7-04c's `.story.targets.json` self-healing runs inside `Executor::run_story`'s `try_promote_fallback`. A naive simulator run mutates on-disk files without user consent. CONTEXT D-07 originally was missing; research surfaced this as a UX concern.

| Option | Description | Selected |
|--------|-------------|----------|
| Simulator is READ-ONLY by default | Add `self_heal: bool` parameter to executor; simulator passes `false`. Expose explicit "Promote to fallback" button per fuzzy-matched frame. | ✓ |
| Simulator mutates like recording does | Keep current behavior — simulator warms the fallback cache automatically. Matches CONTEXT's original implicit assumption but surprises users. | |

**User's choice:** Simulator is READ-ONLY by default (Recommended)
**Notes:** Locked as D-07 in CONTEXT.md. New Tauri command `simulator_promote_fallback(run_id, ordinal)` is the only path that mutates `.story.targets.json` during a simulator workflow.

---

## Area 4: Editor lock during simulator runs

**Context:** Research Pitfall 5 — CodeMirror's `Decoration.line` position-maps through text edits via `deco.map(tr.changes)`, but if the user DELETES the step line, decorations vanish silently. Simulator runs produce frame→line mappings that go stale on edits.

| Option | Description | Selected |
|--------|-------------|----------|
| Read-only with banner | Lock editor via `EditorState.readOnly = true` + "Simulator running — edits paused" banner. Scrubbing + line-highlight stay functional. | ✓ |
| Invalidate on edit | User can edit freely; edits invalidate timeline (forces re-run). Risk: losing in-progress run from a typo. | |
| Warn but allow edits | Toast on first edit, let decorations go stale. Worst-of-both. | |

**User's choice:** Read-only with banner (Recommended)
**Notes:** Locked as D-08. Banner auto-dismisses on `RunPaused` / `StoryEnded` / `SimulatorCancelled`. Scrubbing the timeline remains enabled throughout.

---

## Claude's Discretion

Left to the planner (per CONTEXT.md "Claude's Discretion" section):
- Exact UI layout of `SimulatorTimeline.tsx` (scrubber style, frame-thumbnail grid vs filmstrip, step-row card style)
- Whether to render a cursor trail across frames or just the current-frame cursor
- Keyboard shortcuts beyond Cmd-. for "Preview to here"
- Error-state UI when a step fails mid-simulation

## Deferred Ideas

- Delete Phase 3 `intelligence::dryrun::*` + `commands/dryrun.rs` + `DryRunPanel.tsx` + `dryRunStore.ts` + `useDryRun.ts` + i18n strings once Phase 10 simulator is stable and users migrate. Explicitly NOT in Phase 10 scope.
- Persistent simulator archives across sessions (v1 keeps 5 most recent on disk).
- Snapshot-only / offline simulator mode.
- Cross-simulator diff view.
