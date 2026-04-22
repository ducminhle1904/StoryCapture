---
phase: 09
plan: 02
subsystem: recorder/live-preview
tags: [preview, canvas, ipc, tauri-event, app-settings, options-toggle]
dependency_graph:
  requires:
    - crates/automation (09-01: PreviewFrame + subscribe_preview + call_preview_start/stop)
    - scripts/playwright-sidecar (09-01: startPreviewStream / stopPreviewStream verbs + preview/frame notifications)
  provides:
    - "start_preview_stream / stop_preview_stream Tauri commands"
    - "preview://frame Tauri event (base64 JPEG payload)"
    - "<LivePreview /> canvas renderer (createImageBitmap + rAF)"
    - "app_settings.live_preview_enabled (persisted, default true)"
    - "recorder store: livePreviewEnabled + setLivePreviewEnabled + hydrateLivePreviewEnabled"
  affects:
    - apps/desktop/src-tauri/src/state/mod.rs
    - apps/desktop/src-tauri/src/commands/automation.rs
    - apps/desktop/src-tauri/src/commands/app_settings.rs
    - apps/desktop/src-tauri/src/error.rs
    - apps/desktop/src-tauri/src/ipc_spec.rs
    - apps/desktop/src/features/recorder/recording-view.tsx
    - apps/desktop/src/state/recorder.ts
    - apps/desktop/src/ipc/settings.ts
    - packages/shared-types/src/ipc.ts (auto-generated)
tech-stack:
  added:
    - "createImageBitmap (browser built-in) — off-main-thread JPEG decode"
  patterns:
    - "latest-wins watch::Receiver → Tauri event pump"
    - "preview driver slot cleared BEFORE automation teardown (isolation)"
    - "AppError::UnavailableOnBackend for non-Playwright capture targets"
    - "ImageBitmap .close() discipline per frame + on unmount"
key-files:
  created:
    - apps/desktop/src/features/recorder/LivePreview.tsx
    - apps/desktop/src/features/recorder/LivePreview.test.tsx
    - apps/desktop/src/ipc/preview.ts
    - .planning/phases/09-live-preview-pane-render-chromium-automation-inside-the-reco/09-02-SUMMARY.md
  modified:
    - apps/desktop/src-tauri/src/state/mod.rs
    - apps/desktop/src-tauri/src/commands/automation.rs
    - apps/desktop/src-tauri/src/commands/app_settings.rs
    - apps/desktop/src-tauri/src/error.rs
    - apps/desktop/src-tauri/src/ipc_spec.rs
    - apps/desktop/src/features/recorder/recording-view.tsx
    - apps/desktop/src/state/recorder.ts
    - apps/desktop/src/ipc/settings.ts
    - packages/shared-types/src/ipc.ts
decisions:
  - "Reuse the shared_pw Arc already constructed in launch_automation for preview_driver — one sidecar instance, two consumer slots (picker + preview)."
  - "preview_driver slot is cleared at story-end via stop_preview_stream_inner(&state) BEFORE playwright_driver is cleared, so the pump's watch::Receiver::changed() resolves on sender drop instead of mid-send."
  - "Recorder-view render predicate uses captureTarget?.kind === 'window_by_pid' to gate LivePreview — matches the auto-follow path that sets window_by_pid after resolvePlaywrightTarget succeeds."
  - "AppError::UnavailableOnBackend added as a dedicated variant; kept separate from AppError::Automation so the webview can render a neutral placeholder rather than surfacing an error toast."
  - "AppSettings migrated from derive(Default) to an explicit Default impl so live_preview_enabled defaults to true (D-11) rather than false."
metrics:
  duration: "~25 min"
  completed: "2026-04-21"
---

# Phase 9 Plan 02: React LivePreview canvas + Options toggle Summary

Renders the 09-01 Chromium screencast inside the Recorder window via a Rust pump task (drains the `watch::Receiver<Option<PreviewFrame>>` and emits a `preview://frame` Tauri event) plus a `<LivePreview />` React canvas that decodes base64 JPEG via `createImageBitmap`, draws at rAF cadence, and cleans up every bitmap. Gated by a persisted `live_preview_enabled` Options toggle (default ON). Capture/encoder crates untouched.

## Tasks executed

| Task | Commit  | Files                                                                                                                                                                                                                                      |
| ---- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1    | 461d1fa | `apps/desktop/src-tauri/src/state/mod.rs`, `commands/automation.rs`, `commands/app_settings.rs`, `error.rs`, `ipc_spec.rs`, `packages/shared-types/src/ipc.ts`                                                                              |
| 2    | b19cabe | `apps/desktop/src/features/recorder/LivePreview.tsx`, `LivePreview.test.tsx`, `recording-view.tsx`, `apps/desktop/src/ipc/preview.ts`, `ipc/settings.ts`, `state/recorder.ts`                                                                |
| 3    | —       | Operator smoke (checkpoint:human-verify) — auto-approved under `workflow.auto_advance=true`; defers to operator alongside existing 01-07 / 05-01 / 05-02 / 05-03 capture-soak checkpoints.                                                  |

## Acceptance gates passed

- `grep -q "start_preview_stream" apps/desktop/src-tauri/src/commands/automation.rs` ✓
- `grep -q "stop_preview_stream" apps/desktop/src-tauri/src/commands/automation.rs` ✓
- `grep -q "preview_driver" apps/desktop/src-tauri/src/state/mod.rs` ✓
- `grep -q "preview_pump" apps/desktop/src-tauri/src/state/mod.rs` ✓
- `grep -q "preview://frame" apps/desktop/src-tauri/src/commands/automation.rs` ✓
- `grep -q "UnavailableOnBackend" apps/desktop/src-tauri/src/error.rs` ✓
- `grep -q "live_preview_enabled" apps/desktop/src-tauri/src/commands/app_settings.rs` ✓
- `grep -q "start_preview_stream" apps/desktop/src-tauri/src/ipc_spec.rs` ✓
- `test -f apps/desktop/src/features/recorder/LivePreview.tsx` ✓
- `test -f apps/desktop/src/features/recorder/LivePreview.test.tsx` ✓
- `test -f apps/desktop/src/ipc/preview.ts` ✓
- `grep -q "createImageBitmap\|.close()\|requestAnimationFrame\|preview://frame" LivePreview.tsx` ✓
- `grep -q "livePreviewEnabled" apps/desktop/src/state/recorder.ts` ✓
- `grep -q "LivePreview" apps/desktop/src/features/recorder/recording-view.tsx` ✓
- `@ts-ignore` / `: any` absent from new files ✓

## Verification results

- **`cargo check` (storycapture):** clean
- **`cargo test --lib` (storycapture):** 62 passed, 0 failed, 1 ignored
- **`pnpm typecheck` (@storycapture/desktop):** clean
- **`pnpm vitest run LivePreview`:** 4/4 green (α listener lifecycle, β decode+rAF+close, γ UnavailableOnBackend fallback, δ re-mount restart) — 205 ms
- **Capture/encoder diff:** `git diff crates/capture/ crates/encoder/` empty ✓

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 — blocking] `AppHandle::emit` required the `tauri::Emitter` trait**
- **Found during:** Task 1 cargo check
- **Issue:** Calling `app_for_emit.emit("preview://frame", &frame)` failed to compile (`no method named emit`) — the method lives on the `tauri::Emitter` trait, not on `Manager`.
- **Fix:** Extended the existing `use tauri::{AppHandle, Manager, State};` to `use tauri::{AppHandle, Emitter, Manager, State};`.
- **Files:** `apps/desktop/src-tauri/src/commands/automation.rs`
- **Commit:** 461d1fa

**2. [Rule 3 — blocking] Vitest β case recursed infinitely through mocked rAF**
- **Found during:** Task 2 vitest run
- **Issue:** Stubbing `requestAnimationFrame` to invoke the callback synchronously caused the draw loop to recurse forever (each draw scheduled the next).
- **Fix:** Capture the latest pending rAF callback into a ref and fire it manually once after the frame handler resolves — measures exactly one draw tick per test.
- **Files:** `apps/desktop/src/features/recorder/LivePreview.test.tsx`
- **Commit:** b19cabe

### Out-of-scope items (deferred, not fixed)

- Build-script auto-emitted edits to `crates/story-parser/src/ast.rs` and `src/lenient_tokenize.rs` (`fn is_none<T>` helper + split serde attrs) appeared while compiling but are unrelated to this plan. Reverted before Task 1's commit so they don't sneak into Wave 2 history — they will show up again on the next build of an unrelated plan and should be resolved there.

## Design notes

- **Why the pump lives in `commands/automation.rs` rather than a new module:** the sidecar driver lifecycle (`launch_automation` → pid stash → preview driver slot → story-end teardown) is already the owning file; splitting the pump into `commands/preview.rs` would have required exposing `stop_preview_stream_inner` through two layers for the `launch_automation` teardown hook. Keeping everything next to the driver keeps the teardown ordering (preview stop BEFORE playwright slot clear) obvious.
- **Why a dedicated `preview_driver` slot instead of reading `playwright_driver`:** the plan explicitly separates them so future waves can null one without the other — e.g. 09-03 backpressure hardening could pause the pump without disturbing the picker or the executor.
- **Why `captureTarget?.kind === "window_by_pid"` as the gate:** the auto-follow path in recording-view swaps captureTarget to `{ kind: "window_by_pid", pid: -1, title_hint: "storycapture-playwright" }` once `resolvePlaywrightTarget()` returns. That sentinel is the only state in which a Playwright sidecar is demonstrably driving a window; display targets correctly fall back to PreviewStage without a placeholder flash.
- **Why `AppError::UnavailableOnBackend` rather than reusing `Automation`:** the webview needs to distinguish "no Playwright session" (render neutral placeholder) from "automation misbehaved" (currently not toasted either, but a future 09-03 wave may want to surface the difference). Dedicated variant keeps that door open without breaking compatibility.

## Downstream handoff for Wave 3 (09-03)

- Pump task currently emits every frame; perf/backpressure hardening (frame-rate cap, adaptive skip under load) is 09-03 scope — the watch channel's latest-wins semantics already absorb slow consumers at the Rust layer, but the webview does not coalesce yet.
- Fallback UX (explicit "Live preview unavailable" card styling + CDP-unavailable telemetry) is 09-03 scope; the current component renders a neutral muted placeholder that does not crash on empty frame streams.
- Editor-surface preview + viewport switcher + PHASE-9.8/9.9 author-session extensions are Wave 4 (09-04); `BrowserDriver` trait remains unchanged per D-05 optional.

## Self-Check: PASSED

- FOUND: `apps/desktop/src/features/recorder/LivePreview.tsx`
- FOUND: `apps/desktop/src/features/recorder/LivePreview.test.tsx`
- FOUND: `apps/desktop/src/ipc/preview.ts`
- FOUND: `apps/desktop/src-tauri/src/commands/automation.rs` (modified)
- FOUND: `apps/desktop/src-tauri/src/commands/app_settings.rs` (modified)
- FOUND: `apps/desktop/src-tauri/src/state/mod.rs` (modified)
- FOUND: `apps/desktop/src-tauri/src/error.rs` (modified)
- FOUND: `apps/desktop/src-tauri/src/ipc_spec.rs` (modified)
- FOUND: `apps/desktop/src/features/recorder/recording-view.tsx` (modified)
- FOUND: `apps/desktop/src/state/recorder.ts` (modified)
- FOUND: `apps/desktop/src/ipc/settings.ts` (modified)
- FOUND commit: 461d1fa
- FOUND commit: b19cabe
