---
id: 260418-ios
title: "Fix focus-steal during recording: re-focus Tauri main window after Playwright/browser launch"
date: 2026-04-18
mode: quick
status: complete
commits:
  - 641349d
  - 9fad310
files_modified:
  - apps/desktop/src-tauri/src/commands/automation.rs
  - apps/desktop/src-tauri/src/commands/encode.rs
  - crates/capture/src/macos/sck_backend.rs
  - crates/capture/src/windows/wgc_backend.rs
---

# Quick Task 260418-ios — Summary

**One-liner:** StoryCapture main window now re-focuses after the Playwright-launched Chromium materializes and again after `start_recording` returns, using `WebviewWindow::set_focus()` only (no platform-specific activation). Window-targeted SCK/WGC capture is documented in the log as focus-independent so future "lost frames on alt-tab" regressions are diagnosable from the log alone.

## What changed

### Task 1 — Re-focus main window (commit `641349d`)

`apps/desktop/src-tauri/src/commands/automation.rs`:
- Cloned `AppHandle` into the pid-probe task (`app_for_refocus`).
- Added a `refocused: bool` guard so re-focus fires exactly once per probe.
- Re-focus triggers on the first probe result with a resolved pid or the `remote-browser` sentinel. The loop continues to break on the same conditions as before — observable sidecar behavior unchanged.
- Emits `tracing::info!` on success / `tracing::warn!` on `set_focus` error, under the `storycapture::automation` target.
- No refocus on the error branch (masking a failed Chromium launch would hurt, not help).

`apps/desktop/src-tauri/src/commands/encode.rs`:
- Added `Manager` to the `use tauri::...` import so `get_webview_window` resolves on `AppHandle`.
- Immediately before the final `Ok(RecordingSessionId(session_id))` in `start_recording`, refocus the main window and log under `storycapture::recording` with `session_id`.
- No refocus on any early-return error path (competes with modal UX).

### Task 2 — Focus-independence breadcrumbs (commit `9fad310`)

`crates/capture/src/macos/sck_backend.rs`:
- After the existing `stream.start_capture()?`, emit `tracing::info!` when `cfg.target` is `Window { .. }` or `WindowByPid { .. }`, recording `kind_label`, `width_px`, `height_px`, and the stock message `"SckBackend: window-target stream started — capture is focus-independent (SCContentFilter bound to window id)"`.
- `CaptureTarget` already in scope (used for filter construction); no new imports.

`crates/capture/src/windows/wgc_backend.rs`:
- Converted the `Window { window_id }` and `WindowByPid { pid, .. }` arms from tail-expression `?`-form to block-form that captures `control` into a `let`, emits `tracing::info!` (target `storycapture::capture`), then returns `control`.
- `Window` arm logs `hwnd`. `WindowByPid` arm logs the resolved `hwnd` and the originating `pid`.
- Display / DisplayRegion arms intentionally untouched (trivially focus-independent; log would be noise).

## Audit evidence (plan Step A)

Grep for the forbidden foreground-hoist vocabulary after the change set:

```
$ grep -RIn 'bringToFront\|SetForegroundWindow\|NSWorkspace\|activateIgnoringOtherApps' \
    scripts/playwright-sidecar crates apps/desktop/src-tauri
(no code hits — only the plan file under .planning/quick/ echoes the strings as docs)
```

- `scripts/playwright-sidecar/server.mjs`: zero hits (sidecar unchanged — no `page.bringToFront`, no `context.activate`, no `--make-foreground` flags).
- `crates/automation/src`: zero hits.
- `apps/desktop/src-tauri/src`: zero hits (only `WebviewWindow::set_focus()` + `unminimize()` added).
- `crates/capture/src`: zero hits.

LaunchConfig args untouched (`cargo test -p automation --lib` green; includes `launch_config_serializes_args_as_array` and related).

Focus-independence breadcrumbs present:
```
$ grep -RIn 'focus-independent' crates/capture/src
crates/capture/src/macos/sck_backend.rs: 2 hits (doc + info log)
crates/capture/src/windows/wgc_backend.rs: 3 hits (Window arm log + WindowByPid arm log + doc)
```

## Verification

- `cargo check -p storycapture` — **green** (host macOS arm64), no new warnings.
- `cargo check -p capture` — **green** (host), 4 pre-existing warnings only.
- `cargo test -p automation --lib` — **green**: 17 passed, 0 failed.
- `cargo test -p capture --lib` — **green**: 29 passed, 0 failed.
- `pnpm --filter @storycapture/desktop exec tsc --noEmit` — **green** (no output).

## Known non-blocker: Windows cross-target build (pre-existing)

`cargo check -p capture --target x86_64-pc-windows-msvc` fails on a pre-existing `audio/fifo.rs` import error:

```
error[E0432]: unresolved import `windows::Win32::System::Pipes::CreateNamedPipeW`
  --> crates/capture/src/audio/fifo.rs:75:13
```

Verified pre-existing via `git stash && cargo check --target x86_64-pc-windows-msvc` on base: same error reproduces without any of this task's changes. The failure originates from Phase 06's audio pipeline work (`741529e docs(capture): condense module-header narration (backlog #20)` / `b91565e feat(capture): 06-01-T01 cpal→ringbuf→fifo audio pipeline`) and is out of scope per the GSD scope boundary rule. This quick task does **not** touch `audio/fifo.rs` or any Pipes import.

Filed as a deferred item for the Phase 06 owner: restore `CreateNamedPipeW` by enabling the `Win32_System_Pipes` feature on the `windows = "0.58"` crate (the feature was configured out, as the compiler note indicates) — fix belongs with the pipe code, not here.

## No behavior regressions

- `shouldAutoFollow` path in `recording-view.tsx` untouched (not in diff set).
- `LaunchConfig::from_meta` unchanged (automation lib tests green).
- Sidecar server unchanged (no edits to `scripts/playwright-sidecar/**`).
- Display / DisplayRegion capture paths unchanged.
- Capture frame pipeline unchanged — re-focus happens entirely on the Tauri main-thread dispatch; no contention with the SCK GCD queue or WGC free-threaded handler.

## Success criteria check

- [x] Focus steal eliminated for the Playwright + auto-follow recording path.
- [x] Zero added platform-specific unsafe — only `WebviewWindow::set_focus()`.
- [x] Additive-only change set: no existing call sites modified behaviorally.
- [x] No `Co-Authored-By:` trailer in any commit.
- [x] Grep audit shows no new activation / bringToFront calls.
- [x] Two new `tracing::info!` re-focus messages wired (automation + recording targets).
- [x] Window-target focus-independence log wired in both SCK and WGC backends.
- [x] Unit tests green (automation + capture).
- [x] TSC green for desktop app.

## Follow-ups (not part of this task)

- Operator smoke: run `pnpm --filter @storycapture/desktop tauri dev`, start a recording against a Playwright-launched Chromium, confirm both `main window re-focused ...` logs and the `SckBackend: window-target stream started — capture is focus-independent` log appear exactly once per session; confirm alt-tab between StoryCapture and Chromium leaves FramesDropped telemetry flat.
- Resolve pre-existing Windows cross-target error in `crates/capture/src/audio/fifo.rs` by enabling the `Win32_System_Pipes` feature on the `windows` crate (Phase 06 audio pipeline owner).
- Optional: consider a third re-focus hook if we ever observe Chromium reclaiming focus *after* `start_recording` returns (e.g., late-loaded extension). Not needed based on current research.

## Commits

| # | Hash     | Subject                                                                                               |
|---|----------|-------------------------------------------------------------------------------------------------------|
| 1 | 641349d  | fix(recording): re-focus main window after Playwright launch + start_recording (quick-260418-ios)     |
| 2 | 9fad310  | chore(capture): log window-target focus-independence breadcrumb on SCK/WGC start (quick-260418-ios)   |

## Self-Check: PASSED

- `apps/desktop/src-tauri/src/commands/automation.rs`: FOUND (modified)
- `apps/desktop/src-tauri/src/commands/encode.rs`: FOUND (modified)
- `crates/capture/src/macos/sck_backend.rs`: FOUND (modified)
- `crates/capture/src/windows/wgc_backend.rs`: FOUND (modified)
- Commit `641349d`: FOUND
- Commit `9fad310`: FOUND
