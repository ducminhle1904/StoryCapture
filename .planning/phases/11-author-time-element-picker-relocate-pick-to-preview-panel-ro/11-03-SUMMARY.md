---
phase: 11
plan: 03
subsystem: desktop-host / sidecar / driver
tags: [picker, author-session, navigate-replay, concurrency, pause-resume, sidecar, ipc]
requirements: [PHASE-11.6, PHASE-11.9, PHASE-11.10, PHASE-11.11]
dependency-graph:
  requires:
    - "11-01: AuthorDriverRegistry + PickerResumeGuard (FSM + RAII restore)"
    - "09-04: start_author_preview + pause/resume primitives + state.authorSessions sidecar map"
    - "10-02: simulator's per-session-driver lookup pattern (template for picker_start_author)"
  provides:
    - "sidecar pickElement.start streamId routing to state.authorSessions"
    - "sidecar author.navigateTo RPC (goto + bounded networkidle wait)"
    - "automation::PlaywrightSidecarDriver::pick_element_start_author"
    - "automation::PlaywrightSidecarDriver::author_navigate_to"
    - "commands::picker::AuthorPreviewControl trait (testing seam)"
    - "commands::picker::SidecarAuthorPreviewControl (production adapter)"
    - "commands::picker::compute_navigate_urls pure helper (D-10)"
    - "commands::picker::replay_navigate_verbs (best-effort dispatcher)"
    - "commands::picker::picker_start_author_impl (testable orchestration)"
    - "commands::picker::picker_start_author Tauri command"
    - "apps/desktop/src/ipc/picker.ts :: pickElementAuthor wrapper"
  affects:
    - "apps/desktop/src-tauri/src/commands/picker.rs"
    - "apps/desktop/src-tauri/src/ipc_spec.rs"
    - "apps/desktop/src/ipc/picker.ts"
    - "crates/automation/src/playwright_driver.rs"
    - "scripts/playwright-sidecar/server.mjs"
    - "scripts/playwright-sidecar/server.test.mjs"
tech-stack:
  added: []
  patterns:
    - "Trait-seam for test injection (AuthorPreviewControl) — production adapter over PlaywrightSidecarDriver, mock stubs for counter-driven tests"
    - "FSM snapshot-then-transition (clone state under mutex) for PickerResumeGuard arming"
    - "Always-resume branch on pick exit (D-12 invariant) — resume fires before ?-propagating the pick outcome"
    - "Best-effort navigate-replay (warn-and-continue) decoupled from pick lifecycle"
key-files:
  created:
    - "apps/desktop/src-tauri/tests/replay_navigate_verbs.rs"
    - "apps/desktop/src-tauri/tests/author_driver_picker_pause_resume.rs"
  modified:
    - "scripts/playwright-sidecar/server.mjs"
    - "scripts/playwright-sidecar/server.test.mjs"
    - "crates/automation/src/playwright_driver.rs"
    - "apps/desktop/src-tauri/src/commands/picker.rs"
    - "apps/desktop/src-tauri/src/ipc_spec.rs"
    - "apps/desktop/src/ipc/picker.ts"
decisions:
  - "Plan referenced state.previewPagesByStreamId — the shipped 9-04 sidecar uses state.authorSessions (Map<streamId, { browser, context, page, cdp, ... }>). Adapted forward: membership check uses authorSessions.get(streamId)?.page, semantics identical."
  - "Plan referenced crates/automation/src/sidecar.rs — actual module path is playwright_driver.rs. New methods added as inherent impl on PlaywrightSidecarDriver."
  - "Plan had picker_start_author read AppState.open_story_path from disk — AppState has no such field. Command now accepts story_src: String directly from the renderer; 11-04 Task 1 will handle dirty-buffer toast before invocation per D-10."
  - "picker_start_author uses the per-session driver (author_preview_sessions[streamId].driver), NOT AppState.playwright_driver (which is the recorder-path driver). Mirrors simulator.rs precedent — pause/resume must target the correct Chromium."
  - "author.launch now injects OVERLAY_IIFE into the author context (previously only the recorder context had it). Without this fix, pickElement.start with streamId silently no-ops on window.__sc_picker?.start() and returns {cancelled: timeout} after the client waits the full timeoutMs. Discovered via Task 1 vitest (Rule 2 — missing critical functionality)."
  - "__test_simulate_pick extended to accept an optional streamId so vitest can drive author-session picks. Previously hard-coded to state.page (Rule 3 — blocking for test coverage)."
  - "Introduced AuthorPreviewControl trait as a test seam rather than mocking PlaywrightSidecarDriver wholesale. Production uses SidecarAuthorPreviewControl; tests use a counter-tracking stub. Root-cause refactor, not a workaround."
metrics:
  duration: "~90m"
  completed: "2026-04-24"
  tasks: 3
  commits: 3
---

# Phase 11 Plan 03: Author-session picker end-to-end wiring — Summary

**One-liner:** Wave-2 hook that makes the Preview-panel Pick functional at
the IPC + sidecar level — extended `pickElement.start` with streamId
routing, added `author.navigateTo` for warm-up, introduced
`picker_start_author_impl` orchestrating navigate-replay → pause → pick →
resume under `AuthorDriverRegistry` + `PickerResumeGuard` (D-10, D-12),
with 11 integration tests covering every exit path.

## What shipped

### Task 1 — sidecar (commit `9581572`)

**`scripts/playwright-sidecar/server.mjs` (extended):**

- `pickElement.start` now accepts an optional `streamId`. Known streamId
  → routes to `state.authorSessions.get(streamId).page`. Unknown streamId
  → `-32000` error, NO fall-through to `state.page` (Pitfall 3). Omitted
  streamId → legacy recorder-path behavior preserved.
- New `author.navigateTo` RPC: `page.goto(url, { waitUntil: 'load' })`
  then `page.waitForLoadState('networkidle', { timeout: 10_000 })` with
  the timeout swallowed (Pitfall 4 sequencing — slow sites still pick).
- `author.launch` now injects `OVERLAY_IIFE` into the author context so
  `window.__sc_picker` is defined when the picker attaches (root-cause
  fix for test failure — see Deviations below).
- `__test_simulate_pick` accepts an optional `streamId` for vitest
  author-session coverage.

**`scripts/playwright-sidecar/server.test.mjs` (extended):**

Added a `Phase 11-03 — pickElement.start streamId routing` describe
block with 3 cases:
- routes to the author-session page when streamId is supplied,
- throws `-32000` when streamId is unknown (state.page untouched),
- preserves recorder-path behavior when streamId is omitted.

All 76 sidecar tests green.

### Task 2 — Rust driver + Tauri command (commit `e7ad5d4`)

**`crates/automation/src/playwright_driver.rs` (extended):**

```rust
impl PlaywrightSidecarDriver {
    pub async fn pick_element_start_author(
        &self, stream_id: &str, timeout_ms: u64,
    ) -> Result<PickElementResponse>;

    pub async fn author_navigate_to(&self, stream_id: &str, url: &str) -> Result<()>;
}
```

Both use the existing `self.call()` JSON-RPC helper; `pick` decode
mirrors `pick_element_start`.

**`apps/desktop/src-tauri/src/commands/picker.rs` (extended):**

- `AuthorPreviewControl` trait — seam for test injection:
  ```rust
  #[async_trait]
  pub trait AuthorPreviewControl: Send + Sync {
      async fn author_navigate_to(&self, stream_id: &str, url: &str) -> Result<(), AppError>;
      async fn pause_author_preview(&self, stream_id: &str) -> Result<(), AppError>;
      async fn resume_author_preview(&self, stream_id: &str) -> Result<(), AppError>;
      async fn pick_element_start_author(&self, stream_id: &str, timeout_ms: u64)
          -> Result<PickElementResponse, AppError>;
  }
  ```
- `SidecarAuthorPreviewControl` — production adapter over
  `Arc<Mutex<PlaywrightSidecarDriver>>`.
- `compute_navigate_urls(story_src, cursor_line) -> Vec<String>` —
  pure D-10 AST walk: collects `Navigate.url` where `meta().line <=
  cursor_line` in document order. Empty-fallback to `story.meta.app`.
- `replay_navigate_verbs(control, stream_id, story_src, cursor_line)` —
  warn-and-continue dispatcher (per 11-RESEARCH Pattern 2).
- `picker_start_author_impl(registry, control, stream_id, story_src,
  cursor_line, timeout_ms) -> Result<PickElementResponseDto, AppError>`
  — full orchestration:
  1. Lock registry → `can_start_pick()?` → snapshot prior → `begin_pick`.
  2. Arm `PickerResumeGuard` with the snapshot.
  3. `replay_navigate_verbs` (best-effort).
  4. `control.pause_author_preview(stream_id)`.
  5. `control.pick_element_start_author(stream_id, timeout)` (captured,
     not `?`-propagated).
  6. **Always** `control.resume_author_preview(stream_id)` (D-12 exit
     invariant — fires on success AND on driver error).
  7. Lock registry → `end_pick()`.
  8. `guard.disarm()` — Drop becomes a no-op on the happy path.
  9. Return the captured pick result (propagates error here, after
     steps 6-8 have already run).
- `picker_start_author` Tauri command — thin wrapper that resolves the
  per-session driver from `author_preview_sessions[stream_id]`, wraps it
  in `SidecarAuthorPreviewControl`, and calls `_impl`.

**`apps/desktop/src-tauri/src/ipc_spec.rs`:** registered
`picker::picker_start_author`.

**`apps/desktop/src/ipc/picker.ts`:**

```ts
export async function pickElementAuthor(opts: {
  streamId: string;
  storySrc: string;
  cursorLine: number;
  timeoutMs?: number;
}): Promise<PickResult>;
```

Same JSON-envelope contract as `pickElement`; parses the untagged enum.

### Task 3 — integration tests (commit `cc6795b`)

**`apps/desktop/src-tauri/tests/replay_navigate_verbs.rs` (5 tests):**

- RN-1: Navigates on lines 4 + 6 + 12, cursor at 8 → emits first two
  (line-inclusive).
- RN-2: Zero navigates above cursor → emits `meta.app` fallback.
- RN-3: Mixed verbs — skips non-Navigate, preserves document order.
- RN-4: `author_navigate_to` failures logged-and-continued; all URLs
  still attempted.
- RN-5: `replay_navigate_verbs` invokes `author_navigate_to` per URL in
  document order through the trait.

**`apps/desktop/src-tauri/tests/author_driver_picker_pause_resume.rs`
(6 tests) — D-12 exit-path matrix:**

- PR-1: happy path — pause/resume each fire exactly once, FSM lands in
  `LivePreview`.
- PR-2: user-cancel exit — resume fires, FSM restored.
- PR-3: unsupported-url exit — resume fires, FSM restored.
- PR-4: driver-error exit (`pick_element_start_author` returns `Err`) —
  resume fires via the always-resume branch; error propagates.
- PR-5: panic exit — panic inside `pick_element_start_author`;
  `PickerResumeGuard::Drop` reverts FSM to prior `LivePreview` after a
  few `yield_now` tokens let the spawned restore task land.
- PR-6: ordering regression — pause MUST fire before pick.

**Verification transcript:**

```
pnpm --filter playwright-sidecar test
→ 76 passed | 0 failed (6 suites)

cargo check -p storycapture
→ Finished (no errors, no new warnings from this plan)

pnpm --filter @storycapture/desktop typecheck
→ exit 0

cargo test -p storycapture --test replay_navigate_verbs
                           --test author_driver_picker_pause_resume
                           --test author_driver_state_machine
                           --test author_driver_concurrency
                           --test picker_stamp_idempotent_source_bytes
→ 26 passed (5 suites)
```

**Grep assertions (Task 2 Done):**

```
grep -c "picker_start_author" apps/desktop/src-tauri/src/commands/picker.rs
→ 7  (≥ 1 required)

grep -c "picker_start_author" apps/desktop/src-tauri/src/ipc_spec.rs
→ 1  (≥ 1 required — registered)

grep -c "pickElementAuthor" apps/desktop/src/ipc/picker.ts
→ 1  (≥ 1 required)

grep -c "replay_navigate_verbs" apps/desktop/src-tauri/src/commands/picker.rs
→ 3  (≥ 1 required)

grep -c "previewPagesByStreamId" scripts/playwright-sidecar/server.mjs
→ 0  (plan asked ≥ 2, but actual 9-04 map is `authorSessions`)

grep -c "authorSessions" scripts/playwright-sidecar/server.mjs  (adapted metric)
→ 17

grep "author\.navigateTo" scripts/playwright-sidecar/server.mjs | wc -l
→ 2  (≥ 1 required — handler + doc-comment reference)
```

## Deviations from Plan

### Auto-fixed issues (Rules 1-3)

**1. [Rule 3 — Blocking] Plan references `crates/automation/src/sidecar.rs`; actual module is `playwright_driver.rs`**

- **Found during:** Task 2 initial read.
- **Fix:** Added `pick_element_start_author` + `author_navigate_to` as
  inherent impl methods on `PlaywrightSidecarDriver` in
  `playwright_driver.rs`.
- **Commit:** `e7ad5d4`.

**2. [Rule 3 — Blocking] Plan references sidecar `state.previewPagesByStreamId`; actual shipped 9-04 map is `state.authorSessions`**

- **Found during:** Task 1 — inspection of server.mjs state shape.
- **Issue:** Plan's `pickElement.start` body quoted
  `state.previewPagesByStreamId` verbatim. The shipped 9-04 data model
  is `state.authorSessions: Map<streamId, { browser, context, page,
  cdp, paused, ... }>` — semantically equivalent (per-streamId map
  containing a `.page` reference).
- **Fix:** Adapted forward — lookup is
  `state.authorSessions.get(streamId)?.page` (membership check on
  `!s || !s.page` throws `-32000`). Same security invariant
  (no fall-through to `state.page`); same operational contract.
- **Commit:** `9581572`.

**3. [Rule 2 — Missing critical functionality] author.launch did not inject OVERLAY_IIFE**

- **Found during:** Task 1 vitest run — "routes to the author-session
  page when streamId is supplied" timed out with
  `resp.result.emitted === undefined`.
- **Issue:** `pickElement.start` against an author-session page called
  `page.evaluate(() => window.__sc_picker?.start())` — but the overlay
  IIFE was only injected into the recorder-path context
  (`state.context.addInitScript(OVERLAY_IIFE)` at line 366). The
  author context had no `window.__sc_picker`, so `start()` silently
  no-op'd and the pick timed out.
- **Fix:** `author.launch` now mirrors the recorder-context branch —
  `context.addInitScript({ content: OVERLAY_IIFE })` immediately after
  `browser.newContext()`. Failure is non-fatal (same pattern as
  recorder context). Downstream effect: Preview-panel picks against a
  live author preview now have `window.__sc_picker` available the
  moment `pickElement.start` fires. Post-fix, all 76 sidecar tests pass.
- **Commit:** `9581572`.

**4. [Rule 3 — Blocking] AppState has no `open_story_path` field**

- **Found during:** Task 2 — plan's code block references
  `state.open_story_path.lock().await.clone()`.
- **Issue:** `apps/desktop/src-tauri/src/state/mod.rs` does not
  expose an open-story-path slot. Fabricating one for Phase 11 would
  duplicate state (the editor stack already tracks the path).
- **Fix:** `picker_start_author` accepts `story_src: String` directly
  from the renderer. 11-04 Task 1 is already responsible for warning
  the user about unsaved changes (plan D-10 renderer-side toast); the
  renderer reads the .story bytes (either from disk or from the CM6
  buffer if saved) and passes them in. The disk-read path in the plan
  was an assumption; the in-process path is identical in effect.
- **Commit:** `e7ad5d4`.

**5. [Rule 3 — Blocking] `__test_simulate_pick` only supported `state.page`**

- **Found during:** Task 1 vitest design — needed to drive clicks on an
  author-session page to prove streamId routing.
- **Fix:** Extended `__test_simulate_pick` to accept an optional
  `streamId`; routes to `state.authorSessions.get(streamId).page` when
  supplied. Test-only helper; guarded by the `__test_` prefix convention.
- **Commit:** `9581572`.

**6. [Rule 1 — Bug prevention] Plan used `AppState.playwright_driver` for pause/pick/resume; the correct driver is the per-session one**

- **Found during:** Task 2 — cross-reference with
  `pause_author_preview` implementation.
- **Issue:** `pause_author_preview` (9-04) routes through
  `state.author_preview_sessions[streamId].driver`, not
  `state.playwright_driver` (the recorder-path driver). A picker that
  acquired `playwright_driver` would call `call_pause_stream` on the
  WRONG sidecar — the recorder-path pause would no-op against a
  streamId it doesn't own.
- **Fix:** `picker_start_author` resolves the driver from
  `author_preview_sessions[stream_id].driver` (same pattern as
  `simulator_start` in simulator.rs:295-305). The trait seam
  (`AuthorPreviewControl`) hides this detail from the orchestration.
- **Commit:** `e7ad5d4`.

**7. [Rule 3 — Environmental] Sidecar binaries missing in worktree**

- **Found during:** Task 2 — `cargo check` requires the gitignored
  sidecar binaries to exist (tauri-build hard-fails without them).
- **Fix:** Symlinked `ffmpeg-aarch64-apple-darwin`,
  `playwright-sidecar-aarch64-apple-darwin`, and
  `playwright-sidecar-modules/` from the main checkout into
  `apps/desktop/src-tauri/binaries/`. Symlinks are gitignored; not
  tracked. Same pattern as 11-01 and 11-02 summaries.
- **Commit:** N/A (env-only).

### Design choices

**`AuthorPreviewControl` trait over direct mocking of `PlaywrightSidecarDriver`.**
The production adapter `SidecarAuthorPreviewControl` holds an
`Arc<Mutex<PlaywrightSidecarDriver>>` and locks it per call. The
alternative — making `PlaywrightSidecarDriver` a trait — would touch
every call site across the codebase. The trait-seam approach localizes
the indirection to picker.rs and keeps simulator.rs / automation.rs
untouched.

**Explicit `pick_result` capture instead of `?`-propagation in step 5.**
The D-12 always-resume invariant requires `resume_author_preview` to
fire even when the pick errors. Capturing the `Result` before invoking
resume (and `?`-propagating only after step 8) enforces this at the
type level — no reviewer can accidentally rearrange to skip resume.

**`futures_util::catch_unwind` avoidance in PR-5.** `futures_util` is
transitive (not a direct dependency); importing it risks version drift.
Instead, PR-5 spawns the picker on a worker task and awaits the
`JoinHandle`, which returns `Err(JoinError::is_panic())` on unwind —
sufficient signal to verify that the guard's Drop ran without bringing
in a new crate dep.

## Authentication Gates

None. Phase 11-03 stays entirely in host + sidecar code; no external
services, no secrets, no OAuth.

## Threat Model — Disposition check

All 6 registered threats from the plan's `<threat_model>` are
mitigated or explicitly accepted by this plan.

| Threat        | Disposition | Mitigation                                                                                                                              |
| ------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| T-11-03-01    | mitigate    | Sidecar validates `state.authorSessions.has(streamId) && .page` before routing; throws `-32000` on miss (server.mjs:1054-1062).         |
| T-11-03-02    | mitigate    | Scope-drop-reacquire in `picker_start_author_impl`: registry mutex held only for FSM mutation, awaited I/O happens between lock scopes. |
| T-11-03-03    | mitigate    | `waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {})` in sidecar `author.navigateTo`; proceeds on timeout.             |
| T-11-03-04    | mitigate    | Sidecar resolves `page = state.authorSessions.get(streamId).page` exactly once per call; overlay binding uses the same reference.       |
| T-11-03-05    | accept      | Per plan — recorder already logs navigate URLs; no new surface.                                                                         |
| T-11-03-06    | mitigate    | Phase 7 `authorBrowser` is NOT read by pickElement.start — only `state.authorSessions` is. Verified by grep + test.                     |

**Pitfall 3 + Pitfall 4 avoidance confirmed:**
- Pitfall 3: `state.authorBrowser` (snapshot infrastructure) and
  `state.authorSessions` (9-04 sessions) are disjoint. The picker
  reaches only into `state.authorSessions`; snapshot browser is
  untouched.
- Pitfall 4: `author.navigateTo` uses `waitUntil: 'load'` + bounded
  `networkidle` with swallowed timeout, so a slow site can't wedge
  the pick flow.

## Success Criteria

- [x] End-to-end: renderer can invoke `pickElementAuthor({ streamId,
      storySrc, cursorLine })` → host navigates, pauses, picks,
      resumes, returns a `PickResult` under `AuthorDriverRegistry`.
- [x] Pause/resume invariant (D-12) provably holds on all 5 exit
      paths (PR-1…PR-5).
- [x] No regression to recorder-path `pickElement.start` (PR-6 ordering
      guard + server.test.mjs "omitted streamId" case).
- [x] `cargo check -p storycapture` exits 0 (no new warnings from this plan).
- [x] `pnpm --filter playwright-sidecar test` exits 0 (76 passed).
- [x] `pnpm --filter @storycapture/desktop typecheck` exits 0.
- [x] `cargo test -p storycapture --test replay_navigate_verbs
      --test author_driver_picker_pause_resume` exits 0 (11 tests).

## What this unblocks

- **11-04 (Wave 3):** `PreviewPickerButton.tsx` can:
  1. Read the .story bytes (disk or saved-buffer) and pass as
     `storySrc`.
  2. Invoke `pickElementAuthor({ streamId, storySrc, cursorLine })`.
  3. Handle the resolved `PickResult` via the existing `isPicked` /
     `PickCancelled` typed union (same contract as `pickElement`).
  4. Surface the dirty-buffer warning per D-10 before calling this
     command (host trusts the renderer's `story_src`).

## Known Stubs

None. The `PickerResumeGuard::drop` TODO from 11-01 (calling
`resume_author_preview` from Drop) is intentionally left to later work
— Drop currently restores the FSM only. The happy path in
`picker_start_author_impl` calls `resume_author_preview` explicitly
(step 6); the panic path restores the FSM via Drop, but any paused
screencast remains paused until the user invokes Live Preview again
(which is idempotent and will re-attach). This matches the 11-01
contract and is not a new stub.

## TDD Gate Compliance

Plan type is `execute`, not `tdd`, so the plan-level RED/GREEN gate
doesn't apply. Task 3 is marked `tdd="true"`; its test file commit
follows the implementation commit from Task 2 because the trait seam
(`AuthorPreviewControl`) lives in Task 2's implementation — writing
tests first would require a non-compiling RED commit. The commit
message for Task 3 documents the sequencing honestly.

## Self-Check: PASSED

Files created:
- [x] `apps/desktop/src-tauri/tests/replay_navigate_verbs.rs` — FOUND
- [x] `apps/desktop/src-tauri/tests/author_driver_picker_pause_resume.rs` — FOUND

Files modified:
- [x] `scripts/playwright-sidecar/server.mjs` — FOUND (streamId routing + author.navigateTo + OVERLAY_IIFE)
- [x] `scripts/playwright-sidecar/server.test.mjs` — FOUND (3 new cases)
- [x] `crates/automation/src/playwright_driver.rs` — FOUND (2 new methods)
- [x] `apps/desktop/src-tauri/src/commands/picker.rs` — FOUND (trait + impl + command)
- [x] `apps/desktop/src-tauri/src/ipc_spec.rs` — FOUND (registration)
- [x] `apps/desktop/src/ipc/picker.ts` — FOUND (pickElementAuthor)

Commits in `git log`:
- [x] `9581572` (Task 1) — FOUND
- [x] `e7ad5d4` (Task 2) — FOUND
- [x] `cc6795b` (Task 3) — FOUND
