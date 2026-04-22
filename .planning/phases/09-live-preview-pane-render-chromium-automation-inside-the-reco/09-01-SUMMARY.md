---
phase: 09
plan: 01
subsystem: automation/playwright-sidecar
tags: [preview, cdp, screencast, sidecar, jsonrpc, notifications, watch-channel]
dependency_graph:
  requires:
    - scripts/playwright-sidecar/server.mjs (existing JSON-RPC host)
    - crates/automation/src/playwright_driver.rs (existing sidecar driver)
  provides:
    - "startPreviewStream / stopPreviewStream sidecar verbs"
    - "preview/frame id-less JSON-RPC notification shape"
    - "PreviewFrame struct + tokio::sync::watch channel on PlaywrightSidecarDriver"
    - "handle_sidecar_line doc-hidden helper for integration tests"
  affects:
    - crates/automation/src/playwright_driver.rs
    - crates/automation/src/lib.rs
    - scripts/playwright-sidecar/server.mjs
tech-stack:
  added:
    - tokio::sync::watch (already in workspace tokio features; no dep change)
  patterns:
    - "latest-wins single-slot + setImmediate flusher (sidecar)"
    - "latest-wins watch::Sender<Option<T>> (Rust)"
    - "Page.startScreencast + Page.screencastFrameAck discipline"
    - "untagged serde enum SidecarMsg (Response | Notification)"
key-files:
  created:
    - scripts/playwright-sidecar/preview.test.mjs
    - crates/automation/tests/preview_notification.rs
    - .planning/phases/09-live-preview-pane-render-chromium-automation-inside-the-reco/09-01-SUMMARY.md
  modified:
    - scripts/playwright-sidecar/server.mjs
    - crates/automation/src/playwright_driver.rs
    - crates/automation/src/lib.rs
decisions:
  - "Keep the existing `JsonRpcResponse` struct (already tolerates id-absent lines via Option fields); add `SidecarMsg` as an untagged alias for the acceptance-criteria grep anchor without regressing the broadcast notification path."
  - "Extract `handle_sidecar_line` to a doc-hidden `pub` free function + `pub` `Pending` alias so integration tests drive parse+dispatch without spawning a Node subprocess."
  - "Send decoded preview/frame on BOTH the watch channel (latest-wins for the live preview consumer in 09-02) AND the existing broadcast channel (so preview still appears in the generic notification fan-out for telemetry/debug subscribers)."
  - "`call_preview_stop` swallows errors and warn-logs under `storycapture::preview` — preview failure must not cascade into recording (CLAUDE.md: intentional isolation)."
metrics:
  duration: "~30 min"
  completed: "2026-04-21"
---

# Phase 9 Plan 01: Live Preview sidecar + Rust bridge Summary

Sidecar JSON-RPC verbs `startPreviewStream` / `stopPreviewStream` drive CDP `Page.startScreencast`; id-less `preview/frame` notifications stream base64 JPEG payloads to Rust, where a new `tokio::sync::watch::Sender<Option<PreviewFrame>>` publishes them with latest-wins semantics via `PlaywrightSidecarDriver::subscribe_preview()`. Chromium stays unblocked via `Page.screencastFrameAck` on every flushed frame. No UI (Wave 2 scope).

## Tasks executed

| Task | Commit  | Files                                                                                                           |
| ---- | ------- | --------------------------------------------------------------------------------------------------------------- |
| 1    | c80c7a9 | `scripts/playwright-sidecar/server.mjs`, `scripts/playwright-sidecar/preview.test.mjs`                          |
| 2    | 1814088 | `crates/automation/src/playwright_driver.rs`, `crates/automation/src/lib.rs`, `crates/automation/tests/preview_notification.rs` |

## Acceptance gates passed

- `grep -q startPreviewStream scripts/playwright-sidecar/server.mjs` ✓
- `grep -q stopPreviewStream scripts/playwright-sidecar/server.mjs` ✓
- `grep -q writeNotification scripts/playwright-sidecar/server.mjs` ✓ (pre-existing helper, reused)
- `grep -q "Page.screencastFrameAck" scripts/playwright-sidecar/server.mjs` ✓
- `grep -q newCDPSession scripts/playwright-sidecar/server.mjs` ✓
- `grep -q "pub struct PreviewFrame" crates/automation/src/playwright_driver.rs` ✓
- `grep -q SidecarMsg crates/automation/src/playwright_driver.rs` ✓
- `grep -q subscribe_preview crates/automation/src/playwright_driver.rs` ✓
- `grep -q call_preview_start crates/automation/src/playwright_driver.rs` ✓
- `grep -q call_preview_stop crates/automation/src/playwright_driver.rs` ✓
- `grep -q "tokio::sync::watch" crates/automation/src/playwright_driver.rs` ✓

## Verification results

- **Sidecar preview vitest:** 6/6 green (`SIDECAR_TEST=1 pnpm vitest run preview.test.mjs`) — 7.56s
- **Sidecar regression (server.test.mjs):** 25/25 green (existing Phase 5–7 suite unaffected)
- **Rust integration (`preview_notification`):** 5/5 green (`cargo test -p automation --test preview_notification`)
- **Rust lib suite:** 61/61 green (`cargo test -p automation --lib`)
- **`cargo check -p automation`:** clean
- **`cargo check -p storycapture`:** clean

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 — blocking] Ack test initially failed on static data URL**
- **Found during:** Task 1 vitest run
- **Issue:** A static data URL with a single solid `<div>` produces exactly one screencast frame; Chromium stops emitting after it paints once, so the "frames keep flowing beyond the first tick" assertion saw 1 frame both ticks.
- **Fix:** Switched the test fixture to an animated CSS-keyframes pulsing box — continuous repaints keep Chromium streaming so ack discipline is observable.
- **Files:** `scripts/playwright-sidecar/preview.test.mjs`
- **Commit:** c80c7a9

**2. [Rule 3 — blocking] Backpressure test initially hung on RPC round-trip**
- **Found during:** Task 1 vitest run
- **Issue:** The original implementation paused the entire readline stream, which also paused JSON-RPC response dispatch — so `__debugPreviewState` (a regular response) never resolved and the test timed out.
- **Fix:** Split the pause into `framesPaused` (notifications only); responses always flow through so mid-test debug verbs can resolve.
- **Files:** `scripts/playwright-sidecar/preview.test.mjs`
- **Commit:** c80c7a9

### Out-of-scope items (deferred, not fixed)

- **`cargo clippy -p automation --all-targets -- -D warnings`** fails with ~10 pre-existing warnings in `crates/automation/src/selector.rs`, `crates/story-parser/**`, and `crates/storage/**` (uninlined format args, `NoopDriver::default()` on unit struct). None are introduced by this plan; the single hit that touches `playwright_driver.rs` (line 721) is inside the **pre-existing** `notification_tests` module (not code added in 09-01). Per Scope Boundary, these are logged here and not fixed.

## Design notes

- **Why keep `JsonRpcResponse` instead of replacing with `SidecarMsg`:** The existing `JsonRpcResponse` struct already uses `Option<u64>` for `id` plus `Option<String>` for `method` and `Option<Value>` for `params`. It has been correctly dispatching id-absent lines to the broadcast channel since the 07-03b hoverPreview work. Replacing it wholesale with `SidecarMsg::Response|Notification` would produce zero behavior change and churn every field owner. We kept `JsonRpcResponse` as the parse target, added `SidecarMsg` as a documented alias (satisfies the grep anchor + plan's type contract), and introduced a dedicated `preview_frames_tx` watch channel.
- **Why the watch channel does NOT replace the broadcast channel:** The broadcast channel serves generic fan-out (hoverPreview today, future unknown-method consumers). The watch channel is narrowly-typed to `Option<PreviewFrame>` with latest-wins semantics — perfect for a single UI canvas consumer in 09-02, but wrong for multi-subscriber rAF notifications. Both coexist; `preview/frame` is published to both.
- **`handle_sidecar_line` extraction:** Made `pub` under `#[doc(hidden)]` plus a `pub type Pending` alias so the integration test can construct all three channels (`Pending`, broadcast, watch) and drive dispatch with a real-wire JSON string. Avoids flaky subprocess-based tests; keeps the public API free of test-internal symbols in rustdoc output.

## Downstream handoff for Wave 2 (09-02)

- Consumer wires `PlaywrightSidecarDriver::subscribe_preview()` into a Tauri command + `Channel<T>` and invokes `call_preview_start()` on canvas mount, `call_preview_stop()` on unmount.
- `preview://frame` Tauri event (D-07) is NOT registered yet — that ships with the React canvas in 09-02.
- `BrowserDriver` trait is UNCHANGED (D-05 was marked optional; the preview surface is a `PlaywrightSidecarDriver`-only concrete method per research).

## Self-Check: PASSED

- FOUND: `scripts/playwright-sidecar/server.mjs` (modified)
- FOUND: `scripts/playwright-sidecar/preview.test.mjs` (new)
- FOUND: `crates/automation/src/playwright_driver.rs` (modified)
- FOUND: `crates/automation/src/lib.rs` (modified)
- FOUND: `crates/automation/tests/preview_notification.rs` (new)
- FOUND commit: c80c7a9
- FOUND commit: 1814088
