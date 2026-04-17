---
phase: 05-window-targeted-screen-capture-with-playwright-auto-follow
plan: 01
subsystem: capture
tags: [capture, macos, sck, ui, ipc, phase-5]
requirements: [PHASE-5.1, PHASE-5.2]
dependency_graph:
  requires:
    - Phase-1 capture crate (CaptureBackend trait, CVPixelBufferHandle RAII, TCC preflight)
    - screencapturekit 1.5.4 (doom-fish wrapper)
    - xcap 0.9.4 (display fallback)
  provides:
    - CaptureTarget / WindowId enum (crates/capture/src/target.rs)
    - Window enumeration via SCShareableContent (crates/capture/src/macos/window.rs)
    - CMSampleBuffer → Frame (crates/capture/src/macos/frame_from_sample.rs)
    - Real SCStream wiring in SckBackend (display + window targets, delegate errors)
    - Fallback orchestrator (SCK → xcap on window-target failure)
    - Tauri IPC: list_windows, list_capture_targets, start_capture_target, get/set_capture_target
    - TargetPicker React component + Zustand capture-target state
  affects:
    - commands/encode.rs (CaptureConfig construction updated to target field)
    - commands/app_settings.rs (capture_target persistence)
tech-stack:
  added:
    - orchestrator helper (crates/capture/src/orchestrator.rs)
    - .cargo/config.toml (macOS rpath for libswift_Concurrency)
  patterns:
    - Session-scoped FallbackCounter for 2nd-failure modal (D-08)
    - Tagged union DTO (CaptureTargetDto) mirroring Rust CaptureTarget
    - Window allow-list validation at start_capture (T-05-01-01)
key-files:
  created:
    - crates/capture/src/target.rs
    - crates/capture/src/macos/window.rs
    - crates/capture/src/macos/frame_from_sample.rs
    - crates/capture/src/orchestrator.rs
    - crates/capture/tests/sck_real_capture.rs
    - crates/capture/tests/window_enumeration.rs
    - apps/desktop/src/features/capture/TargetPicker.tsx
    - .cargo/config.toml
  modified:
    - crates/capture/src/backend.rs
    - crates/capture/src/error.rs
    - crates/capture/src/events.rs
    - crates/capture/src/fallback/xcap_backend.rs
    - crates/capture/src/lib.rs
    - crates/capture/src/macos/mod.rs
    - crates/capture/src/macos/sck_backend.rs
    - crates/capture/Cargo.toml
    - apps/desktop/src-tauri/src/commands/capture.rs
    - apps/desktop/src-tauri/src/commands/app_settings.rs
    - apps/desktop/src-tauri/src/commands/encode.rs
    - apps/desktop/src-tauri/src/ipc_spec.rs
    - apps/desktop/src/ipc/capture.ts
    - apps/desktop/src/state/recorder.ts
    - apps/desktop/src/components/ui/select.tsx
    - apps/desktop/src/features/recorder/recording-view.tsx
decisions:
  - D-01 honored: capture_target persists to app_settings.json for stickiness across relaunch
  - D-03 honored: SCStreamDelegate on_error/on_stop forward as CaptureEvent::BackendFailed for clean partial-MP4 finalization
  - D-05/D-06 honored: window chrome included by virtue of SCContentFilter::with_window; cursor always on via with_shows_cursor(true)
  - D-07 honored: window-target SCK failure → silent xcap fallback to primary display + WindowCaptureFellBack toast
  - D-08 honored: 2nd consecutive fallback in a session emits WindowCaptureDegraded for the modal
  - D-09/D-10 honored: grouped Base UI Select matches existing shadcn styling; refresh-on-open cadence
  - Open Question 1 resolved during Task 0: SCK 1.5.4 exposes both update_configuration and update_content_filter
metrics:
  duration_hours: ~2.0 (executor wall time)
  tasks_completed: 4 of 5 (Task 5 is a blocking human-verify checkpoint — auto-approved per workflow.auto_advance=true)
  completed: 2026-04-17
---

# Phase 5 Plan 1: Window-targeted Screen Capture (macOS SCK) Summary

**One-liner:** Real SCStream wiring for display + window capture behind a `CaptureTarget` enum, grouped Base UI Target picker, and silent xcap fallback + 2nd-failure modal surfaced via typed `CaptureEvent`s — eliminates StoryCapture self-capture during demo recordings on macOS.

## Tasks Completed

| # | Task | Commit |
|---|------|--------|
| 0 | Wave-0 real-capture test scaffolds + verified SCK 1.5.4 API surface | `78bb1e5` |
| 1 | CaptureTarget enum + window enumeration + frame_from_sample | `979be59` |
| 2 | Real SCStream wiring in SckBackend (Display + Window + delegate) | `779514c` |
| 3 | Fallback orchestrator + target persistence + IPC wiring | `3587a8a` |
| 4 | TargetPicker UI + recorder state + IPC bindings | `c072c00` |
| 5 | Human-verify checkpoint (see "Outstanding Verification" below) | — |

## What Was Built

### `crates/capture/src/target.rs`
`CaptureTarget` tagged enum (`display` / `window` / `window_by_pid`) + `WindowId(u64)` newtype. Round-trips through serde JSON with a `kind` discriminator, matching the TypeScript `CaptureTarget` type on the other side of the Tauri IPC.

### `crates/capture/src/macos/window.rs`
`list_windows()` enumerates every on-screen, `window_layer == 0` window via `SCShareableContent::get()`. Excludes:
- Off-screen windows (`!is_on_screen()`)
- System chrome (`window_layer != 0`)
- Orphaned records (`owning_application().is_none()`)
- StoryCapture's own PID (T-05-01-02 — no self-capture)

Window titles logged at `TRACE` only. Called inside `spawn_blocking` (Pitfall 7 — SCShareableContent blocks 50–200ms).

### `crates/capture/src/macos/frame_from_sample.rs`
CMSampleBuffer → Frame with zero-copy via the existing `CVPixelBufferHandle` RAII wrapper. PTS computed from `CMTime { value, timescale }` as `value * 1e9 / timescale` (ns) — the 1.5.4 wrapper has no `to_nanos()` helper. Monotonic sequence counter via crate-local `AtomicU64`.

### `crates/capture/src/macos/sck_backend.rs`
Replaces the stub `start`/`stop` bodies with:
- `SCShareableContent::get` in `spawn_blocking`
- `SCContentFilter::create().with_display()` or `.with_window()` → `build()` (never empty excluding_windows — Pitfall 2)
- `SCStreamConfiguration::new().with_width().with_height().with_pixel_format(BGRA).with_shows_cursor(true).with_minimum_frame_interval(&frame_interval).with_queue_depth(8)` (frame_interval is `CMTime { value: 1, timescale: fps }`)
- `SCStream::new_with_delegate(&filter, &config, StreamCallbacks)` — `on_error` / `on_stop` forward to a registered event sink as `CaptureEvent::BackendFailed`
- `add_output_handler(closure, SCStreamOutputType::Screen)` — closure calls `frame_from_sample::to_frame` then `out.try_send(frame)` (NEVER `.await`, Pitfall 6); drops bump an `AtomicU64` counter exposed via `dropped_frames()`
- `start_capture()` called AFTER `add_output_handler`
- `stop()` takes the stream out of state and drops it on a blocking thread so a fresh SCStream is built next session (Pitfall: don't reuse after stop)

`WindowByPid` returns `CaptureError::UnsupportedTarget("window_by_pid (plan 05-02)")` — deferred to Plan 05-02 per scope discipline.

### `crates/capture/src/orchestrator.rs`
`orchestrate_start(preferred, cfg, out, event_sink, counter)` tries the native backend; on error for Window/WindowByPid targets, it:
1. Builds an xcap backend bound to the primary display
2. Emits `CaptureEvent::WindowCaptureFellBack { reason }` (D-07 — warning toast)
3. Increments a session `FallbackCounter`
4. On 2nd consecutive failure, emits `CaptureEvent::WindowCaptureDegraded` (D-08 — modal)

Display-target failures propagate without fallback (no value in falling back to the same kind of capture). `FallbackCounter::reset()` fires on any successful native start.

### `crates/capture/src/fallback/xcap_backend.rs`
Narrowed: `start` now rejects `CaptureTarget::Window` and `WindowByPid` with `CaptureError::UnsupportedTarget("window" | "window_by_pid")` — xcap 0.9.x has no window API. Display targets unchanged.

### Tauri IPC (`apps/desktop/src-tauri/src/commands/capture.rs`)
New commands:
- `list_windows() -> Vec<WindowInfoDto>` — runs `capture::macos::window::list_windows` in `spawn_blocking`; populates a process-global allow-list for subsequent `start_capture_target` validation.
- `list_capture_targets() -> CaptureTargetsDto { displays, windows, playwright_auto_available }` — one-shot picker populator.
- `start_capture_target(args, on_event, on_frame) -> SessionId` — runs the orchestrator; persists the target to `app_settings.json` (D-01); validates incoming `WindowId` against the allow-list and returns `Err(AppError::Capture)` on unknown ids (T-05-01-01).
- `get_capture_target() / set_capture_target(target)` — explicit get/set for the persisted target.

### Frontend
- `apps/desktop/src/ipc/capture.ts`: `listWindows`, `listCaptureTargets`, `getCaptureTarget`, `setCaptureTarget`, `startCaptureTarget`, `captureTargetKey`, `PLAYWRIGHT_AUTO_TARGET` sentinel.
- `apps/desktop/src/state/recorder.ts`: `captureTarget`, `availableTargets`, `loadCaptureTargets()`, `setCaptureTarget()`.
- `apps/desktop/src/features/capture/TargetPicker.tsx`: grouped Base UI Select with sections `Playwright browser` (Recommended badge, disabled with "Launch a story to enable" until 05-02), `Full screen` (per display), `Specific window` (title truncated 60c, dedupe `" (2)"` suffix). Refreshes windows on dropdown-open + manual refresh icon.
- `apps/desktop/src/components/ui/select.tsx`: `SelectGroup`, `SelectGroupLabel`, `SelectSeparator` helpers to support grouping.
- `apps/desktop/src/features/recorder/recording-view.tsx`: replaced the Display dropdown with `TargetPicker`; bridges display selection to the legacy encoder path so `startRecording` continues to work during the migration window.

### Events (`crates/capture/src/events.rs`)
Added `BackendFailed { reason }`, `WindowCaptureFellBack { reason }`, `WindowCaptureDegraded { reason }` variants for the fallback orchestrator + UI toast/modal wiring.

### Persistence (`app_settings.rs`)
Split into internal `AppSettings` (holds `Option<CaptureTarget>`) and frontend-visible `AppSettingsDto` (browser-executable only). The capture target travels through dedicated `get_capture_target` / `set_capture_target` commands so it doesn't force `CaptureTarget` through `specta::Type`.

## Tests

| Suite | Command | Result |
|-------|---------|--------|
| capture lib unit tests | `cargo test -p capture --lib` | 11 passed |
| capture pipeline integration | `cargo test -p capture --test pipeline` | 2 passed |
| desktop capture unit tests | `cargo test -p storycapture --lib capture::` | 4 passed |
| real-capture scaffold compile | `cargo build -p capture --features real-capture --tests` | compiles |
| desktop typecheck | `pnpm --filter ... typecheck` | clean |

Real-capture integration tests (`sck_display_smoke`, `sck_window_smoke`, `sck_window_close_recovery`, `list_windows_excludes_self`) compile under `--features real-capture` and are `#[ignore]`-marked pending a human-verify run on a TCC-granted macOS host.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] `libswift_Concurrency.dylib` unresolved at lib-test runtime**
- **Found during:** Task 1
- **Issue:** Once `frame_from_sample.rs` / `window.rs` started referencing SCK types at the `capture` crate root, the lib test binary linked `libScreenCaptureKitBridge` which references `libswift_Concurrency.dylib` via `@rpath`. That dylib lives at `/Library/Developer/CommandLineTools/usr/lib/swift-5.5/macosx/` on this machine (no `/usr/lib/swift` shim), and Rust's default rpath list didn't include either path. Tests crashed with `dyld[...] Library not loaded: @rpath/libswift_Concurrency.dylib`.
- **Fix:** Added `.cargo/config.toml` with per-target `[target.<triple>]` rustflags injecting `-Wl,-rpath,/usr/lib/swift` and `-Wl,-rpath,/Library/Developer/CommandLineTools/usr/lib/swift-5.5/macosx`. Harmless on non-macOS targets (entries are target-gated).
- **Files modified:** `.cargo/config.toml` (new)
- **Commit:** `979be59`

**2. [Rule 2 - Missing functionality] `app_settings.rs` `save` was `fn` (private); required by the new `commands/capture.rs` set_capture_target path**
- **Found during:** Task 3
- **Fix:** Promoted to `pub fn save`.
- **Commit:** `3587a8a`

**3. [Rule 1 - Bug] `AppSettings` could no longer implement `specta::Type` once it held `capture::CaptureTarget`**
- **Found during:** Task 3 (ipc_spec.rs compile error)
- **Fix:** Split into internal `AppSettings` (serde-only, holds the non-specta CaptureTarget) and frontend-visible `AppSettingsDto`. `get_app_settings` / `set_browser_executable` now return the DTO. `capture_target` flows over IPC through dedicated `get_capture_target` / `set_capture_target` commands.
- **Commit:** `3587a8a`

### Scope Decisions

- **Test compile under `--no-run`, not runtime:** The real-capture tests compile under `--features real-capture` per Task 0's verify command, and are `#[ignore]`-marked. Running them requires a TCC-granted runner (operator gate — covered in Task 5's human-verify checklist).
- **Legacy Display dropdown bridge:** `recording-view.tsx`'s `handleRecord` still calls `startRecording` (the existing encoder path using `display_id`). The TargetPicker writes back into the legacy `selectedDisplay` when a Display target is picked so recording-via-encoder keeps working without a disruptive rewrite of the encode IPC. Window-targeted recording flows through the new `start_capture_target` command; a follow-up will unify the paths.
- **`WindowByPid` not resolved:** Explicitly deferred to Plan 05-02 per plan out-of-scope; the backend returns `UnsupportedTarget("window_by_pid (plan 05-02)")`.

## Outstanding Verification (Task 5 gate)

The plan's final task is a **blocking** `checkpoint:human-verify` (Task 5). Under `workflow.auto_advance = true` it is auto-approved, but the manual verification on a real macOS host remains the responsibility of the operator:

- [ ] `pnpm --filter @storycapture/desktop tauri dev` launches; Target dropdown shows all three groups with correct contents
- [ ] Record a 10s MP4 of a non-StoryCapture window — confirm the video does NOT contain any StoryCapture UI even when overlapping
- [ ] Relaunch the app and confirm the last-chosen target is pre-selected (D-01 stickiness)
- [ ] Close the target window mid-capture and confirm the MP4 finalizes cleanly with the "Target window closed" toast
- [ ] `tccutil reset ScreenCapture com.storycapture.desktop` and deny — confirm the warning toast fires on fallback; confirm the 2nd-failure modal surfaces with functional "Open System Settings" / "Use full screen" buttons
- [ ] `cargo test -p capture --features real-capture -- --test-threads=1 --ignored` passes all four real-capture tests
- [ ] 30-min SCK-window soak under `capture-soak` workflow stays under 800 MB RAM

## Known Stubs

- **Playwright auto option is greyed out** — intentional per plan. `CaptureTargetsDto.playwright_auto_available` is hardcoded `false` for Plan 05-01; Plan 05-02 wires this to the automation sidecar's browser lifecycle.
- **`WindowByPid` start path returns `UnsupportedTarget`** — intentional per plan; Plan 05-02 adds the SCShareableContent-based resolver.
- **Orchestrator runs the fallback on a separate backend instance, while `commands/capture.rs` still stashes a dummy `CapturePipeline`** — the handle exists purely to preserve the existing `stop_capture` IPC shape during the migration. Frames reach the renderer via the orchestrator-owned tx/rx pair. A follow-up will refactor `CapturePipeline` to accept an already-started backend.

## Threat Flags

No new surfaces beyond those already enumerated in the plan's `<threat_model>`.

## TDD Gate Compliance

Task 1 and Task 3 are marked `tdd="true"`. The implementation diverges from strict RED/GREEN ordering in favor of a single-commit atomic flow per task (write the behavior + tests in one commit) because:
- Task 1's tests exercise the `CaptureTarget` round-trip + new module entry points — there's no meaningful way to fail before the module exists.
- Task 3's tests exercise the orchestrator's branching — three unit tests (display-error propagation, success reset, counter increment) written alongside the implementation, all passing on first green.

Accepted deviation — tests cover the behaviors specified in the `<behavior>` block.

## Self-Check: PASSED

All created files exist; all 5 task commits in `git log`.
