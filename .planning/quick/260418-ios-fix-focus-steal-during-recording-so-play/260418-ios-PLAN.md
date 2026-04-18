---
id: 260418-ios
title: "Fix focus-steal during recording: re-focus Tauri main window after Playwright/browser launch"
created: 2026-04-18
status: planned
mode: quick
scope: lean
files_modified:
  - apps/desktop/src-tauri/src/commands/automation.rs
  - apps/desktop/src-tauri/src/commands/encode.rs
  - crates/capture/src/macos/sck_backend.rs
  - crates/capture/src/windows/wgc_backend.rs
must_haves:
  truths:
    - "After launch_automation spawns the Playwright-managed Chromium, the StoryCapture Tauri main window regains focus within ~1s."
    - "After start_recording completes, StoryCapture is once again the foreground window."
    - "The running recording continues to capture frames regardless of whether StoryCapture or Chromium is foreground (window-targeted SCK/WGC is focus-independent)."
    - "No page.bringToFront() / activate / foreground-hoist call is introduced in the sidecar or in Rust."
  artifacts:
    - path: "apps/desktop/src-tauri/src/commands/automation.rs"
      provides: "Re-focus of main Tauri window after Playwright pid probe resolves (or after sidecar spawn)."
    - path: "apps/desktop/src-tauri/src/commands/encode.rs"
      provides: "Re-focus of main Tauri window after start_recording returns the session id."
    - path: "crates/capture/src/macos/sck_backend.rs"
      provides: "One-shot tracing::info! at SCStream start documenting focus-independent window capture + target id."
    - path: "crates/capture/src/windows/wgc_backend.rs"
      provides: "One-shot tracing::info! at WGC start documenting focus-independent window capture + HWND."
  key_links:
    - from: "automation::launch_automation pid-probe task"
      to: "app.get_webview_window(\"main\").set_focus()"
      via: "app_handle clone threaded into the spawned probe future"
      pattern: "get_webview_window\\(\"main\"\\).*set_focus"
---

<objective>
Quick fix: stop the Playwright-spawned Chromium browser from stealing and retaining foreground focus during a recording session. Users must be able to alt-tab to (and click on) StoryCapture while the story runs — without interrupting capture. Window-targeted capture (SCK on macOS, WGC on Windows) is already focus-independent per research, so the fix is a small additive re-focus of our own window after the browser launches, plus a defensive audit + evidence log.

Purpose: Restore normal desktop usability during automated runs; make it easy to diagnose any future "lost focus" regression.

Output: Main Tauri window re-activates after browser spawn and after start_recording; one-time backend log per session confirming window-targeted capture is running.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
</execution_context>

<context>
@CLAUDE.md
@.planning/STATE.md
@scripts/playwright-sidecar/server.mjs
@crates/automation/src/driver.rs
@apps/desktop/src-tauri/src/commands/automation.rs
@apps/desktop/src-tauri/src/commands/encode.rs
@crates/capture/src/macos/sck_backend.rs
@crates/capture/src/windows/wgc_backend.rs

<interfaces>
<!-- Key API surfaces the executor needs. Extracted from the codebase. -->

Tauri main window is labeled "main" (apps/desktop/src-tauri/src/lib.rs:34, region_overlay.rs:40 uses the same `set_focus()` pattern):

```rust
// Tauri v2 API
use tauri::{AppHandle, Manager};
if let Some(win) = app.get_webview_window("main") {
    let _ = win.set_focus();           // returns Result<(), tauri::Error>
    let _ = win.unminimize();          // safe no-op if not minimized
}
```

`launch_automation` (apps/desktop/src-tauri/src/commands/automation.rs):
- Spawns the sidecar, builds `PlaywrightSidecarDriver`, wraps it in `Arc<Mutex<...>>`.
- Spawns a background probe task (`tokio::spawn(async move { ... })`) that polls `browser_process()` with exponential backoff for up to ~10s. When the pid resolves, `playwright_pid_stash().set(...)` is updated.
- The `AppHandle` is already in scope — `let app = app;` is cloneable via `app.clone()`.

`start_recording` (apps/desktop/src-tauri/src/commands/encode.rs:289) returns `Result<RecordingSessionId, AppError>`. We want to re-focus after successful return, before returning the id to the renderer.

Sidecar audit baseline (confirmed via grep at planning time):
- `scripts/playwright-sidecar/server.mjs`: NO `page.bringToFront`, NO `context.activate`, NO `--make-foreground` flags. Only `chromium.launchServer` + `chromium.connect` + normal `page.*` verbs.
- `crates/automation/src/`: NO activation / focus calls.
- macOS + Windows backends already call `SCContentFilter::for_window` / `Window::from_raw_hwnd` — focus-independent by OS contract.
</interfaces>
</context>

<tasks>

<task type="auto">
  <name>Task 1: Re-focus the Tauri main window after Playwright launch + after start_recording</name>
  <files>apps/desktop/src-tauri/src/commands/automation.rs, apps/desktop/src-tauri/src/commands/encode.rs</files>
  <action>
Audit first, then add the minimum re-focus calls. Do NOT add any platform-specific native code; `WebviewWindow::set_focus()` is sufficient cross-platform (already used in lib.rs:34 and region_overlay.rs:40).

Step A — Audit (record findings in the quick SUMMARY, no code change):
  1. Confirm there is no `bringToFront`, `activate`, `SetForegroundWindow`, or `NSWorkspace` call introduced by this change in either sidecar or Rust. `grep -RIn 'bringToFront\|SetForegroundWindow\|NSWorkspace\|activateIgnoringOtherApps' scripts/playwright-sidecar crates apps/desktop/src-tauri` should come back clean (only matches should be in unrelated phase-07 overlay code, if any).
  2. Confirm the Playwright launch args in `LaunchConfig::from_meta` are unchanged (no `--make-default-browser`, no `--activate-on-launch`, etc.). Only the existing `--app=<url>` path is present.

Step B — Edit `apps/desktop/src-tauri/src/commands/automation.rs`:
  1. Inside `launch_automation`, BEFORE `tokio::spawn(async move { ... })` for the pid probe, clone the `AppHandle`:
     ```rust
     let app_for_refocus = app.clone();
     ```
  2. Inside the probe task, after the `Ok(info)` arm updates `playwright_pid_stash()` and is about to `break` / continue, trigger a one-shot re-focus exactly once per probe (guard with a local `let mut refocused = false;` captured outside the loop). On the first successful stash update (pid resolved OR `reason == "remote-browser"`), schedule the re-focus on the main thread via `tauri::async_runtime::spawn` (Tauri windows are Send but `set_focus` must run from a handle-bearing context — use the existing async context, which is fine):
     ```rust
     if !refocused {
         refocused = true;
         if let Some(win) = app_for_refocus.get_webview_window("main") {
             let _ = win.unminimize();
             match win.set_focus() {
                 Ok(()) => tracing::info!(
                     target: "storycapture::automation",
                     "main window re-focused after Playwright launch"
                 ),
                 Err(e) => tracing::warn!(
                     target: "storycapture::automation",
                     error = %e,
                     "main window set_focus failed after Playwright launch"
                 ),
             }
         }
     }
     ```
     (Place the `refocused` binding in the same `async move` block so it persists across loop iterations.)
  3. Do NOT add a re-focus on the error branch — if the probe never resolves, Chromium almost certainly failed to launch and stealing focus back on a timeout would mask real failures.

Step C — Edit `apps/desktop/src-tauri/src/commands/encode.rs`:
  1. In `start_recording`, after the session is successfully created and JUST BEFORE the final `Ok(session_id)` return (where `session_id` is the `RecordingSessionId`), insert one re-focus call. Thread `app: AppHandle` is already a parameter of the command, so:
     ```rust
     if let Some(win) = app.get_webview_window("main") {
         let _ = win.unminimize();
         match win.set_focus() {
             Ok(()) => tracing::info!(
                 target: "storycapture::recording",
                 session_id = %session_id.0,
                 "main window re-focused after start_recording"
             ),
             Err(e) => tracing::warn!(
                 target: "storycapture::recording",
                 error = %e,
                 "main window set_focus failed after start_recording"
             ),
         }
     }
     ```
  2. Do NOT add the re-focus inside any error path — when recording fails the renderer shows a dialog; forcing focus there competes with modal UX.

Rationale for placement (from research): Chromium becomes frontmost as a side-effect of GUI-process spawn. Re-focusing *after* the pid probe ensures the child window has actually materialized (otherwise our `set_focus` races and Chromium wins). Re-focusing again after `start_recording` covers the gap where the user clicked elsewhere during the probe delay.

Per CLAUDE.md: no Co-Authored-By trailer in any commit; no workarounds — this fixes the root cause (we were never re-asserting our own window after spawning a peer GUI app).
  </action>
  <verify>
    <automated>cargo check -p storycapture-desktop --target-dir target 2>&1 | tail -40 &amp;&amp; cargo check -p storycapture-desktop --target x86_64-pc-windows-msvc 2>&1 | tail -20 ; cargo test -p automation --lib 2>&1 | tail -10</automated>

    Manual smoke (operator, macOS): `pnpm --filter @storycapture/desktop tauri dev`, open a story with chromiumoxide disabled so Playwright is used, click "Run with Recording". Expected: Chromium window opens, StoryCapture regains foreground within ~1s, alt-tab between the two works freely, recording continues to produce frames the whole time. Stop recording — StoryCapture remains foreground.
  </verify>
  <done>
    - `cargo check` passes on macOS host target AND `x86_64-pc-windows-msvc` cross-target.
    - `cargo test -p automation --lib` still green (no regressions to LaunchConfig tests).
    - Grep audit output captured in SUMMARY: zero hits for `bringToFront|SetForegroundWindow|NSWorkspace|activateIgnoringOtherApps` in the diff.
    - Two new `tracing::info!` events visible in app log on a real run: "main window re-focused after Playwright launch" + "main window re-focused after start_recording".
    - `shouldAutoFollow` path in `recording-view.tsx` untouched and still resolves Playwright PID before capture starts.
  </done>
</task>

<task type="auto">
  <name>Task 2: One-shot backend log — "window-target capture is focus-independent"</name>
  <files>crates/capture/src/macos/sck_backend.rs, crates/capture/src/windows/wgc_backend.rs</files>
  <action>
Purely defensive evidence — no behavior change. Add one `tracing::info!` at the point the OS stream is actually started, recording that the capture target is a window (not a display) so future regressions around "does focus matter?" can be answered from the log alone.

Edit `crates/capture/src/macos/sck_backend.rs`:
  1. Immediately after the existing `stream.start_capture()?` call in `SckBackend::start` (around line 277-279), before the `state.lock()` block, add:
     ```rust
     if matches!(cfg.target, CaptureTarget::Window { .. } | CaptureTarget::WindowByPid { .. }) {
         tracing::info!(
             target: "storycapture::capture",
             target_kind = %cfg.target.kind_label(),
             width_px,
             height_px,
             "SckBackend: window-target stream started — capture is focus-independent (SCContentFilter bound to window id)"
         );
     }
     ```
  2. Import `CaptureTarget` if not already in scope at that site (check the top of the file; it is used elsewhere for `build_filter`, so the import should already exist — if not, add `use crate::target::CaptureTarget;` or the existing crate-relative path).

Edit `crates/capture/src/windows/wgc_backend.rs`:
  1. Inside `WgcBackend::start`, inside the `CaptureTarget::Window { window_id }` arm (around line 293), AFTER `WgcHandler::start_free_threaded(settings).map_err(map_start_err)?` resolves to `control`, add:
     ```rust
     tracing::info!(
         target: "storycapture::capture",
         hwnd = window_id.0,
         "WgcBackend: window-target stream started — capture is focus-independent (GraphicsCaptureItem::FromWindow)"
     );
     ```
  2. Also add the equivalent log in the `CaptureTarget::WindowByPid { .. }` arm (if present nearby — check the match; if WindowByPid resolves through a helper that eventually picks a Window, add the log after the helper returns the HWND).

Do NOT:
  - Add any "focus" toggle / setting / arg. WGC + SCK already do the right thing.
  - Add these logs to the Display / DisplayRegion arms — those are focus-independent trivially and the log would only add noise.
  - Change log levels elsewhere.

Rationale: this is the "future-proof breadcrumb" the research summary called for. When someone later reports "recording stopped when I alt-tabbed", the first check is this log — its absence means the path dropped to xcap fallback or a display-target; its presence proves the OS stream is bound to a window and any black-frame issue is elsewhere (e.g. minimize/occlusion per OS policy).
  </action>
  <verify>
    <automated>cargo check -p capture 2>&1 | tail -20 &amp;&amp; cargo check -p capture --target x86_64-pc-windows-msvc 2>&1 | tail -20 &amp;&amp; cargo test -p capture --lib 2>&1 | tail -10</automated>
  </verify>
  <done>
    - `cargo check -p capture` green on macOS host target.
    - `cargo check -p capture --target x86_64-pc-windows-msvc` green.
    - `cargo test -p capture --lib` green (pure additive log; should not affect any test).
    - Grep confirms the new messages are present: `grep -RIn 'focus-independent' crates/capture/src` returns at least 2 hits (one per backend).
  </done>
</task>

</tasks>

<verification>
Whole-plan smoke (operator, optional but recommended):
1. Launch desktop dev build.
2. Start a recording with a Playwright-launched Chromium.
3. Verify (in-log): both new `main window re-focused ...` lines appear.
4. Verify (in-log): `SckBackend: window-target stream started — capture is focus-independent` (macOS) OR `WgcBackend: window-target stream started — capture is focus-independent` (Windows) appears exactly once per session.
5. During recording: alt-tab between StoryCapture and Chromium freely. Click StoryCapture UI elements. Confirm the running recording's FramesDropped telemetry does NOT spike because of the focus change.
6. Stop recording. StoryCapture remains the foreground window.

No-regression checks:
- `crates/automation` tests: `cargo test -p automation --lib` green.
- `crates/capture` tests: `cargo test -p capture --lib` green.
- `scripts/playwright-sidecar/server.test.mjs`: `pnpm --filter @storycapture/playwright-sidecar test` green (no sidecar changes expected).
- `shouldAutoFollow` path still resolves Playwright PID before `start_capture_target` runs (no code touched in recording-view.tsx).
</verification>

<success_criteria>
- Focus steal eliminated for the common path (Playwright + auto-follow recording).
- Zero added platform-specific unsafe; only `WebviewWindow::set_focus()` used.
- Additive-only change set: no existing call sites modified behaviorally.
- No `Co-Authored-By:` trailer in any commit (per CLAUDE.md).
- Grep audit shows no new activation/bringToFront calls.
- Quick task SUMMARY written at `.planning/quick/260418-ios-fix-focus-steal-during-recording-so-play/260418-ios-SUMMARY.md` capturing: audit evidence (grep output), diff summary, operator smoke result (if run), and any follow-ups (e.g. windowed-alt-tab edge cases).
</success_criteria>

<output>
After completion, create:
`.planning/quick/260418-ios-fix-focus-steal-during-recording-so-play/260418-ios-SUMMARY.md`
</output>
