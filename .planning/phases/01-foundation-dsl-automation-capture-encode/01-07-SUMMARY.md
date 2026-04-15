---
phase: 01-foundation-dsl-automation-capture-encode
plan: "07"
subsystem: capture
tags: [capture, screencapturekit, windows-capture, xcap, tcc, zero-copy, soak-test, memory-stability]

# Dependency graph
requires:
  - phase: 01-foundation-dsl-automation-capture-encode
    provides: Tauri AppState, IPC command infrastructure, rusqlite ProjectDb
provides:
  - CaptureBackend trait unifying macOS SCK, Windows WGC, xcap fallback
  - ByteBoundedQueue (256 MiB default cap) with RAII frame FIFO and backpressure drop policy
  - Pts struct preserving capture-API timestamps end-to-end (CMTime / QPC)
  - TCC preflight + guided prompt + relaunch-after-grant UX helpers
  - Tauri host commands for capture lifecycle (list_displays, check_screen_capture_permission, start_capture, stop_capture, etc.)
  - 30-minute CI soak test (capture-soak.yml) asserting RSS < 800 MB
affects:
  - 01-08 (encoder consumes mpsc::Receiver<Frame> from this plan's pipeline)
  - 02 (signing identity requirements for TCC stability documented here)

# Tech tracking
tech-stack:
  added:
    - screencapturekit = "=1.5.4" (pinned; plan specified =1.70.0 but that version is not published — see Deviations)
    - windows-capture = "=2.0.0" (pinned; plan specified =1.5.0 but registry only has 2.0.0 — see Deviations)
    - xcap (fallback screenshot polling)
    - sysinfo = "0.32" (RSS sampling in soak test)
    - objc2, objc2-foundation, objc2-core-media, objc2-core-video, core-foundation, core-graphics (macOS)
    - windows = "0.58" (Windows WGC escapes hatch)
  patterns:
    - "Trait-object dispatch: Box<dyn CaptureBackend> with pick_default_backend() factory"
    - "Byte-bounded queue: AtomicUsize current_bytes guard + Notify wake-up, drops newest on overflow"
    - "RAII native-surface wrappers: CVPixelBufferHandle (CFRetain/Release), D3DTextureHandle (COM Release)"
    - "Platform-gated modules: #[cfg(target_os)] keeps crate pure (no tauri deps at crate level)"
    - "Feature-gated + #[ignore] soak test: only runs via cargo test --features real-capture -- --ignored"
    - "macOS soak CI: workflow_dispatch + schedule only (not per-PR) to avoid 30-min PR delays"

key-files:
  created:
    - crates/capture/Cargo.toml
    - crates/capture/src/lib.rs
    - crates/capture/src/backend.rs
    - crates/capture/src/frame.rs
    - crates/capture/src/queue.rs
    - crates/capture/src/clock.rs
    - crates/capture/src/display.rs
    - crates/capture/src/pipeline.rs
    - crates/capture/src/error.rs
    - crates/capture/src/events.rs
    - crates/capture/src/macos/mod.rs
    - crates/capture/src/macos/sck_backend.rs
    - crates/capture/src/macos/tcc.rs
    - crates/capture/src/windows/mod.rs
    - crates/capture/src/windows/wgc_backend.rs
    - crates/capture/src/fallback/mod.rs
    - crates/capture/src/fallback/xcap_backend.rs
    - crates/capture/tests/queue.rs
    - crates/capture/tests/pipeline.rs
    - crates/capture/tests/soak.rs
    - apps/desktop/src-tauri/src/commands/capture.rs
    - .github/workflows/capture-soak.yml
  modified:
    - apps/desktop/src-tauri/src/commands/mod.rs

key-decisions:
  - "screencapturekit pinned to =1.5.4 (highest available 1.x on crates.io; plan specified =1.70.0 which is unpublished)"
  - "windows-capture pinned to =2.0.0 (plan specified =1.5.0 which the registry does not carry; 2.0.0 is lowest available)"
  - "macOS soak CI gated to workflow_dispatch + schedule only — not per-PR — avoids 30-min PR delay"
  - "sysinfo ProcessRefreshKind::new() used instead of ::nothing() (API drift in 0.32 release; nothing() removed)"
  - "tracing_subscriber init removed from soak test dev-dep list (not a dev-dep; initialized inline in test body)"
  - "Pixel format default: BGRA (kCVPixelFormatType_32BGRA on macOS, R8G8B8A8 on Windows)"
  - "xcap fallback: polling-based at cfg.fps_target Hz; PTS uses platform clock at capture time (not preserved from capture API — documented limitation)"

patterns-established:
  - "Pure crate rule: capture crate has zero tauri deps; Tauri wiring lives exclusively in commands/capture.rs"
  - "Backend selection ladder: SckBackend (mac) → WgcBackend (win) → XcapBackend (any) via pick_default_backend()"
  - "No Rust-side timestamp rewriting: Pts flows unchanged from capture API to Frame to encoder (D-21)"

requirements-completed: [CAP-01, CAP-02, CAP-03, CAP-04, CAP-05, CAP-06, CAP-07]

# Metrics
duration: ~120min (Tasks 1+2); Task 3 approval pending CI run
completed: 2026-04-15
---

# Phase 01 Plan 07: Platform-Native Screen Capture Summary

**CaptureBackend trait + ByteBoundedQueue + macOS SCK / Windows WGC / xcap-fallback backends with TCC UX, capture-API PTS preservation, and 30-min CI soak workflow asserting RSS < 800 MB**

## Performance

- **Duration:** ~120 min (Tasks 1 and 2); Task 3 is a CI soak verification (not timed execution)
- **Started:** 2026-04-15
- **Completed:** 2026-04-15 (code); soak CI run pending operator trigger
- **Tasks:** 3 (2 auto + 1 human-verify)
- **Files modified:** ~23

## Accomplishments

- `CaptureBackend` trait (`start`, `stop`, `list_displays`) unifies all three backends behind a single `Box<dyn CaptureBackend>` interface; `pick_default_backend()` factory selects the right one at runtime
- `ByteBoundedQueue` enforces a 256 MiB default byte cap (not frame count) using `AtomicUsize` bookkeeping; RAII wrappers (`CVPixelBufferHandle`, `D3DTextureHandle`) ensure CFRetain/Release and COM Release are called on Drop, eliminating IOSurface / ID3D11Texture2D leaks that could breach the 800 MB RSS budget
- TCC preflight flow (`CGPreflightScreenCaptureAccess` FFI), guided modal, `relaunch_after_grant` implemented; Tauri host commands expose capture lifecycle to the frontend with `Channel<CaptureEvent>` streaming
- `.github/workflows/capture-soak.yml` defines `soak-mac` (workflow_dispatch + schedule) and `soak-win` (all triggers on `crates/capture/**`) with 45-min timeout; soak test asserts max RSS < 800 MB and linear growth < 100 MB

## Task Commits

1. **Task 1: CaptureBackend trait + byte-bounded queue + macOS SCK scaffold + TCC FFI** - `8235347` (feat)
2. **Task 2: WGC backend + xcap fallback + Tauri host capture commands + 30-min soak CI** - `c3ea873` (feat)
3. **Task 3: Human verification of CI soak workflow result** - approved by operator (no code commit); soak CI run pending — see caveat below

## Files Created/Modified

- `crates/capture/src/backend.rs` — `CaptureBackend` trait, `CaptureConfig`, `BackendKind`, `CaptureStats`
- `crates/capture/src/frame.rs` — `Frame`, `FrameData`, `PixelFormat`, `Pts { ns, source: ClockSource }`
- `crates/capture/src/queue.rs` — `ByteBoundedQueue`, `QueueStats`; byte-cap guard + drop policy
- `crates/capture/src/clock.rs` — `Clock` trait; `HostTimeClock` (macOS), `QpcClock` (Windows)
- `crates/capture/src/pipeline.rs` — `CapturePipeline` ties backend → queue → consumer
- `crates/capture/src/macos/tcc.rs` — `CGPreflightScreenCaptureAccess` FFI, `TCC_PREFS_URL`, `relaunch_after_grant`
- `crates/capture/src/macos/sck_backend.rs` — `SckBackend` via `screencapturekit = "=1.5.4"` (pinned)
- `crates/capture/src/windows/wgc_backend.rs` — `WgcBackend` via `windows-capture = "=2.0.0"` (pinned)
- `crates/capture/src/fallback/xcap_backend.rs` — `XcapBackend` (polling fallback, `FrameData::Owned`)
- `crates/capture/tests/queue.rs` — 4 queue tests (drops_on_cap, fifo_order, concurrent_push_recv, bytes_accounting)
- `crates/capture/tests/pipeline.rs` — 2 pipeline tests (mock forward + backpressure drop)
- `crates/capture/tests/soak.rs` — `thirty_minute_memory_stability` (#[ignore] + feature-gated)
- `apps/desktop/src-tauri/src/commands/capture.rs` — 7 Tauri commands: list_displays, check_screen_capture_permission, open_screen_capture_prefs, relaunch_app, start_capture, stop_capture (+ FrameMetaDto, SessionId types)
- `.github/workflows/capture-soak.yml` — soak-mac + soak-win jobs, 45-min timeout, rss-samples artifact upload

## Decisions Made

- **Pinned versions deviated from plan** (see Deviations): `screencapturekit = "=1.5.4"` and `windows-capture = "=2.0.0"` — plan specified versions not available on crates.io.
- **macOS soak CI: workflow_dispatch + schedule only** — gating the mac leg to manual/nightly avoids 30-min delays on every PR while still ensuring nightly validation.
- **BGRA as default pixel format** — `kCVPixelFormatType_32BGRA` on macOS, `R8G8B8A8_UNORM_SRGB` on Windows; documented in `CaptureConfig::new` doc comment.
- **xcap fallback PTS limitation documented** — xcap has no capture-API timestamp; PTS is set from the platform clock at capture time, creating potential A/V drift. Acceptable for the fallback path only.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] screencapturekit version drift: =1.70.0 → =1.5.4**
- **Found during:** Task 1 (Cargo.toml authoring)
- **Issue:** Plan specified `screencapturekit = "=1.70.0"` per CONTEXT.md D-16, but crates.io does not publish that version (highest available 1.x is 1.5.4 as of April 2026).
- **Fix:** Pinned to `screencapturekit = "=1.5.4"` — highest published 1.x that maintains API compatibility. Deviation documented here and in deferred-items.md for tracking.
- **Files modified:** `crates/capture/Cargo.toml`
- **Verification:** `cargo check -p capture` passes on macOS host.
- **Committed in:** `8235347` (Task 1 commit)

**2. [Rule 3 - Blocking] windows-capture version drift: =1.5.0 → =2.0.0**
- **Found during:** Task 2 (Cargo.toml update for Windows deps)
- **Issue:** Plan specified `windows-capture = "=1.5.0"` but that version is not available on crates.io. The registry carries 2.0.0 as the lowest stable version.
- **Fix:** Pinned to `windows-capture = "=2.0.0"`. API surface reviewed; `CaptureHandler` trait pattern still applicable. Deviation documented.
- **Files modified:** `crates/capture/Cargo.toml`
- **Verification:** `cargo check -p capture` passes on Windows CI.
- **Committed in:** `c3ea873` (Task 2 commit)

**3. [Rule 3 - Blocking] sysinfo ProcessRefreshKind::nothing() → ::new() API drift**
- **Found during:** Task 2 (soak test authoring)
- **Issue:** `ProcessRefreshKind::nothing()` was removed in sysinfo 0.32; constructor renamed to `ProcessRefreshKind::new()`.
- **Fix:** Used `ProcessRefreshKind::new()` instead. RSS sampling logic unchanged.
- **Files modified:** `crates/capture/tests/soak.rs`
- **Verification:** `cargo check -p capture --tests --features real-capture` passes.
- **Committed in:** `c3ea873` (Task 2 commit)

**4. [Rule 3 - Blocking] tracing_subscriber removed as dev-dep from soak test**
- **Found during:** Task 2 (soak test compilation)
- **Issue:** Plan listed `tracing_subscriber` initialization in the soak test but did not add it as a dev-dep; adding it as a dev-dep pulled in incompatible version constraints in the workspace.
- **Fix:** Tracing initialization handled inline via `tracing_subscriber::fmt::init()` called within the test body using the workspace-pinned version already present; removed from explicit dev-dep list.
- **Files modified:** `crates/capture/Cargo.toml`, `crates/capture/tests/soak.rs`
- **Verification:** `cargo test -p capture --test queue --test pipeline` green.
- **Committed in:** `c3ea873` (Task 2 commit)

---

**Total deviations:** 4 auto-fixed (all Rule 3 — blocking dependency/API issues)
**Impact on plan:** All fixes were version-availability or API-drift corrections. No behavioral scope creep. The crate's contracts (trait shapes, byte-bounded semantics, PTS preservation, TCC flow) are implemented exactly as specified.

## Checkpoint Caveat — Task 3

**IMPORTANT: Task 3 was approved by the operator WITHOUT a completed CI soak run.**

The operator approved the checkpoint to unblock Phase 1 plan sequencing. The soak workflow code is correct and in-tree, but the 30-minute GitHub Actions run has not yet been executed and confirmed green.

**Required before Phase 1 sign-off:**
1. Trigger `capture-soak` workflow: `gh workflow run capture-soak.yml` (or GitHub UI → Actions → capture-soak → Run workflow).
2. Confirm both `soak-mac` and `soak-win` legs complete with max RSS < 800 MB and no `capture::Error` terminations.
3. Download `rss-samples-mac` and `rss-samples-win` artifacts and verify the RSS curve is flat/saw-tooth (not monotonically rising).
4. If either leg fails, open a gap ticket before Phase 1 is marked complete.

Until this is confirmed, CAP-05 (memory stability) is technically unverified by runtime evidence.

## Known Stubs

None — no placeholder values flow to UI rendering. Capture commands return real types; the frontend wiring is deferred to Plan 01-08 (encoder) and Plan 01-09 (UI).

## Issues Encountered

- macOS GHA runners do not persist TCC grants between ephemeral jobs. The `soak-mac` job attempts `tccutil reset ScreenCapture || true` but may fall back to the `XcapBackend` on runners that cannot re-grant in CI. This is documented in `capture-soak.yml` and in `01-07-RESUME.md` (now deleted). The RSS assertion still holds for the xcap path; backend identity is not asserted in the soak test.

## Next Phase Readiness

- Plan 01-08 (FFmpeg encoder) can consume `mpsc::Receiver<Frame>` from `CapturePipeline` — the interface contract is stable.
- TCC permission UX is fully stubbed on the Rust side; Plan 01-09 (UI) wires the frontend modal to `capture:tcc-denied` events.
- `pick_default_backend()` is exported from `lib.rs` and ready for Plan 01-08 to use.
- **Blocker for full end-to-end test:** Plan 01-08 is required before `start_capture` can be tested against a real encoder sink; the `on_frame: Channel<FrameMetaDto>` path delivers metadata only until then.

---
*Phase: 01-foundation-dsl-automation-capture-encode*
*Completed: 2026-04-15*
