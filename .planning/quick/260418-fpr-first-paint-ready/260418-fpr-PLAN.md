---
id: 260418-fpr
title: "Gate start_recording on Chrome first-paint (kills black + window-move artifacts)"
created: 2026-04-18
status: in_progress
mode: quick
scope: lean
files_modified:
  - scripts/playwright-sidecar/server.mjs
  - crates/automation/src/playwright_driver.rs
  - apps/desktop/src-tauri/src/commands/automation.rs
  - apps/desktop/src-tauri/src/commands/encode.rs
must_haves:
  truths:
    - "SCK window capture must NOT attach before Chrome has painted its first non-blank page."
    - "The old `playwright-auto` signal (pid resolved) is insufficient — pid resolves ~200 ms before Chrome paints."
    - "The new gate must have a budget so misbehaving stories never block start_recording forever."
---

## Root cause (recap)
- Capture is window-bound (SCContentFilter on the Chromium window id) → focus/z-order independent. The `set_focus` calls in the focus-steal fix are **not** the cause.
- `start_recording` currently attaches SCK as soon as the pid probe resolves (~187 ms after `Navigate` is issued). At that moment Chrome is still painting blank → adjusting its viewport → loading the target URL. Those three phases land in the first ~500 ms of every recording.

## Change
Add a second one-shot signal — **"Chrome has painted the first non-blank page"** — and gate SCK attach on that signal (not just pid).

## Implementation
1. **`scripts/playwright-sidecar/server.mjs`** — add `waitForFirstPaint({ timeoutMs })` RPC:
   - If `state.page.url() === 'about:blank'` → wait for navigation away from `about:blank`.
   - Then `await state.page.waitForLoadState('load', { timeout: timeoutMs })`.
2. **`crates/automation/src/playwright_driver.rs`** — add `wait_for_first_paint(timeout_ms)` method.
3. **`apps/desktop/src-tauri/src/commands/automation.rs`**:
   - Add `PlaywrightFirstPaintStash(AtomicBool)`.
   - Clear at launch + clear on story end.
   - After pid resolves in the probe task, spawn follow-up task that calls `wait_for_first_paint(10_000)` and flips the stash on success.
4. **`apps/desktop/src-tauri/src/commands/encode.rs`** — in `start_recording`, when the target resolves to `playwright-auto`, poll the first-paint stash with a 10 s budget BEFORE invoking `CapturePipeline::start`. If the budget expires, log a warning and proceed anyway (degraded = current behavior, not a regression).

## Rebuild
- `cd scripts/playwright-sidecar && node build-sea.mjs` (rebuild SEA binary)
- `cd apps/desktop && pnpm tauri:build`
- Install to `/Applications/StoryCapture.app`
