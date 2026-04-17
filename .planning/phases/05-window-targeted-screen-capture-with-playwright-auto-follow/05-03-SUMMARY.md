---
phase: 05-window-targeted-screen-capture-with-playwright-auto-follow
plan: 03
subsystem: capture
tags: [capture, windows, wgc, ci, phase-5]
requirements: [PHASE-5.4]
dependency_graph:
  requires:
    - Plan 05-01 CaptureBackend + CaptureTarget + orchestrator surface
    - windows-capture 2.0.0 (released 2026-04-14, 3 days old at research time)
    - xcap 0.9.4 (fallback orchestrator target)
  provides:
    - Real WgcBackend (GraphicsCaptureApiHandler, start_free_threaded,
      on_closed → BackendFailed)
    - frame_from_wgc (WGC Frame → crate::Frame via CPU BGRA copy)
    - Windows list_windows() + find_window_by_pid() with Chromium child-walk
    - Tauri list_windows / start_capture_target dispatch on Windows
    - PR-CI gate capture-windows.yml (windows-latest build + test --no-run + clippy)
  affects:
    - crates/capture/src/fallback/xcap_backend.rs (Send fix — pre-existing
      05-01 regression that would have blocked every Windows build)
    - crates/capture/src/lib.rs (pick_default_backend now prefers WgcBackend)
tech-stack:
  added:
    - windows-capture 2.0.0 features — GraphicsCaptureApiHandler, Settings
      with explicit cursor/border/secondary/interval/dirty structs
    - kernel32 FFI: ProcessIdToSessionId (cross-session filter, T-05-03-03)
    - windows 0.58 features Win32_System_Diagnostics_ToolHelp + WindowsAndMessaging
      + Threading (for Chromium child-walk + session ID)
  patterns:
    - Flags-as-struct pattern for passing (mpsc::Sender, event sink, epoch,
      counters) through Settings::new → GraphicsCaptureApiHandler::new
    - CaptureControl::stop consumed via spawn_blocking so it doesn't stall
      the async runtime (parity with SCStream stop on macOS)
    - SendMonitor newtype + whole-struct capture idiom for xcap_backend's
      dedicated capture thread
key-files:
  created:
    - crates/capture/src/windows/frame_from_wgc.rs
    - crates/capture/src/windows/window.rs
    - crates/capture/tests/wgc_real_capture.rs
    - .github/workflows/capture-windows.yml
    - .planning/phases/05-window-targeted-screen-capture-with-playwright-auto-follow/deferred-items.md
  modified:
    - crates/capture/src/windows/mod.rs (export frame_from_wgc, window)
    - crates/capture/src/windows/wgc_backend.rs (stub → real implementation)
    - crates/capture/src/windows/raii.rs (SAFETY section header for clippy)
    - crates/capture/src/lib.rs (pick_default_backend prefers native)
    - crates/capture/src/fallback/xcap_backend.rs (Send fix, std::thread loop)
    - crates/capture/Cargo.toml (real-capture-windows feature + expanded
      windows crate features)
    - apps/desktop/src-tauri/src/commands/capture.rs (Windows IPC dispatch
      in list_windows + start_capture_target)
decisions:
  - D-06 honored: CursorCaptureSettings::WithCursor — cursor is always in the
    WGC output (no user-configurable toggle in v1, matches macOS D-06)
  - D-07 honored: WGC window-target failure falls back to xcap full-display
    via Plan 05-01 orchestrator — unchanged, now exercised on Windows too
  - D-08 honored: 2nd consecutive fallback in a session routes through the
    same FallbackCounter → WindowCaptureDegraded event path as macOS
  - Open Question 4 resolved: Chromium parent/child model handled by a
    ToolHelp snapshot walk restricted to chrome.exe/msedge.exe/chromium.exe
    process names (T-05-03-07), falling back only when the primary
    Window::enumerate-by-pid filter finds nothing
  - PTS clock source set to ClockSource::Synthetic (host-derived) on the
    WGC path — windows-capture's Frame::timestamp returns a QPC TimeSpan,
    but Plan 01-08's encoder accepts Synthetic; swapping to true QPC is a
    follow-up that also requires encoder-side plumbing
metrics:
  duration_hours: ~0.2 (executor wall time on macOS; Windows real-capture
    test runs pending on operator VM)
  tasks_completed: 4 of 4 (Task 4 checkpoint auto-approved under
    workflow.auto_advance=true)
  completed: 2026-04-17
---

# Phase 5 Plan 3: Windows WGC Parity Summary

**One-liner:** Real Windows.Graphics.Capture backend on `windows-capture = 2.0.0`
plus Windows-side window enumeration, Playwright-auto pid→HWND resolution
(with Chromium child-walk), and a PR-CI build gate — lights up Windows
parity behind the Plan 05-01 `CaptureTarget` / orchestrator surface with
zero changes to UI code or IPC shapes.

## Tasks Completed

| # | Task | Commit |
|---|------|--------|
| 0 | Wave-0 — WGC test scaffolds + capture-windows CI gate + xcap Send fix | `a208dcc` |
| 1+2 | Real WgcBackend + frame_from_wgc + Windows window.rs (combined — wgc_backend depends on window::find_window_by_pid for WindowByPid target) | `dbd389c` |
| 3 | Windows IPC wiring (list_windows + start_capture_target dispatch) + orchestrator plug-in | `26dc7ef` |
| 4 | Human-verify checkpoint — auto-approved (outstanding manual verification below) | — |

## What Was Built

### `crates/capture/src/windows/wgc_backend.rs` — real WGC integration

Replaces the stub `start`/`stop` bodies with a real
`windows_capture::capture::GraphicsCaptureApiHandler` implementation:

- **`WgcBackend`** now stores an `Option<CaptureControl<WgcHandler, …>>` in
  its state; `start` calls `WgcHandler::start_free_threaded(settings)` and
  stashes the control; `stop` consumes the control on a
  `tokio::task::spawn_blocking` scope so the async runtime doesn't stall
  while WGC's message loop drains.
- **`WgcHandler`** is a tiny handler struct (not exposed outside the
  module) with fields `(out: mpsc::Sender<Frame>, event_sink, start_epoch,
  dropped, delivered)`. Dependencies reach the capture thread via the
  `WgcFlags` struct routed through `Settings::new(flags = …)` →
  `Context<Flags>` → `GraphicsCaptureApiHandler::new`.
- **`on_frame_arrived`** calls `frame_from_wgc::to_frame` then
  `self.out.try_send(frame)`. It NEVER awaits or blocks — per the same
  rule as the macOS SCK output closure (Pitfall 6). On `Full`, it bumps
  a `dropped` counter; on `Closed`, it returns silently (the consumer
  went away; the capture thread will wind down).
- **`on_closed`** emits `CaptureEvent::BackendFailed { reason }` through
  the registered sink so the orchestrator finalizes the partial MP4
  (parity with macOS SCK delegate `on_stop`).
- **Target dispatch** matches the plan:
    - `Display { .. }` → `Monitor::primary()` (windows-capture 2.0's
      `Monitor` does not expose a per-id filter; for multi-display support
      we rely on xcap enumeration to surface choices + WGC capturing the
      primary — future polish task).
    - `Window { window_id }` → unpack `isize` HWND from the `WindowId` and
      `Window::from_raw_hwnd(hwnd as *mut c_void)`.
    - `WindowByPid { pid, title_hint }` → call
      `capture::windows::window::find_window_by_pid(pid, title_hint)` and
      wrap the returned HWND.
- **Settings** uses `CursorCaptureSettings::WithCursor` (D-06) and
  `ColorFormat::Bgra8` so `frame_from_wgc` takes the zero-swap fast path.
- **DPI awareness** set at `WgcBackend::new` via
  `SetProcessDpiAwarenessContext(PER_MONITOR_AWARE_V2)` so all
  subsequent enumeration reports physical pixels (Pitfall §7).

### `crates/capture/src/windows/frame_from_wgc.rs`

WGC Frame → `crate::Frame` via `Frame::buffer()` →
`FrameBuffer::as_nopadding_buffer`, copied into an owned `Vec<u8>` with
stride `= width * 4`. `FrameData::Owned(..)` route (same as xcap's
fallback path). The comment block at the top explicitly documents that
zero-copy via `FrameData::NativeWindows` (D3D11 texture handle) is a
planned optimization — the current FFmpeg sidecar accepts CPU BGRA so
we don't need zero-copy for correctness.

Rgba8 → Bgra8 defensive channel-swap guards against Settings drift
(we request Bgra8 explicitly).

Process-wide monotonic sequence counter matches the macOS
`frame_from_sample::SEQUENCE` pattern.

### `crates/capture/src/windows/window.rs`

- **`list_windows() -> Result<Vec<WindowInfo>, CaptureError>`** uses
  `windows_capture::window::Window::enumerate()` (which in turn runs
  `EnumChildWindows(GetDesktopWindow(), …)` + `Window::is_valid` in its
  callback — filters visible, non-tool, non-child, non-self). Additional
  filters on top: (1) require title OR process_name to be present,
  (2) `ProcessIdToSessionId` cross-session filter (T-05-03-03).

- **`find_window_by_pid(pid, title_hint) -> Option<isize>`** retries
  10×100ms (configurable via `STORYCAPTURE_WGC_PID_RETRIES` env for the
  real-capture tests). Primary path filters `Window::enumerate()` by
  `Window::process_id()`. Tiebreaker: largest window area.

  On miss, it calls `chromium_child_pids(parent_pid)` — a
  `CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS)` walk via
  `Process32FirstW`/`Process32NextW` that collects children whose
  `th32ParentProcessID` matches the parent AND whose process name is
  exactly `chrome.exe` / `msedge.exe` / `chromium.exe` (T-05-03-07). It
  then re-runs the primary filter against that child-pid set, logs at
  DEBUG that the child-walk fired, and returns the first match.

- **Non-Windows stubs** so callers compile on macOS without cfg arms.

### `crates/capture/tests/wgc_real_capture.rs`

Five `#[ignore]`-marked tests under `--features real-capture-windows`:
`wgc_monitor_smoke`, `wgc_window_smoke`, `wgc_window_close_recovery`,
`wgc_find_window_by_pid_chromium`, `list_windows_excludes_self_windows`.
Documented operator instructions embedded at the top of the file. The
`wgc_find_window_by_pid_chromium` test reads a pre-launched Chromium PID
from `STORYCAPTURE_TEST_CHROMIUM_PID` so the test doesn't need to embed
a Playwright launch.

### `.github/workflows/capture-windows.yml`

Triggers on PRs (and main pushes) touching the Windows capture surface.
Runs on `windows-latest`:
- `cargo build -p capture --target x86_64-pc-windows-msvc`
- `cargo test -p capture --no-run` (default features)
- `cargo test -p capture --no-run --features real-capture-windows`
  (compile-checks the operator-VM tests so they can't silently rot)
- `cargo clippy -p capture --all-features -- -D warnings`

Real-capture tests remain operator-triggered — the runner has no GUI
session, so WGC itself cannot exercise them. This is called out in the
workflow's header comment and in the test file's module doc.

### `apps/desktop/src-tauri/src/commands/capture.rs`

- `list_windows` command gains a `cfg(target_os = "windows")` branch that
  dispatches to `capture::windows::window::list_windows` via
  `spawn_blocking` (parity with the macOS `SCShareableContent` branch),
  populates the `window_allow_list` for T-05-03-01 validation, and
  returns identical `WindowInfoDto` shapes.
- `start_capture_target` now picks `WgcBackend` on Windows and pre-wires
  its event sink to the same `mpsc::UnboundedSender<CaptureEvent>` the
  macOS path uses. The existing WindowId allow-list check +
  capture_target persistence run on every platform unchanged.

TypeScript IPC types and the Plan 05-01 `TargetPicker` UI light up with
real Windows data without frontend changes — tauri-specta regenerates
nothing new because the DTO shapes are unchanged.

### `crates/capture/src/fallback/xcap_backend.rs` — Rule-3 Send fix

Plan 05-01 shipped an xcap backend that `tokio::spawn`s the capture loop
and moves an `xcap::Monitor` (which holds a `!Send` HMONITOR pointer on
Windows) into the future. Every Windows build would fail with
"future cannot be sent between threads safely" — this blocks both the
Plan 05-03 Windows cross-compile and the new `capture-windows.yml` CI
workflow from ever going green.

Fix: move the capture loop to a dedicated `std::thread::spawn`, push
frames via `mpsc::Sender::blocking_send`, wrap the Monitor in a
`SendMonitor` newtype with an explicit `unsafe impl Send` (sound — the
monitor is owned by exactly one thread), and use a `let monitor = monitor;`
shadow inside the closure to defeat RFC-2229 disjoint captures so the
closure captures the `SendMonitor` as a whole (`Send`) not the inner
`!Send` `Monitor`. Documented inline.

### `crates/capture/src/lib.rs`

`pick_default_backend` now prefers `WgcBackend::new()` on Windows and
`SckBackend::new()` on macOS before falling back to xcap. The
per-target orchestrator still handles the window-capture fallback for
orchestrated callers.

## Tests

| Suite | Command | Result |
|-------|---------|--------|
| capture lib unit tests | `cargo test -p capture --lib` | 11 passed (macOS) |
| Windows cross-compile (default) | `cargo check -p capture --target x86_64-pc-windows-msvc` | green |
| Windows cross-compile (all features) | `cargo check -p capture --target x86_64-pc-windows-msvc --all-features` | green |
| Windows tests compile | `cargo check -p capture --target x86_64-pc-windows-msvc --features real-capture-windows --tests` | green |
| Windows clippy | `cargo clippy -p capture --target x86_64-pc-windows-msvc --all-features -- -D warnings` | clean |
| macOS capture check | `cargo check -p capture` | green |
| Windows real-capture tests | `cargo test --features real-capture-windows -- --ignored --test-threads=1` | **Not run** — requires a graphical Windows host, operator-VM gated |
| capture-windows.yml CI run | workflow_dispatch on windows-latest | **Not run** — cannot be triggered from macOS host without push access; operator must trigger |

**Platform caveat.** The executor runtime is macOS (Darwin). All
`x86_64-pc-windows-msvc` checks were cross-compilation against the
installed toolchain — they verify the Rust type system + borrow checker
+ linker contract, but NOT runtime behavior on a real Windows host. The
five `real-capture-windows` tests and the real CI workflow run remain
open and are called out explicitly in the Outstanding Verification list
below.

## Deviations from Plan

### Auto-fixed issues

**1. [Rule 3 — Blocking dep] Pre-existing xcap `!Send` regression on Windows**
- **Found during:** Task 0 baseline compile
- **Issue:** Plan 05-01's `xcap_backend.rs` uses `tokio::spawn` over a
  closure that captures `xcap::Monitor`. On Windows the inner `HMONITOR`
  is `!Send`, so the compile fails with
  `error[E0277]: *mut c_void cannot be sent between threads safely`.
  Every Windows build — existing AND my new code — would break.
- **Fix:** Switched the capture loop to `std::thread::spawn`, frames go
  out via `blocking_send` on the tokio channel. Wrapped the Monitor in a
  `SendMonitor` newtype with `unsafe impl Send`, with an inline shadow
  binding inside the closure to defeat RFC-2229 disjoint captures.
- **Files modified:** `crates/capture/src/fallback/xcap_backend.rs`
- **Commit:** `a208dcc`

**2. [Rule 2 — Missing critical functionality] Cross-session filter in list_windows**
- **Found during:** Task 2 implementation; threat-model review
- **Issue:** `windows-capture::Window::enumerate` returns windows from the
  current desktop (via `EnumChildWindows(GetDesktopWindow())`), which on
  multi-session Windows hosts could include windows owned by other TS
  sessions (T-05-03-03). Not covered by the plan's narrative but
  explicitly required by the threat register.
- **Fix:** Added a `ProcessIdToSessionId` FFI call (direct kernel32 link
  — bypasses windows-rs feature-flag drift) + a session-ID match filter
  in `list_windows()`. Same-session self-pid filter is doubly covered
  (both windows-capture's `is_valid` and our explicit check).
- **Files modified:** `crates/capture/src/windows/window.rs`
- **Commit:** `dbd389c`

**3. [Rule 1 — Bug] Clippy `missing_safety_doc` on raii.rs unblocks the CI gate**
- **Found during:** Task 3 clippy verification
- **Issue:** `raii.rs` is pre-existing Phase 1 code using `SAFETY:` prose
  where Clippy requires a `# Safety` markdown header. The new
  `capture-windows.yml` CI gate runs `clippy -D warnings`, so this
  would block every PR touching `crates/capture/src/windows/**`.
- **Fix:** Converted the comment to the `# Safety` header form. No
  behavior change.
- **Commit:** `26dc7ef`

### Scope decisions

- **Task 1 + Task 2 landed in one commit** (`dbd389c`). `WgcBackend::start`
  directly depends on `crate::windows::window::find_window_by_pid` to
  resolve the `WindowByPid` variant; splitting them into two commits
  would have left a mid-commit broken build. Both sets of behaviors are
  verifiable from the single commit; the test file separates them by
  name (`wgc_*_smoke` vs `list_windows_excludes_self_windows`).

- **PTS clock source set to `ClockSource::Synthetic`, not QPC.**
  windows-capture's `Frame::timestamp()` returns a `TimeSpan` in the QPC
  domain; mapping to `i128 ns` via `QueryPerformanceFrequency` requires
  the encoder to agree on clock bases. The xcap fallback already emits
  Synthetic, so the encoder is known to handle it. True QPC plumbing is
  a follow-up (flagged in `frame_from_wgc.rs` doc comment).

- **`Display { display_id }` always captures the primary monitor on
  Windows.** `windows_capture::monitor::Monitor` in 2.0.0 does not expose
  a per-id construction method — only `primary()` and `enumerate()`. The
  plan's success criteria require "record a 5s MP4 of a specific window"
  which works; multi-monitor specific-display capture is a follow-up
  (flagged inline).

- **Task-0 verify regex adjusted.** The plan's verify command tries to
  assert "no warnings" via
  `grep -q "warning\\|error" /tmp/wgc-compile.log` (inverted logic —
  a successful build emits no warnings, so `grep -q` would FAIL). I
  treated the intent as "compile clean" and verified via actual
  `cargo check`/`cargo clippy` exit codes. No behavioral change.

## Authentication Gates

None — this plan is compile-and-ship Rust only.

## Outstanding Verification (Task 4 gate)

The plan's final task is a **blocking** `checkpoint:human-verify`. Under
`workflow.auto_advance = true` it is auto-approved, but the manual
verification on a real Windows host remains **operator-owned**:

- [ ] **Operator runs `capture-windows.yml`** on a throwaway branch and
  confirms green. Triggering requires a GitHub push; the executor on
  macOS cannot fire this from within the plan.
- [ ] On a Windows 10/11 x64 host with a graphical session:
    - [ ] `pnpm install && pnpm --filter @storycapture/desktop tauri dev`
      launches; the Plan 05-01 Target dropdown populates with real
      Windows displays + visible windows; StoryCapture's own window is
      absent.
    - [ ] Pick Notepad → Record 10s → play MP4 — only Notepad visible,
      with cursor.
    - [ ] During recording, close Notepad — recording stops cleanly
      (toast + partial MP4 plays).
    - [ ] Launch a story → "Playwright browser (auto)" enables and
      pre-selects → record 10s → play MP4 — only Chromium visible.
    - [ ] Minimize a target mid-capture to force WGC failure → confirm
      silent xcap fallback + warning toast.
    - [ ] Run `cargo test -p capture --target x86_64-pc-windows-msvc
      --features real-capture-windows -- --ignored --test-threads=1`
      on the VM; expect all five WGC tests green. The Chromium test
      requires `STORYCAPTURE_TEST_CHROMIUM_PID` env var (set to a
      headed Chromium's pid before running).

## Known Stubs

- **Multi-display capture on Windows** currently binds to
  `Monitor::primary()` regardless of `CaptureTarget::Display.display_id`.
  Enumeration surfaces all displays via the xcap shim (used only for the
  picker), so the picker is correct but the actual capture is always
  primary. Not blocking for the plan's success criteria (Notepad + single
  Chromium window records), but flagged as a known limitation in
  `wgc_backend.rs` source + the `Display` arm's comment.

- **Zero-copy D3D11 handle pass-through** not wired. `frame_from_wgc`
  always copies into `FrameData::Owned`. `FrameData::NativeWindows`
  variant exists on the Frame type but the WGC → texture-handle bridge
  (via `Frame::as_raw_texture` + `D3DTextureHandle::from_raw` after an
  `AddRef`) is a performance optimization, not a correctness requirement.

## Threat Flags

No new surfaces beyond the plan's `<threat_model>`. The Chromium
child-walk narrows `T-05-03-07` to chrome/edge/chromium process names as
specified; session filter implements `T-05-03-03`; window-id allow-list
continues to enforce `T-05-03-01` unchanged on the Windows path.

## TDD Gate Compliance

Tasks 1 and 2 are marked `tdd="true"`. RED/GREEN ordering was compressed:
the Task-0 test scaffolds land `#[ignore]`-marked but compile-green
against the eventual Task 1/2 API (they reference `WgcBackend` +
`capture::windows::window::find_window_by_pid` which are created in the
same Task-1+2 commit). This mirrors the 05-01 accepted deviation: tests
landing alongside the behaviors they cover because the trait surface is
new — there's no meaningful "failing test" for a symbol that doesn't
exist yet. All tests covering the `<behavior>` blocks are present under
`--features real-capture-windows`.

## Windows-test status summary

| Verification | Runnable on macOS executor | Status |
|--------------|----------------------------|--------|
| `cargo check --target x86_64-pc-windows-msvc` | ✅ Yes | ✅ Green |
| `cargo check --target … --all-features` | ✅ Yes | ✅ Green |
| `cargo clippy --target … -- -D warnings` | ✅ Yes | ✅ Green |
| `cargo test -p capture --lib` (macOS) | ✅ Yes | ✅ 11/11 passed |
| `cargo test … --features real-capture-windows` (no-run) | ✅ Yes | ✅ Compiles |
| `cargo test … --features real-capture-windows -- --ignored` | ❌ No | ⏸ Operator VM pending |
| `capture-windows.yml` CI workflow live run | ❌ No | ⏸ Requires GitHub push |
| Desktop-app end-to-end recording on Windows | ❌ No | ⏸ Operator VM pending |

## Self-Check: PASSED

Files created exist:
- `crates/capture/src/windows/frame_from_wgc.rs` — FOUND
- `crates/capture/src/windows/window.rs` — FOUND
- `crates/capture/tests/wgc_real_capture.rs` — FOUND
- `.github/workflows/capture-windows.yml` — FOUND
- `.planning/phases/05-window-targeted-screen-capture-with-playwright-auto-follow/deferred-items.md` — FOUND

Commits exist in `git log`:
- `a208dcc` — FOUND
- `dbd389c` — FOUND
- `26dc7ef` — FOUND
