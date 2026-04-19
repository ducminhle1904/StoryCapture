---
phase: 11
type: context
status: ready-for-planning
date: 2026-04-19
---

# Phase 11: Author-time element picker — Context

**Status:** Ready for planning.
**Depends on:** Phase 7 (picker core — overlay IIFE, ranked generator, `editorController`, `targets.json` schema, `picker_stamp_step_id`), Phase 9-04 (ephemeral author-session, `attach_author_driver(streamId)`, `pauseStream`/`resumeStream` — PHASE-9.8/9.9), Phase 10 (simulator session registry, `simulator_promote_fallback`, editor read-only lock D-08).

<domain>
## Phase Boundary

Relocate the element picker out of the recording flow and into the **Preview panel** of the Editor, where it runs against the **Phase 9-04 author-session** (not the recorder-browser). As a consequence, the Record path becomes a **strictly read-only consumer** of `.story` and `.story.targets.json` — no self-healing writes, no picker UI, no step-id stamping during a recording run.

**In scope:**
- Preview-panel picker entry point (toolbar button + keyboard shortcut) that routes through the author-session.
- Lazy-start of the author-session on first Pick when dormant.
- Context-aware author-browser navigation (replay `navigate` verbs up to cursor line).
- Same-line re-pick that updates `targets.json` only and leaves `.story` bytes unchanged.
- Exclusive-lock coordination between picker and simulator runs via a shared `AuthorDriverState` registry.
- Removal of `PickElementButton` + picking banner + record-time `picker_stamp_step_id` invocation from `recording-view.tsx`.
- Executor recording-path change: `self_heal=false` when invoked from Record; primary-miss surfaces as an actionable error directing the author to Simulator + Promote to fallback.
- Reuse of Phase 7 core modules (overlay IIFE, generator, `editorController`, targets_store, picker.rs) — routing swapped, logic preserved.

**Out of scope:**
- Pending-promotions drawer / post-record accept-reject UI (explicitly rejected — healing lives in Simulator only).
- Caret-line context menu for Pick (toolbar + shortcut only in v1).
- Full replay of clicks/fills/types when warming author-browser (only `navigate` verbs replayed; Phase 10 simulator `run_to_step` is the full-replay tool).
- LLM fallback resolution (Phase 7 Tier 3 deferral stands).
- Deprecation of Phase 3 `DryRunPanel` (Phase 10 Deferred Ideas stands).
- Changes to the recorder-browser lifecycle itself; only its script/targets mutation surface area is removed.

</domain>

<decisions>
## Implementation Decisions (LOCKED)

### Area 1 — Picker placement, invocation & re-pick

- **D-01: Primary entry point is a Preview-panel toolbar button + `Cmd-Shift-P` shortcut.** Crosshair icon in the Preview toolbar. No caret-line context menu in v1. Button lives in a new `apps/desktop/src/features/editor/PreviewPickerButton.tsx` and is mounted inside `preview-panel.tsx`.
- **D-02: Pick is enabled whenever the author-session is up, independent of the Live Preview toggle.** Lazy-start (D-09) handles the dormant case. Live Preview visibility is orthogonal — the overlay does not require a streaming canvas.
- **D-03: During an active pick, the author-session screencast is paused.** Picker calls `pauseStream(streamId)` at start and `resumeStream(streamId)` on resolve/cancel. Overlay renders in the author-browser viewport without screencast contention. Leverages PHASE-9.9.
- **D-04: Same-line re-pick updates `targets.json` only; `.story` source bytes are never rewritten by a re-pick.** When the cursor sits on an existing step with a trailing `# @id=<uuid>`, a new Pick upserts the primary in `targets.json` and demotes the prior primary to `fallbacks[0]` (same invariant as Phase 7 self-healing, same algorithm as `simulator_promote_fallback`). Source text remains byte-identical. Re-pick on a step without `@id` stamps one via the existing `picker_stamp_step_id` idempotent path.

### Area 2 — Record-path read-only policy & Phase 7 migration

- **D-05: `PickElementButton` and the picking banner are removed from the recording toolbar.** Delete the recorder-view wiring; the component file either moves to `apps/desktop/src/features/editor/` or is replaced by the new `PreviewPickerButton` (see D-11). Record toolbar no longer surfaces any picker affordance.
- **D-06: Recording runs pass `self_heal=false` to `Executor::run_story`.** Primary-miss during a recording surfaces as a normal `wait_actionable` timeout. The user-facing error message directs the author to open the story in Simulator and use "Promote to fallback" (Phase 10 D-07). No on-disk mutation of `.story.targets.json` occurs on the recording path.
- **D-07: No pending-promotions buffer is introduced.** There is no `.story.targets.pending.json`, no post-record review drawer. Simulator + `simulator_promote_fallback` is the single healing surface.
- **D-08: Phase 7 core modules are reused; only the driver routing is swapped.** `editorController`, overlay IIFE + bundler, ranked generator, `picker_stamp_step_id` atomic write, `targets_store` POSIX-atomic rewrite — all kept as-is. The Tauri command layer in `apps/desktop/src-tauri/src/commands/picker.rs` is extended (not forked) to route to the author-session driver when invoked by the Preview-panel button. The sidecar `pickElement.*` RPCs work against whichever `streamId` the command carries.

### Area 3 — Author-session lifecycle for picking

- **D-09: Author-session is lazy-started on first Pick when dormant.** Clicking `PreviewPickerButton` with no live author-session → the button enters a `starting…` state; the sidecar boots a headed author-browser, navigates per D-10, injects the overlay, then activates pick. Subsequent picks within the idle window are instant.
- **D-10: On session warm-up (or when picker needs to relocate the author-browser), replay only `navigate` verbs from scene start up to the cursor line.** Click / Type / Hover / Wait verbs are **not** replayed by this path. Rationale: cheap (<2s for typical stories) and lands the author on the right route; full replay is Phase 10 simulator territory. If the `.story` above cursor contains no `navigate` verbs, default to `meta.app`.
- **D-11: Author-session idle-timeout is 10 minutes.** Sidecar shuts the session on 10 min of no activity from Live Preview, Simulator, or Picker. Matches Phase 9-04's proposed lifecycle. Next Pick re-triggers D-09 lazy-start.
- **D-12: Picker acquires the author-driver via `pauseStream` → exclusive CDP control → `resumeStream`.** Same pause/resume primitives Simulator uses (D-06 Phase 10). Resolve and cancel paths both guarantee `resumeStream` is called.

### Area 4 — Concurrency with simulator runs

- **D-13: Pick is disabled while a simulator run is in `Running` state.** `PreviewPickerButton` greys out with tooltip `Simulator running — cancel to pick`. Aligns with Phase 10 D-08 editor read-only invariant and avoids surprise cancellation.
- **D-14: Pick IS allowed while a simulator run is in `RunPaused` state (e.g. after "Preview to here").** The paused driver state is preserved; picker takes exclusive control via the shared `AuthorDriverState` transition `Paused → Picking(from_paused)`. On pick resolve/cancel, state transitions back to `Paused` and the simulator remains resumable. Supports the natural "Preview to here → pick the missing button" flow.
- **D-15: Simulator start is blocked while Pick is active.** The simulator-start button (or Cmd-.) renders disabled with tooltip `Picking — press Esc`. Matches Phase 10 D-11's "never shared" invariant.
- **D-16: Author-driver exclusive lock lives in a single shared registry.** New `apps/desktop/src-tauri/src/author_driver.rs` exports a `tokio::Mutex<AuthorDriverState>` with an enum:
  ```rust
  enum AuthorDriverState {
      Idle,
      LivePreview { stream_id: StreamId },
      Picking { stream_id: StreamId, resume_to: Option<Box<AuthorDriverState>> },
      SimulatorRunning { session: SimulatorSessionId },
      SimulatorPaused { session: SimulatorSessionId },
  }
  ```
  Both `commands/picker.rs` and `commands/simulator.rs` acquire the same lock. State transitions are the single authority on `pauseStream`/`resumeStream` invocation and on which UI button is enabled.

### Claude's Discretion

- Exact Tauri command names on the new author-session picker path (e.g., `author_pick_start` vs `picker_start_author`) — planner picks, consistent with existing naming.
- UI copy for disabled-state tooltips.
- Whether to expose `AuthorDriverState` transitions as a `Channel<T>` to the frontend (for reactive button enablement) or to derive UI state from Simulator/Preview event streams — planner picks.
- Loading/error UI for the `starting…` state on first Pick.
- Whether the toolbar Pick button shows a keyboard hint ("⌘⇧P") inline or on hover.
- Telemetry hooks (if any) for "pick succeeded / cancelled / session-warmup-failed" — opt-in only per PROJECT.md.
- Specific `navigate` replay error handling (e.g., 404 during warm-up replay) — planner decides UX.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase 7 picker baseline (reuse targets)
- `apps/desktop/src-tauri/src/commands/picker.rs` — current record-path Tauri command surface; Phase 11 extends for author-session routing.
- `apps/desktop/src/ipc/picker.ts` — TS IPC wrapper; extend with author-session variant.
- `apps/desktop/src/features/recorder/pick-element-button.tsx` — source of the component being retired/moved; existing disable/enable/banner logic worth porting.
- `apps/desktop/src/features/editor/controller.ts` — `editorController` singleton, `insertAtCursor`, undo semantics. Phase 11 reuses verbatim.
- `scripts/playwright-sidecar/server.mjs` — `pickElement.start/cancel/isActive`, `captureSnapshot`, author-browser state. Phase 11 extends to accept `streamId`.
- `scripts/playwright-sidecar/picker/overlay/` — overlay IIFE + accessible-name-lite + ranked generator. Unchanged.
- `crates/automation/src/targets_store.rs` — `.story.targets.json` atomic read/write. Unchanged.
- `crates/automation/src/executor.rs` — `try_promote_fallback`, `run_with_story_path`. Phase 11 flips the `self_heal` invocation on the record path.

### Phase 9-04 author-session surface (dependency)
- `.planning/phases/09-.../09-04-PLAN.md` (when it lands) — must expose `attach_author_driver(streamId)`, `pauseStream(streamId)`, `resumeStream(streamId)` per Phase 10 D-06.
- `apps/desktop/src-tauri/src/commands/author_snapshot.rs` — existing author-browser state; coordinate, do not fork.

### Phase 10 coordination
- `.planning/phases/10-author-time-simulator-step-preview-dry-run-walkthrough/10-CONTEXT.md` — D-06/07/08/10/11 define author-session, read-only-by-default, editor lock, IPC hygiene, session registry.
- `.planning/phases/10-.../10-01-PLAN.md`, `10-02-PLAN.md`, `10-03-PLAN.md` — executor parameterization, simulator command registry, Preview UI chrome. Phase 11 dovetails via the shared `AuthorDriverState`.

### Phase 7 context (history + invariants)
- `.planning/phases/07-semantic-dsl-verbs-accessibility-first-locators-tier-1/07-CONTEXT.md` — Tier 2 decisions still in force (emission order, overlay bundle, URL allowlist, nav mid-pick cancel).
- `.planning/phases/07-.../07-03b-SMOKE.md`, `07-04c-SMOKE.md` — record-path smoke runbooks to be rewritten in Phase 11 deliverable.
- `.planning/phases/07-.../deferred-items.md` — open Phase 7 polish items; surface any that Phase 11 resolves.

### Project
- `CLAUDE.md` — Agent Working Rules (no workarounds, no co-author trailer), tech stack, concise comments rule.
- `.planning/ROADMAP.md` — Phase 11 entry (just added 2026-04-19).

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **`editorController` (apps/desktop/src/features/editor/controller.ts)** — module-level singleton with `setView` / `insertAtCursor` / `isReady` / `setStoryPath`. Picker inserts single-undo atomic changes through this. Reuse verbatim.
- **`picker.rs` Tauri command module** — already handles start/cancel plumbing to sidecar. Extend with a `streamId` carrier to route to author-session.
- **Overlay IIFE + ranked generator + accessible-name-lite** — all in `scripts/playwright-sidecar/picker/`. No changes needed beyond accepting which page handle to inject into.
- **`targets_store.rs`** — POSIX-atomic `.story.targets.json` read/write. Same file format; used from both record (reader-only in Phase 11) and author (writer) paths.
- **`picker_stamp_step_id` idempotent UUIDv7 stamp** — works per cursor line; reuse for first-pick-on-line stamping in author path.
- **`preview-panel.tsx`** — Preview panel host; `PreviewPickerButton` mounts here.
- **`controller.test.ts`, `pick-element-button.test.tsx`** — test scaffolding + Tauri mocks; adapt, don't rewrite.

### Established Patterns
- Tauri commands in `commands/*.rs` export typed wrappers; TS sides live in `apps/desktop/src/ipc/`. Mirror this for any new author-session picker entrypoint.
- Sidecar JSON-RPC methods use dot-namespaced names (`pickElement.start`, `captureSnapshot`, `author.*`). New author-session picker variant should stay in this family.
- Zustand stores for UI state (e.g. `simulatorStore`, `dryRunStore`); new `authorDriverStore` — if needed for reactive button enablement — follows the same idiom.
- `StoryEditor` wires `cmRef.current?.view` to `editorController` in `useEffect`. Keep contract untouched.

### Integration Points
- **`preview-panel.tsx`** — mount point for `PreviewPickerButton`.
- **`recording-view.tsx`** — deletion site for shipped Phase 7 picker button + banner; verify all references removed including tests.
- **`commands/picker.rs` + `commands/simulator.rs` + new `author_driver.rs`** — single `AuthorDriverState` mutex shared across commands.
- **`Executor::run_story` call site in recording path** — flip `self_heal` arg to `false`.
- **`Executor::run_story` call site in simulator path** — already `self_heal=false` per Phase 10 D-07; no change.
- **`recorder` feature error surface** — extend the wait_actionable timeout error with actionable "Open in Simulator" guidance.

</code_context>

<specifics>
## Specific Ideas

- **Error message template** when recording hits a stale primary: `Step N: "<verb> <target>" could not match any element. Self-healing is disabled during recording. Open this story in Simulator, use "Promote to fallback" on step N, then try again.`
- **`AuthorDriverState` transition table** to be captured as a source-level doc-comment in `author_driver.rs` — at minimum the Idle↔LivePreview↔Picking, Idle↔SimulatorRunning↔SimulatorPaused, SimulatorPaused↔Picking{resume_to=SimulatorPaused} transitions.
- **Picker session re-entry from `SimulatorPaused`** is the only transition that carries a `resume_to` box; all other Picking exits go to `LivePreview` or `Idle`.
- **Preview panel toolbar layout:** Pick button sits to the left of the existing viewport/quality controls; when disabled, it grays out with a tooltip string (not a separate modal).
- **Keyboard shortcut `Cmd-Shift-P`** chosen to avoid collision with Cmd-P (command palette if introduced) and Cmd-. (Phase 10 "Preview to here").

</specifics>

<deferred>
## Deferred Ideas

- **Caret-line context menu entry ("Pick element here" / "Re-pick this step")** — discoverability nice-to-have. Not in v1.
- **Full-replay warm-up (click/type/hover, not just `navigate`)** — overlaps with Phase 10 simulator `run_to_step`; users can "Preview to here" first, then Pick.
- **Tauri `Channel<AuthorDriverState>` stream to frontend** — if planner determines Simulator/Preview event streams already cover the UI needs, skip. Revisit if UI enablement logic grows brittle.
- **Pending-promotions buffer + review drawer** — explicitly rejected by D-07. Resurface only if record-path timeouts become a common operator complaint.
- **Persistent author-session across project switches** — out of scope; each project gets a fresh author-session.
- **Cross-frame / cross-origin picker** — Phase 7 limitation (cross-origin iframe contexts). Not solved here.
- **"Pick multiple" batch mode** — picking several elements before resolving. Out of scope for v1.

</deferred>

---

*Phase: 11-author-time-element-picker-relocate-pick-to-preview-panel-ro*
*Context gathered: 2026-04-19*
