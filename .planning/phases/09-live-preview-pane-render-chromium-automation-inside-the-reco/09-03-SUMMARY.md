---
phase: 09
plan: 03
subsystem: recorder/live-preview + playwright-sidecar
tags: [preview, backpressure, hidpi, auto-recovery, fallback-ux, cdp, screencast]
dependency_graph:
  requires:
    - scripts/playwright-sidecar/server.mjs (09-01 startPreviewStream + flushPreviewFrame)
    - crates/automation (09-01 PreviewFrame + subscribe_preview + call_preview_*)
    - apps/desktop/src-tauri (09-02 preview pump + preview_driver slot)
    - apps/desktop/src/features/recorder/LivePreview.tsx (09-02 canvas renderer)
  provides:
    - "Sidecar state.previewDropCount + preview_drop_summary stderr event on stop"
    - "Sidecar state.previewEveryNth (HiDPI/wide-viewport → 2; otherwise 1)"
    - "Rust pump PREVIEW_PUMP_LOG_SECS-windowed warn log for emit drops"
    - "LivePreview PreviewStatus: attaching → streaming / recovering / unavailable"
    - "LivePreview: exactly-one 500ms-backoff retry on transient start failure"
    - "LivePreview: terminal unavailable card for UnavailableOnBackend"
    - "LivePreview: data-drop-count attribute + 30s saturation warn log"
  affects:
    - scripts/playwright-sidecar/server.mjs
    - scripts/playwright-sidecar/preview.test.mjs
    - apps/desktop/src-tauri/src/commands/automation.rs
    - apps/desktop/src/features/recorder/LivePreview.tsx
    - apps/desktop/src/features/recorder/LivePreview.test.tsx
tech-stack:
  added: []
  patterns:
    - "single-slot overwrite = drop (sidecar state.previewDropCount++)"
    - "probe window.devicePixelRatio + innerWidth to select everyNthFrame"
    - "env-tunable periodic drop-count log window (Rust pump)"
    - "startWithRetry(retriesLeft) with UnavailableOnBackend short-circuit"
    - "data-drop-count DOM attribute for dev/test visibility"
key-files:
  created:
    - .planning/phases/09-live-preview-pane-render-chromium-automation-inside-the-reco/09-03-SUMMARY.md
  modified:
    - scripts/playwright-sidecar/server.mjs
    - scripts/playwright-sidecar/preview.test.mjs
    - apps/desktop/src-tauri/src/commands/automation.rs
    - apps/desktop/src/features/recorder/LivePreview.tsx
    - apps/desktop/src/features/recorder/LivePreview.test.tsx
decisions:
  - "Measure viewport via page.evaluate(() => window.innerWidth + devicePixelRatio) instead of page.viewportSize() — the sidecar creates contexts with viewport:null (Plan 05-02), so viewportSize() returns null and would force everyNthFrame=1 forever on HiDPI launches."
  - "Rust pump drop counter tracks emit failures, not sidecar backpressure. watch::changed() already coalesces sends into one wake, so 'dropped frames' at the pump layer only means emit returned Err. The true sidecar-side drop count lives at state.previewDropCount, surfaced on stopPreviewStream via stderr preview_drop_summary."
  - "Test-only sidecar verbs (__debugPausePreviewFlush, __debugInjectFrame) gated by SIDECAR_TEST=1 env — the same pattern used by __debugPreviewState. Allows deterministic drop-counter coverage without a real Chromium streaming backlog."
  - "Retry budget is exactly 1 (not configurable). Per 09-RESEARCH, an unbounded retry loop is a DoS risk (T-09-03-01); a second failure indicates the backend genuinely can't stream, so surface the terminal placeholder rather than hammering the sidecar."
  - "UnavailableOnBackend is detected by the typed discriminated-union shape ({kind:'UnavailableOnBackend',...}) — matches the Rust AppError specta-generated TS taxonomy, no string-match. Preserves the existing γ-test discriminator."
  - "saturationTimerRef is a plain 30s setInterval, cleaned up in the effect teardown. Avoids an extra Zustand slice for a purely dev-telemetry counter."
metrics:
  duration: "~35 min"
  completed: "2026-04-22"
---

# Phase 9 Plan 03: Live Preview hardening (backpressure + fallback UX) Summary

Hardens the Phase 9 preview pipeline with bounded in-flight counters at every layer (sidecar, Rust pump, webview), HiDPI-aware `everyNthFrame` tuning, exactly-one retry with 500ms backoff on transient sidecar failures, and a terminal "Live preview unavailable on this backend" placeholder. No new features; perf/UX polish only. Capture/encoder crates untouched (D-22 preserved).

## Tasks executed

| Task | Commit  | Files                                                                                              |
| ---- | ------- | -------------------------------------------------------------------------------------------------- |
| 1    | 09a816b | `scripts/playwright-sidecar/server.mjs`, `preview.test.mjs`, `apps/desktop/src-tauri/src/commands/automation.rs` |
| 2    | c8236f2 | `apps/desktop/src/features/recorder/LivePreview.tsx`, `LivePreview.test.tsx`                        |
| 3    | —       | **Deferred (checkpoint:human-verify):** operator perf run on 2023 M2 MBP required — see Pending Checkpoints below. |

## Acceptance gates passed

- `grep -q previewDropCount scripts/playwright-sidecar/server.mjs` ✓
- `grep -q previewEveryNth scripts/playwright-sidecar/server.mjs` ✓ (value assigned from dpr/innerWidth probe)
- `grep -q everyNthFrame scripts/playwright-sidecar/server.mjs` ✓ (param passed from `state.previewEveryNth`)
- `grep -q drop_count apps/desktop/src-tauri/src/commands/automation.rs` ✓
- `grep -q PREVIEW_PUMP_LOG_SECS apps/desktop/src-tauri/src/commands/automation.rs` ✓
- `grep -q "PreviewStatus\|'recovering'\|'unavailable'" apps/desktop/src/features/recorder/LivePreview.tsx` ✓
- `grep -q "startWithRetry\|retriesLeft" apps/desktop/src/features/recorder/LivePreview.tsx` ✓
- `grep -q "Live preview unavailable" apps/desktop/src/features/recorder/LivePreview.tsx` ✓
- `grep -q "data-drop-count\|dropCountRef" apps/desktop/src/features/recorder/LivePreview.tsx` ✓
- `grep -rn "@ts-ignore\|: any\b" apps/desktop/src/features/recorder/LivePreview.tsx` → no results ✓

## Verification results

- **`cargo check -p automation -p storycapture`:** clean
- **`cargo test -p automation --lib`:** 61 passed, 0 failed (no regression from 09-01/02 baseline)
- **`cargo test -p storycapture --lib`:** 62 passed, 0 failed, 1 ignored
- **`pnpm --filter @storycapture/desktop exec tsc --noEmit`:** clean
- **`SIDECAR_TEST=1 pnpm vitest run preview.test.mjs`:** 9/9 green (existing 6 + 3 new: drop counter, HiDPI wide-viewport, HiDPI small-viewport)
- **`pnpm vitest run server.test.mjs`:** 25/25 regression green (Phase 5–7 suite unaffected)
- **`pnpm vitest run LivePreview`:** 8/8 green (α β γ δ preserved from 09-02 + ε ζ η θ added for 09-03)
- **`pnpm vitest run recorder`:** 59/59 green across 6 files
- **`git diff crates/capture/ crates/encoder/`:** empty ✓

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 — blocking] HiDPI wide-viewport selection used wrong measurement**
- **Found during:** Task 1 vitest run (HiDPI test expected `everyNthFrame=2` but got `1`).
- **Issue:** The sidecar creates contexts with `viewport: null` (Plan 05-02 requirement so CDP `Browser.setWindowBounds` can own the resize). With `viewport:null`, `page.viewportSize()` returns `null` — so the launch-size fallback always read as 1280x720, never triggering the `> 1600` branch even for wide launches.
- **Fix:** Probe `window.innerWidth` + `window.devicePixelRatio` via `page.evaluate()` instead of `page.viewportSize()`. Returns the actual content-area dimensions regardless of Playwright context mode.
- **Files:** `scripts/playwright-sidecar/server.mjs`
- **Commit:** 09a816b

**2. [Rule 3 — blocking] Task 2 vitest hang on `vi.useFakeTimers()`**
- **Found during:** Task 2 initial vitest run (4/4 new tests timed out at 5000ms).
- **Issue:** Combining `vi.useFakeTimers()` with `waitFor()` deadlocks because `waitFor`'s internal polling setInterval is also frozen by fake timers. The retry tests hung waiting for `waitFor` to poll while `vi.advanceTimersByTime(550)` advanced only the component's backoff timer.
- **Fix:** Dropped fake timers — just wait for real 500ms real-timer backoff with a generous `waitFor` timeout. Simpler, deterministic, no timer-scope interleaving.
- **Files:** `apps/desktop/src/features/recorder/LivePreview.test.tsx`
- **Commit:** c8236f2

### Out-of-scope items (deferred, not fixed)

- Operator perf run (Task 3 checkpoint) requires a 2023 M2 MBP with screen-recording TCC grant; cannot be fabricated per executor constraints. Deliverable `09-VERIFICATION.md` not yet created — see Pending Checkpoints below.
- Plan 06-03 status reconciliation (plan's Task 3 closing item) — not touched in this wave; the PLAN's own Task 3 gate covers it alongside the perf run.
- Pre-existing clippy warnings in `crates/automation/src/selector.rs`, `crates/story-parser/**`, `crates/storage/**` (uninlined format args, `NoopDriver::default()` on unit struct) — out of scope per Scope Boundary; already logged in 09-01 SUMMARY.

## Design notes

- **Why `__debugInjectFrame` bypasses the real Chromium path:** a naturally-generated drop requires a sustained screencast backlog, which is hard to provoke deterministically in CI (depends on `setImmediate` timing + vitest's own event loop). A synthetic-frame verb gated by `SIDECAR_TEST=1` produces a deterministic overwrite counter tick without fighting with Chromium frame rates. The same gating pattern is used by the existing `__debugPreviewState` verb.
- **Why rAF is started once (not recreated on every retry):** the rAF loop reads `pendingBitmap.current` — which is populated by the listener — so it doesn't care whether the stream is in `streaming` or `recovering` state. Keeping a single loop avoids frame double-scheduling when a recovery succeeds.
- **Why `dropTick` (React state) alongside `dropCountRef`:** `data-drop-count` is read from the DOM in test θ; React wouldn't re-render the attribute just because a ref changed. `dropTick` drives one re-render per saturation bump, and the attribute reads the ref's current value. The displayed number is still the ref (not the tick) — tick is purely a re-render trigger.

## Pending Checkpoints

**Task 3 — Operator perf run + `09-VERIFICATION.md`** (`checkpoint:human-verify`, blocking for phase sign-off):
Requires a 2023 M2 MBP (or documented equivalent) with Screen Recording + Accessibility TCC permissions granted. Operator must:

1. Build release: `pnpm --filter @storycapture/desktop tauri build`
2. Run the 10-item measurement battery from `09-03-PLAN.md` Task 3 `how-to-verify`:
   - Preview fps (≥15, target 20–25)
   - CPU overhead ≤15pp vs preview-off
   - Memory growth ≤50 MB over 5-min soak
   - End-to-end frame latency ≤200 ms
   - Final-video bitrate / framecount / encoder unchanged (D-22)
   - FramesDropped telemetry delta ≤1%
   - Offscreen Chromium continues to stream (D-20)
   - Auto-recovery smoke: `kill -9 <sidecar pid>` → enters recovering → unavailable within 1s; recording continues
   - HiDPI `everyNthFrame=2` observable in sidecar debug log at wide viewport
   - `cargo nextest run -p capture` green on same hardware (D-21)
3. Record numbers + screenshots in `.planning/phases/09-live-preview-pane-render-chromium-automation-inside-the-reco/09-VERIFICATION.md`.
4. Reconcile Plan 06-03 (static-thumbnail) status — mark obsolete in ROADMAP if not shipped; document overlap in `CLEANUP-BACKLOG.md` if partially shipped.

Any failed budget triggers a follow-up plan (commonly OffscreenCanvas + Worker decode — pre-researched in 09-RESEARCH).

## Downstream handoff for Wave 4 (09-04)

- Pump + sidecar now produce bounded drop telemetry at every layer; Wave 4 author-session multi-stream (`streamId` param, D-12) can reuse the same drop-counter pattern per stream.
- Fallback-UX state machine is in place; Wave 4's editor-surface preview can drop into the existing `<LivePreview />` since it already short-circuits on UnavailableOnBackend.
- HiDPI selection is viewport-coupled; when Wave 4 adds the viewport switcher (D-16), `startPreviewStream` naturally re-evaluates the target rate because the probe runs on every start.
- No `BrowserDriver` trait changes in this wave (D-05 optional, unchanged).

## Self-Check: PASSED

- FOUND: `scripts/playwright-sidecar/server.mjs` (modified)
- FOUND: `scripts/playwright-sidecar/preview.test.mjs` (modified)
- FOUND: `apps/desktop/src-tauri/src/commands/automation.rs` (modified)
- FOUND: `apps/desktop/src/features/recorder/LivePreview.tsx` (modified)
- FOUND: `apps/desktop/src/features/recorder/LivePreview.test.tsx` (modified)
- FOUND commit: 09a816b
- FOUND commit: c8236f2
