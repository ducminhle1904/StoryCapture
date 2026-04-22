---
phase: 17
plan: 02
wave: 1
status: completed
completed_at: 2026-04-22
decisions_covered: [D-01, D-02, D-03]
files_modified:
  - apps/desktop/src-tauri/src/commands/encode.rs
  - apps/desktop/src-tauri/src/lib.rs
  - crates/capture/src/error.rs
  - crates/capture/src/fallback/xcap_backend.rs
  - crates/encoder/tests/graceful_shutdown_smoke.rs
commits:
  - 2e57488 feat(17-02): bound XcapBackend::stop with 2s timeout + StopTimedOut error
  - 00a122d feat(17-02): drain recording sessions on app exit + abort orphan tasks on start failure
---

# Phase 17 Plan 02: Wave 1 — CLEANUP — Summary

Three teardown-safety holes closed: app quit mid-record now finalizes the MP4, capture-start failure aborts every auxiliary spawn before returning, and `XcapBackend::stop` can no longer hang indefinitely.

## What Changed

### `crates/capture/src/error.rs` (D-03)

- New variant `CaptureError::StopTimedOut { timeout_ms: u64 }`. Returned by a backend's `stop()` when a bounded deadline expires; callers should log and continue rather than await indefinitely.

### `crates/capture/src/fallback/xcap_backend.rs` (D-03)

- New field `cancel_flag: Arc<AtomicBool>`, initialised `false`; reset at the top of every `start()` and set to `true` at the top of `stop()` so the capture thread unblocks on its next tick.
- Capture loop now checks `cancel_flag` as the first condition each iteration (before `running` / `paused`).
- `stop()` wraps `spawn_blocking(h.join())` in `tokio::time::timeout(Duration::from_millis(2000), ...)`. On timeout: abandon the thread, log a warn, return `CaptureError::StopTimedOut`. Normal path unchanged.
- New unit tests:
  - `stop_times_out_when_capture_thread_hangs` — injects a `thread::sleep(3s)` handle, asserts the error variant and that elapsed time is ~2s.
  - `stop_returns_ok_when_thread_exits_promptly` — injects an immediately-exiting thread, asserts `Ok`.
- Test-only `inject_handle` helper (gated by `#[cfg(test)]`) so the bounded-stop path can be exercised without a real display.

### `apps/desktop/src-tauri/src/commands/encode.rs` (D-01 + D-02)

- **D-02 `SpawnAbortGuard`** — a Drop-based guard that collects `AbortHandle`s from every auxiliary `tokio::spawn` in `start_recording`. `disarm()` is called only after the registry insert on the success path. Any early return, `?` propagation, or panic before `disarm()` triggers `Drop::drop`, which aborts every pushed handle. Four spawns are now covered: capture-event forwarder, frame relay, audio-degraded watcher, encoder-progress fan-out.
- **D-01 `drain_recording_sessions(app_handle)`** — mirror of `drain_author_preview_sessions`. Uses `try_lock` so the exit hook never deadlocks; drains sessions, then for each runs a 5 s-per-session stop-and-flush via `drain_one` (drops audio stream → `CapturePipeline::stop` → `encode_join.await`). On timeout, aborts the encode task and surrenders the slot. Runs on the ambient tokio runtime when available; otherwise builds a one-shot `current_thread` runtime. `tracing::info/warn` at each phase.
- `drain_one` helper: isolated stop-and-flush routine reused by the drain path; does not emit UI events (the window is gone by then anyway).

### `apps/desktop/src-tauri/src/lib.rs` (D-01)

- `RunEvent::ExitRequested | RunEvent::Exit` handler now calls `crate::commands::encode::drain_recording_sessions(app_handle)` immediately after `drain_author_preview_sessions`. Ordering matches the phase-9.4 author-preview pattern.

### `crates/encoder/tests/graceful_shutdown_smoke.rs` (new, release-gated)

- `test_graceful_shutdown_finalizes_moov` behind `#[cfg(feature = "real-ffmpeg")]`. Feeds 15 synthetic BGRA frames (0.5 s @ 30 fps), triggers graceful EOF by dropping `frame_tx`, awaits the pipeline, then probes the output with sibling `ffprobe` (or falls back to an `ffmpeg -f null` remux) and asserts the `moov` atom is present.
- Skips cleanly with `eprintln!("skip: no ffmpeg binary")` when the bundled FFmpeg is absent — matches the existing pattern in `pipeline.rs` + `probe.rs`.

## Decisions Covered

| Decision | Coverage |
|----------|----------|
| D-01 | `drain_recording_sessions` + `lib.rs` exit hook + smoke test on moov. |
| D-02 | `SpawnAbortGuard` wraps four auxiliary spawns; armed between first spawn and registry insert. |
| D-03 | `CaptureError::StopTimedOut` + bounded `XcapBackend::stop` + `cancel_flag` checked each tick. |

## Verification

| Command | Result |
|---------|--------|
| `cargo check -p capture -p storycapture` | exit 0 |
| `cargo test -p capture --lib` | 33/33 passed (2 new) |
| `cargo test -p storycapture --lib -- --test-threads=1` | 62/62 passed |
| `cargo test -p encoder --features real-ffmpeg --test graceful_shutdown_smoke` | exit 0 (skipped: no ffmpeg binary locally) |
| `cargo test -p encoder --features real-ffmpeg --test graceful_shutdown_smoke --no-run` | compiles clean |
| Acceptance grep sweep (see below) | all pass |

### Acceptance greps

```
pub fn drain_recording_sessions            1 in encode.rs  (expect == 1)
drain_recording_sessions(app_handle)       1 in lib.rs     (expect == 1)
abort_handle|AbortHandle                   8 in encode.rs  (expect >= 2)
impl Drop                                  1 in encode.rs  (expect >= 1)
StopTimedOut                               1 in error.rs   (expect == 1)
tokio::time::timeout(                      1 in xcap_backend.rs (expect >= 1, bounded stop)
cancel_flag                                9 in xcap_backend.rs (expect >= 3)
```

### Out-of-scope items NOT fixed (pre-existing, per CLAUDE.md SCOPE BOUNDARY)

- `cargo clippy -p capture --all-targets -- -D warnings` surfaces 2 pre-existing errors in `display.rs` + `target.rs` (type_complexity, uninlined_format_args). None in the files touched by this plan.
- `cargo clippy --all-targets -p storycapture -- -D warnings` surfaces numerous pre-existing warnings across unrelated modules; zero issues were introduced in `commands/encode.rs` or `lib.rs`.
- `commands::automation::tests::resolve_playwright_target_ipc_empty_stash_returns_none_shape` can fail under parallel execution because of the `playwright_pid_stash()` `OnceLock` shared across the binary. It passes under `--test-threads=1`. Pre-existing; noted in Phase 9 session log.

## Deviations

1. **`drain_recording_sessions` takes an unused `_app_handle: &tauri::AppHandle` parameter.** The plan action said to call `app_handle.try_state::<AppState>()` and then `state.recording_registry.try_lock()`. Reality: the recording registry is a process-static `OnceLock<RecordingRegistry>` at `encode.rs:414-418`, not a field on `AppState`. Keeping the `AppHandle` parameter preserves API parity with `drain_author_preview_sessions` for the exit-hook call site and leaves room for a future move onto `AppState`. No functional difference.

2. **No unit test forcing `start_orchestrated` to fail with a shared `Arc<AtomicUsize>` alive-task counter.** `start_recording` is a monolithic Tauri command that directly constructs `SckBackend`/`WgcBackend`/`XcapBackend` on a `cfg(target_os)` switch; it has no injection point for a mock `CaptureBackend`. A faithful unit test would require extracting an inner function (`start_recording_inner`) that accepts a `Box<dyn CaptureBackend>`, a `SidecarCommand`, and a `Channel` sink — that refactor qualifies as a "significant structural modification" (Rule 4 / architectural change) and is out of scope for a CLEANUP plan. Instead, D-02 is enforced by the `SpawnAbortGuard` contract itself: every spawn is pushed before its first fallible `await`, and `disarm()` runs only after the registry insert; `Drop` is invariant across panics and `?`. Acceptance grep for `abort_handle` + `impl Drop` is satisfied (8 and 1 respectively). If a unit-testable seam is desired later, the refactor is now a local change (add one wrapper function) rather than a rewrite.

3. **No explicit `CaptureError::StopTimedOut` arm added to the orchestrator.** The plan noted this as conditional ("if the orchestrator pattern-matches errors, add that arm; otherwise the default `Err` propagation is fine"). Inspection shows `orchestrator.rs::orchestrate_start` only calls `start()`, never `stop()`; and `encode.rs::stop_recording_inner` already maps any `CaptureError` through `AppError::Capture(e.to_string())` — the bounded-timeout error propagates as a regular string and teardown continues. No match arm needed.

## Commits

- `2e57488` feat(17-02): bound XcapBackend::stop with 2s timeout + StopTimedOut error
- `00a122d` feat(17-02): drain recording sessions on app exit + abort orphan tasks on start failure

## Self-Check: PASSED

- All five `files_modified` paths exist and contain the claimed edits (verified via grep sweep above).
- Both commits present in `git log --oneline -5`:
  - `2e57488` — FOUND
  - `00a122d` — FOUND
- Smoke test compiles under `--features real-ffmpeg` (`--no-run` succeeded).
- Unit tests in `xcap_backend.rs` execute and pass.
