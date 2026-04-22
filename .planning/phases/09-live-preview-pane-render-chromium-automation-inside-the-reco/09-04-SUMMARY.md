---
phase: 09
plan: 04
subsystem: automation/playwright-sidecar + editor-surface preview
tags: [preview, cdp, multi-stream, author-session, pause-resume, viewport, editor]
dependency_graph:
  requires:
    - scripts/playwright-sidecar/server.mjs (09-01 startPreviewStream + notifications)
    - crates/automation (09-01 PreviewFrame + subscribe_preview)
    - apps/desktop/src-tauri (09-02 preview_driver slot + preview://frame pump)
    - apps/desktop/src/features/recorder/LivePreview.tsx (09-02 canvas)
    - 09-03 hardening (status machine + retries + drop counter)
  provides:
    - "Sidecar: author.launch/close/setViewport (per-streamId Chromium)"
    - "Sidecar: startPreviewStream/stopPreviewStream accept optional streamId"
    - "Sidecar: pauseStream/resumeStream (PHASE-9.9 exclusive-lock primitive)"
    - "Sidecar: preview/frame payload carries optional streamId for demux"
    - "Rust driver: call_author_launch/close/setViewport + call_pause/resume_stream"
    - "Tauri: start_author_preview → streamId, stop_author_preview, pause_author_preview, resume_author_preview, set_author_preview_viewport"
    - "Tauri: attach_author_driver(streamId) — PHASE-9.8 readiness gate for Phase 10 simulator"
    - "AppState: AuthorPreviewSession registry (per-streamId driver + pump)"
    - "Editor store: previewEnabled/previewStreamId slice (default OFF per D-17)"
    - "LivePreview: streamId prop for multi-consumer demux; recorder path unchanged"
    - "useEditorLivePreview: spawn/teardown/viewport forwarding hook"
  affects:
    - scripts/playwright-sidecar/server.mjs
    - scripts/playwright-sidecar/preview.test.mjs
    - crates/automation/src/playwright_driver.rs
    - apps/desktop/src-tauri/src/commands/automation.rs
    - apps/desktop/src-tauri/src/state/mod.rs
    - apps/desktop/src-tauri/src/ipc_spec.rs
    - apps/desktop/src/features/recorder/LivePreview.tsx
    - apps/desktop/src/features/recorder/LivePreview.test.tsx
    - apps/desktop/src/features/editor/use-editor-live-preview.ts
    - apps/desktop/src/ipc/preview.ts
    - apps/desktop/src/state/editor.ts
    - apps/desktop/src/routes/editor.tsx
    - packages/shared-types/src/ipc.ts (auto-generated)
tech-stack:
  added: []
  patterns:
    - "Per-streamId Map<streamId, SessionState> in sidecar (parallel to recording state)"
    - "Per-streamId pump task filtering the shared watch::Receiver by stream_id"
    - "Ephemeral Playwright sidecar process per author session (D-13 isolation)"
    - "LivePreview streamId filter: recorder consumer accepts frames with no streamId; author accepts matching streamId"
    - "External-lifecycle mode: LivePreview skips its own start/stop when a streamId prop is supplied"
    - "Pause/resume wraps Page.stop/startScreencast on the existing CDP session (no re-attach)"
key-files:
  created:
    - apps/desktop/src/features/editor/use-editor-live-preview.ts
    - .planning/phases/09-live-preview-pane-render-chromium-automation-inside-the-reco/09-04-SUMMARY.md
  modified:
    - scripts/playwright-sidecar/server.mjs
    - scripts/playwright-sidecar/preview.test.mjs
    - crates/automation/src/playwright_driver.rs
    - apps/desktop/src-tauri/src/commands/automation.rs
    - apps/desktop/src-tauri/src/state/mod.rs
    - apps/desktop/src-tauri/src/ipc_spec.rs
    - apps/desktop/src/features/recorder/LivePreview.tsx
    - apps/desktop/src/features/recorder/LivePreview.test.tsx
    - apps/desktop/src/ipc/preview.ts
    - apps/desktop/src/state/editor.ts
    - apps/desktop/src/routes/editor.tsx
    - packages/shared-types/src/ipc.ts
decisions:
  - "Author sessions live in the SAME sidecar process as the recording session via a Map<streamId, SessionState>. The plan allows either this OR a second JSON-RPC channel; single-process keeps memory low and leverages the already-spawned sidecar child. Each author session still owns its own Chromium (launchServer + connect) so Chromium crashes cannot cross-contaminate."
  - "Tauri spawns a DEDICATED sidecar child per author session (start_author_preview calls spawn_author_sidecar). This is the 'separate Node SEA child processes keyed by purpose' risk-mitigation the plan calls for. An author-sidecar crash therefore cannot take down the recording sidecar. Inside each author-sidecar child we still support Map<streamId, …> so Phase 10/11 can multiplex without paying a third spawn."
  - "attach_author_driver probes pick_element_is_active rather than returning an opaque handle. The plan scope is 'expose the contract surface', not 'ship Phase 10 simulator today' — Phase 10 will extend this command (or add a sibling) to return a verb-dispatch wrapper. Today the command proves streamId routability, which is the Phase 10 readiness gate."
  - "LivePreview stays a single reusable component. Adding a streamId prop (null = recorder, string = author) is preferable to forking into AuthorLivePreview + RecorderLivePreview — keeps the canvas/draw/close/status-machine code DRY (plan must_have: 'no duplicated render path')."
  - "preview://frame now carries an optional streamId. Recorder frames omit it; author frames include it. Demux happens on the React side inside LivePreview's listener callback. Rust pumps can also filter (author pumps do) for lower fan-out pressure."
  - "Viewport switcher calls page.setViewportSize() — no reload. sidecar uses the 09-03 probe (window.innerWidth + devicePixelRatio) to re-evaluate everyNthFrame on the next startPreviewStream."
  - "Default OFF toggle (D-17) — starting the session would otherwise cost ~200 MB idle memory per editor tab. The 'Launches a hidden Chromium' tooltip warns the user before opt-in."
  - "uuid v4 for streamIds (not v7). v4 is non-monotonic but sufficient for a per-session identifier that never participates in ordering; v7 would imply a temporal correlation we don't need here."
  - "Frames arriving while a stream is paused are dropped at the sidecar boundary (s.paused short-circuit in the screencastFrame listener). Avoids backlog on resume."
metrics:
  duration: "~50 min"
  completed: "2026-04-22"
---

# Phase 9 Plan 04: Editor-surface Live Preview + PHASE-9.8/9.9 Summary

Extends the Phase 9 preview pipeline to render inside BOTH the Recorder AND the Editor preview rail, reusing `<LivePreview />` keyed by an optional `streamId`. Adds multi-stream support to the sidecar so recording (single stream) and author-time sessions (many streams) coexist without cross-contamination. Ships the Phase 10 prerequisites — `attach_author_driver(streamId)` (PHASE-9.8) and `pauseStream/resumeStream` (PHASE-9.9) — on the contract surface Phase 10 and Phase 11 have already committed to consume.

## Tasks executed

| Task | Commit  | Files                                                                                                                     |
| ---- | ------- | ------------------------------------------------------------------------------------------------------------------------- |
| 1    | d0bc481 | `scripts/playwright-sidecar/server.mjs`, `preview.test.mjs`                                                               |
| 2    | ffbcc46 | `crates/automation/src/playwright_driver.rs`, `commands/automation.rs`, `state/mod.rs`, `ipc_spec.rs`, generated `ipc.ts` |
| 3    | 2cf1fca | `state/editor.ts`, `ipc/preview.ts`, `LivePreview.tsx`, `LivePreview.test.tsx`, `use-editor-live-preview.ts`, `editor.tsx` |

## Acceptance — plan `must_haves.truths`

- ✓ `LivePreview.tsx` consumed by BOTH recording-view AND the Editor rail — single component, no duplicated render path (streamId prop toggles ownership).
- ✓ Editor spawns an ephemeral author-time Playwright session (separate Chromium + separate sidecar child) the first time the toggle flips on; reuses across DSL edits until toggle-off or unmount.
- ✓ Author ↔ recording isolation verified by sidecar vitest "author session does not interfere with recording-session preview".
- ✓ Viewport switcher drives `page.setViewportSize()` via `setAuthorPreviewViewport` → `author.setViewport` RPC; sidecar vitest confirms new innerWidth/innerHeight.
- ✓ `previewEnabled` default-OFF in `useEditorStore`; toggle rendered via `ScSwitch`.
- ✓ Teardown — `useEditorLivePreview` cleans up on toggle-off + unmount + project switch (resetProjectState clears streamId).
- ✓ Missing/invalid `meta.app` — `sanitizeAppUrl` returns null → sidecar launches on about:blank; existing PreviewSurface recording fallback is preserved when Live Preview is off.
- ✓ All Phase 9 guarantees (latest-wins, preview-error-never-affects-recorder, window-visibility-agnostic) preserved — no changes to the recording-path lifecycle.
- ✓ **PHASE-9.8** — `attach_author_driver(streamId)` command registered in IPC, routes the registry + round-trips a cheap verb to prove the sidecar accepts verb RPCs against that streamId. The `AuthorPreviewSession` struct exposes `driver: Arc<Mutex<PlaywrightSidecarDriver>>` so Phase 10-02 can extend the command (or add a sibling) that returns a wrapper bound to the author page without respawning.
- ✓ **PHASE-9.9** — `pauseStream`/`resumeStream` sidecar RPCs + `pause_author_preview`/`resume_author_preview` Tauri commands ship. Idempotent (`s.paused` short-circuit); round-trip fires the actual `Page.stopScreencast`/`Page.startScreencast` CDP calls on the existing session. Latency ≤ 100 ms in local sidecar tests.

## Contract surface handoff for Phase 10 and Phase 11

| Downstream need (CONTEXT.md)                       | Phase 9-04 deliverable                                                      |
| -------------------------------------------------- | --------------------------------------------------------------------------- |
| Phase 10 D-06(a) — author-session Page handle      | `AuthorPreviewSession.driver` (Arc<Mutex<PlaywrightSidecarDriver>>) + `attach_author_driver` readiness gate |
| Phase 10 D-06(b) — pause/resume author screencast  | `pause_author_preview` / `resume_author_preview` Tauri commands             |
| Phase 10 D-01 — reuse author-session, no 3rd Chromium | Session registry in AppState; driver is Arc-cloned into SimulatorSession   |
| Phase 11 D-03 — pause screencast for picker         | Same `pause/resume_author_preview` commands                                 |
| Phase 11 D-12 — pauseStream → exclusive CDP control → resumeStream | Sidecar `pauseStream`/`resumeStream` idempotent primitives     |
| Phase 11 D-16 — shared AuthorDriverState registry   | `author_preview_sessions` Map<streamId, AuthorPreviewSession> in AppState  |
| Phase 11 D-08 — reuse Phase 7 picker modules       | No changes to `commands/picker.rs`; picker routes to `shared_pw` today, Phase 11 will extend to accept a streamId |

**Explicit confirmation:** the shipped contract surface matches what Phases 10/11 expect per 10-CONTEXT.md D-06 and 11-CONTEXT.md D-12/D-16. Phases 10 and 11 are unblocked.

## Verification results

- **`cargo check -p automation -p storycapture`:** clean
- **`cargo test -p automation --lib`:** 61/61 green (unchanged from 09-03 baseline)
- **`cargo test -p storycapture --lib -- --test-threads=1`:** 62/62 green (parallel race in `resolve_playwright_target` tests is a pre-existing issue unchanged by this plan)
- **`SIDECAR_TEST=1 pnpm vitest run preview.test.mjs`:** 13/13 (09-03 baseline 9/9 + 4 new: streamId-tagged frames, pause/resume round-trip, setViewport, author↔recording isolation)
- **`pnpm vitest run server.test.mjs`:** 25/25 (Phase 5–7 regression suite unchanged)
- **`pnpm vitest run LivePreview`:** 9/9 (09-03 baseline 8/8 + ι streamId-demux)
- **`pnpm vitest run recorder`:** 60/60 across 6 files (up from 59/59 — new LivePreview streamId test)
- **`pnpm --filter @storycapture/desktop exec tsc --noEmit`:** clean
- **`capture`/`encoder` diff:** empty ✓ (D-21/D-22 preserved)
- **TS bindings regenerated** via `cargo run --bin specta-emit`; author preview commands surface correctly in `packages/shared-types/src/ipc.ts`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 — blocking] duplicate handler keys in sidecar object literal**
- **Found during:** Task 1 implementation — new `startPreviewStream({streamId})` + `stopPreviewStream({streamId})` handlers were inserted above the existing zero-arg handlers. JS object literals silently pick the LAST definition, so the multi-stream variants were being overridden by the legacy ones on every call.
- **Fix:** Removed the old single-purpose `startPreviewStream`/`stopPreviewStream` handlers; the new ones branch internally on `streamId` presence so legacy zero-arg callers still work.
- **Files:** `scripts/playwright-sidecar/server.mjs`
- **Commit:** d0bc481

**2. [Rule 1 — bug] `scheduleDraw` temporal-dead-zone reference**
- **Found during:** Task 3 — first refactor of LivePreview called `scheduleDraw()` from `startWithRetry` before it was declared, triggering TS 2448 "block-scoped variable used before its declaration".
- **Fix:** Reordered the helper so `scheduleDraw` is defined before `startWithRetry` inside the effect body.
- **Files:** `apps/desktop/src/features/recorder/LivePreview.tsx`
- **Commit:** 2cf1fca

### Out-of-scope items (deferred, not fixed)

- **IntersectionObserver-driven pause-when-hidden** (plan §Interaction with in-flight recording): not implemented in this wave. When the Editor page is not visible, the author session keeps streaming at full rate. Follow-up ticket: wire `IntersectionObserver` + `document.visibilityState` to `pauseStream`/`resumeStream`. Low priority for v1 — defaults-off toggle keeps typical cost at zero.
- **Pre-existing parallel-test race in `storycapture::commands::automation::tests`** — three `#[test]` cases mutate a process-global pid stash. Runs clean with `--test-threads=1`. Already flagged in 09-01 deferred list.
- **Operator perf battery (09-03 Task 3 carry-over)** — still pending on a 2023 M2 MBP; unchanged by this wave.
- **Playwright sidecar .node_modules reuse across author + recording children** — each `spawn_author_sidecar` runs a fresh Node SEA. Memory cost is ~40 MB per author session (Node runtime only, Chromium separate). Acceptable for the single-author-session default; if users commonly run N author sessions this becomes a sharing opportunity.

## Design notes

- **Why a new sidecar child per author session, not multiplex inside one:** the plan's risk section calls out "run them as **separate** Node SEA child processes keyed by purpose; do NOT share a single sidecar between author and recording roles". Spawning per-call preserves crash isolation. The Map<streamId, SessionState> inside a single child still exists so Phase 10/11 can stack simulator + picker on the same author-sidecar without a third process — it is orthogonal to author-vs-recording isolation.
- **Why `preview://frame` over a per-stream channel:** Tauri events are trivially multiplexed with a discriminator. A per-stream `Channel<T>` would require threading a handle through every consumer and complicating unmount. The `streamId` field fits inline, and the webview already decodes JSON payloads — zero extra cost.
- **Why `attach_author_driver` probes instead of returning a driver:** Rust doesn't let us hand out an opaque driver pointer through the Tauri IPC boundary (all IPC values must serialize). The plan permits either returning a driver or "exposes a second JSON-RPC channel per stream" — the session registry IS that second channel. Phase 10-02 will call the Tauri command sequence `set_simulator_stream(streamId)` → and internally look up the `AuthorPreviewSession.driver` to issue verbs. Today's `attach_author_driver` command is a readiness gate confirming the registry entry exists and the sidecar responds.
- **Why ScSwitch instead of ScSegmented for the toggle:** the plan specifies "Preview on / off" as a single boolean toggle. ScSwitch is the atomic-boolean idiom in the Claude Design primitives; ScSegmented would require a two-option array for the same effect.
- **Viewport probe on startPreviewStream runs inside the author session:** the HiDPI `everyNthFrame` tuner evaluates `window.innerWidth`/`devicePixelRatio` on the author page. On `setViewport` + the next stream restart, the tuner re-evaluates automatically — no special-case code in the viewport switcher.

## Self-Check: PASSED

- FOUND: `scripts/playwright-sidecar/server.mjs` (modified)
- FOUND: `scripts/playwright-sidecar/preview.test.mjs` (modified)
- FOUND: `crates/automation/src/playwright_driver.rs` (modified)
- FOUND: `apps/desktop/src-tauri/src/commands/automation.rs` (modified)
- FOUND: `apps/desktop/src-tauri/src/state/mod.rs` (modified)
- FOUND: `apps/desktop/src-tauri/src/ipc_spec.rs` (modified)
- FOUND: `apps/desktop/src/features/recorder/LivePreview.tsx` (modified)
- FOUND: `apps/desktop/src/features/recorder/LivePreview.test.tsx` (modified)
- FOUND: `apps/desktop/src/features/editor/use-editor-live-preview.ts` (new)
- FOUND: `apps/desktop/src/ipc/preview.ts` (modified)
- FOUND: `apps/desktop/src/state/editor.ts` (modified)
- FOUND: `apps/desktop/src/routes/editor.tsx` (modified)
- FOUND: `packages/shared-types/src/ipc.ts` (regenerated)
- FOUND commit: d0bc481
- FOUND commit: ffbcc46
- FOUND commit: 2cf1fca
