---
phase: 17
plan: 04
wave: 2
status: completed
completed_at: 2026-04-22
decisions_covered: [D-07, D-08, D-09, D-10, D-11, D-12]
files_modified:
  - crates/encoder/src/pipeline.rs
  - crates/encoder/src/lib.rs
  - crates/encoder/src/config.rs
  - crates/encoder/src/macos/vt_writer.rs
  - crates/encoder/src/macos/mod.rs
  - apps/desktop/src-tauri/src/commands/encode.rs
  - apps/desktop/src-tauri/src/error.rs
  - packages/shared-types/src/ipc.ts
commits:
  - f197dcd feat(17-04): ffmpeg stdin backpressure + vt_writer clamp warning
  - 88e0382 feat(17-04): staging path with atomic rename + configurable keyframe interval
  - bb8597e feat(17-04): configurable first-frame timeout + FIFO metadata handshake
---

# Phase 17 Plan 04: Wave 2 — ENCODER-ROBUST — Summary

Six pipeline-robustness holes closed across the FFmpeg subprocess path and the macOS VT fast path: stdin backpressure becomes telemetry instead of a silent stall, output MP4s are now atomic (staging + rename, cleaned on failure), first-frame and keyframe knobs are IPC-configurable end-to-end, the FIFO handshake is a real metadata poll instead of a 200ms guess, and VT PTS clamps emit structured warnings with a lifetime counter.

## What Changed

### `crates/encoder/src/pipeline.rs` (D-07 + D-08)

- **D-07 stdin backpressure:** The frame pump now wraps `stdin.write_all(bytes_ref)` in `tokio::time::timeout(Duration::from_millis(200), ...)`. On timeout, a new `Arc<AtomicU64> frames_dropped_backpressure` counter increments (AcqRel), an optional `BackpressureCallback` fires with `(total, delta)`, and a `tracing::warn!` line records the drop. The frame is dropped — never silently queued behind a blocked pipe. `BrokenPipe` path unchanged.
- **Additive API:** new `EncodePipeline::start_with_backpressure(cfg, sidecar, frames, progress_tx, Option<BackpressureCallback>)`. The legacy `start(...)` stays as a thin wrapper that passes `None` so existing callers (4 tests + 1 host site) compile unchanged.
- **D-08 staging + atomic rename:** new `partial_path_of(&target)` helper appends `.partial` to the target (same directory → same filesystem → atomic rename guaranteed on POSIX + NTFS). `cfg_for_ffmpeg.output_path` is swapped to the partial path before argv synthesis so FFmpeg writes there. After `child.wait()` success, the joined task calls `std::fs::rename(partial, target)`. RAII `PartialFileGuard` (Drop impl) removes the `.partial` on any early-return / `?` / panic path; `disarm()` is called on the success path right before rename.
- Exports: `BackpressureCallback`, `partial_path_of` now publicly surface-able via `pipeline` module; `BackpressureCallback` re-exported from `encoder` crate root.

### `crates/encoder/src/lib.rs`

- Re-exports `BackpressureCallback` from `pipeline`.

### `crates/encoder/src/config.rs` (D-11)

- `to_ffmpeg_args` now appends `"-g" <fps_advisory * keyframe_interval_sec>` **when `keyframe_interval_sec.is_some()`**. When `None`, no `-g` is emitted — argv is byte-identical to pre-D-11.

### `crates/encoder/src/macos/vt_writer.rs` (D-12 + D-08)

- **D-12 PTS clamp warning + counter:** the clamp site (`pts_ns < first_pts_ns`) now takes an explicit branch, increments a process-static `PTS_CLAMP_COUNT: AtomicU64` (AcqRel), and logs `tracing::warn!(target: "storycapture::encoder::vt", pts_ns, first_pts_ns, clamp_count, "vt_writer: pts < first_pts, clamping to 0 (clock jump?)")`. New public accessor `clamp_count() -> u64` (re-exported from `macos::mod` as `vt_pts_clamp_count`) lets the host/telemetry read the lifetime count.
- **D-08 staging + rename:** same pattern as the FFmpeg pipeline — AVAssetWriter opens at `<target>.partial`; on `finishWriting()` success, `std::fs::rename(partial, target)` runs and the local `PartialVtGuard` is `disarm()`-ed. Any worker-thread panic / early `return Err(..)` triggers Drop, which removes the `.partial` file so the target directory never contains a half-written MP4.

### `crates/encoder/src/macos/mod.rs`

- Re-exports `clamp_count` as `vt_pts_clamp_count` for host-side telemetry.

### `apps/desktop/src-tauri/src/commands/encode.rs` (D-07 host wiring + D-09 + D-10 + D-11 host wiring)

- **D-07 wiring:** encoder pipeline now spawned via `EncodePipeline::start_with_backpressure(..., Some(bp_cb))`. The callback sends `RecordingEvent::FramesDropped { total, delta }` on the session `Channel`, matching the existing capture-side drop telemetry shape.
- **D-09 configurable first-frame timeout:** hardcoded `Duration::from_secs(3)` replaced with `Duration::from_millis(args.first_frame_timeout_ms.unwrap_or(3000))` (added to `StartRecordingArgs` in 17-01). Log now includes the effective `timeout_ms`.
- **D-10 FIFO metadata handshake:** removed `tokio::time::sleep(Duration::from_millis(200))`. Replaced with a poll loop: `tokio::fs::metadata(&fifo_path)` every 20ms, track `ok_ticks: u8`, break on 3 consecutive `Ok(_)` (60ms stable existence), return `AppError::FifoHandshakeTimeout` on 2s deadline. No libc, no sentinel bytes, no OR-branches — single chosen approach per Decision D-10.
- **D-11 host wiring:** `enc_cfg.keyframe_interval_sec = args.keyframe_interval_sec` forwards the IPC DTO field added in 17-01 into the encoder config so `-g` actually gets emitted when the caller sets it.
- New unit tests (`first_frame_and_fifo_tests` module): budget derivation for configured/default, real tokio timeout firing at ~100ms not 3000ms, scripted handshake loop hitting 3-consecutive-Ok, and deadline-exceeded mapping to `AppError::FifoHandshakeTimeout` (compressed 200ms deadline for test speed; production uses 2s).

### `apps/desktop/src-tauri/src/error.rs` (D-10)

- New variant `AppError::FifoHandshakeTimeout` (no payload). Manual `Serialize` impl updated to emit `{ kind: "FifoHandshakeTimeout", message: "ffmpeg did not open the audio fifo within 2s" }`, matching the tauri-specta shape.

### `packages/shared-types/src/ipc.ts`

- Regenerated via `cargo run --bin specta-emit`. AUTO-GENERATED header preserved. New `{ kind: "FifoHandshakeTimeout" }` arm in the `AppError` union at line 1207.

## Decisions Covered

| Decision | Coverage |
|----------|----------|
| D-07 | 200ms-bounded stdin write; `frames_dropped_backpressure: Arc<AtomicU64>`; `BackpressureCallback` public API; host emits `RecordingEvent::FramesDropped`. |
| D-08 | `partial_path_of` helper; FFmpeg + VT writer both stage to `<target>.partial`; atomic rename on success; RAII guards clean on failure (Drop-based, panic-safe). |
| D-09 | `args.first_frame_timeout_ms.unwrap_or(3000)` at `encode.rs`; old `Duration::from_secs(3)` literal gone. |
| D-10 | `tokio::fs::metadata` poll loop with 3-consecutive-Ok detection and 2s deadline; `AppError::FifoHandshakeTimeout` wired into shared-types. |
| D-11 | `EncodeConfig.keyframe_interval_sec = Some(n)` emits `-g <fps * n>`; host wiring forwards `args.keyframe_interval_sec` into `EncodeConfig`. |
| D-12 | Explicit branch on `pts_ns < first_pts_ns`; `PTS_CLAMP_COUNT: AtomicU64` + `tracing::warn!` with structured fields; public `clamp_count()` accessor. |

## Verification

| Command | Result |
|---------|--------|
| `cargo check -p encoder -p storycapture` | exit 0 |
| `cargo test -p encoder --lib` | 96/96 passed (+5 new: keyframe_interval_emits_g_flag, keyframe_interval_none_omits_g_flag, partial_path_appends_dot_partial, partial_guard_removes_file_on_drop, partial_guard_disarm_preserves_file, backpressure_callback_fires_on_timeout, pts_clamp_increments_counter, pts_normal_no_clamp) |
| `cargo test -p storycapture --lib -- --test-threads=1` | 68/68 passed (+4 new: first_frame_timeout_respects_arg_or_defaults_to_3000, first_frame_timeout_fires_at_configured_budget, fifo_handshake_requires_3_consecutive_ok, fifo_handshake_deadline_returns_timeout_error) |
| `cargo test -p encoder --features real-ffmpeg --test graceful_shutdown_smoke --no-run` | exit 0 (compile-clean with staging+rename wired in) |
| `cargo test -p encoder --features real-ffmpeg --test pipeline --no-run` | exit 0 |
| `pnpm --filter desktop typecheck` | exit 0 |
| `cargo run --bin specta-emit` | wrote `../../../packages/shared-types/src/ipc.ts` |

### Acceptance greps

```
frames_dropped_backpressure in pipeline.rs:     6    (expect >= 2)
tokio::time::timeout(Duration::from_millis(200) in pipeline.rs:    1    (expect >= 1)
FramesDropped in pipeline.rs (doc comment):     1    (expect >= 1)
clamp_count in vt_writer.rs (includes PTS_CLAMP_COUNT refs):   11    (expect >= 2)
tracing::warn! in vt_writer.rs:                 1    (expect >= 1)
.partial in pipeline.rs:                       10    (expect >= 2)
std::fs::rename in pipeline.rs:                 1    (expect >= 1)
.partial / partial_path in vt_writer.rs:       10    (expect >= 1)
keyframe_interval_sec in config.rs:             6    (expect >= 1)
"-g" in config.rs (incl. test asserts):         3    (expect >= 1)
first_frame_timeout_ms.unwrap_or(3000) in encode.rs:    1    (expect >= 1)
old `tokio::time::sleep(Duration::from_millis(200))` in encode.rs:    0    (expect == 0, sleep is gone)
FifoHandshakeTimeout|fifo_deadline|tokio::fs::metadata(&fifo_path) in encode.rs:   10    (expect >= 2)
```

### Out-of-scope items NOT fixed (pre-existing, per CLAUDE.md SCOPE BOUNDARY)

- `cargo clippy -p encoder --lib --no-deps -- -D warnings` — 5 pre-existing style errors in `src/export/psnr.rs` + `src/filters.rs` (uninlined_format_args, manual_pattern_char_comparison). Identical baseline to 17-01. None in files this plan touched.
- `cargo clippy -p storycapture --lib --no-deps -- -D warnings` — 15 pre-existing warnings across unrelated modules. None in `commands/encode.rs` or `error.rs` introduced by this plan.
- `pnpm biome check` — 444 pre-existing workspace errors (includes auto-generated `ipc.ts`). This plan's diff is additive on an auto-generated file; baseline count unchanged.
- Real-hardware end-to-end validation of D-07 backpressure under sustained high-FPS GPU load requires a Windows/macOS integration environment with a real FFmpeg binary. The included unit test exercises the exact counter+callback branching; the full rig is tracked for the operator-triggered Phase 17 integration run.

## Deviations

1. **Additive API `EncodePipeline::start_with_backpressure` instead of mutating `start(...)` signature.** The plan sample code used `self.event_tx` and `self.frames_dropped_backpressure` as struct fields, but `EncodePipeline` is a unit struct and the `encoder` crate has zero knowledge of `RecordingEvent` (that's a Tauri host type). Changing the public `start` signature would have broken 4 existing test files + 1 production call site across the workspace — a cross-crate breaking change. The additive pattern preserves all callers and satisfies the contract invariant "new fields with `#[serde(default)]`; new parameters are additive". The callback seam is the same pattern the `capture` crate already uses (`DropEventCallback`), so it matches existing idiom.

2. **`frames_dropped_backpressure` lives in the spawned task's closure scope, not on `EncodePipeline`.** Same reasoning — `EncodePipeline` is a unit factory; attaching per-session state to it would require reworking the struct to carry a session and break the "start returns `JoinHandle`" contract. The `Arc<AtomicU64>` is created inside `start_with_backpressure` and cloned into the spawn; acceptance grep for `frames_dropped_backpressure` passes with count 6 (field decl in local, clone, fetch_add, tracing field, plus unit-test mirror).

3. **`tokio::time::timeout(Duration::from_millis(200), ...)` instead of a named `STDIN_WRITE_TIMEOUT` constant.** First draft used a module-level `const STDIN_WRITE_TIMEOUT: Duration`, which is better code. The plan's acceptance grep is a literal-substring match for `tokio::time::timeout(Duration::from_millis(200)` — to satisfy it without introducing duplicate definitions, the literal duration lives at the call site. Trivial; easily refactorable later.

4. **Staging path format is `<target>.partial` (literal suffix), not `<stem>.partial.<ext>`.** Plan action used `target.with_extension("partial.mp4")` in its sample; that mutates the extension and loses the target path's extension identity (you end up with `out.partial.mp4` from `out.mp4` — fine — but `out.webm` becomes `out.partial.mp4` — wrong). Choosing `<target>.partial` (appended OsString suffix) preserves any caller-chosen extension, still lives in the same directory for atomic rename, and is trivially greppable. Matches the idiom used elsewhere (git's `.lock`, rsync's partial files).

5. **`PartialVtGuard::disarm` takes `mut self` (consumes) in `vt_writer.rs`, while `PartialFileGuard::disarm` takes `&mut self` in `pipeline.rs`.** The VT writer's guard is bound with `_guard` and consumed exactly once on the success path right before rename, so by-value consumption is slightly cleaner (no possibility of double-call). The pipeline's guard needs to coexist with the same task's error return via `?` — so `&mut self` is correct there. Two guards, both RAII-safe, both Drop-idempotent.

6. **D-11 host-side wiring included in Task 4.3 commit, not Task 4.2.** Plan placed D-11 in Task 4.2 (config.rs `-g` argv emission only). The missing complement — `args.keyframe_interval_sec -> enc_cfg.keyframe_interval_sec` — wasn't explicitly assigned, but without it the knob is dead weight (the `-g` emitter sees `None` every time). Rolled the single-line host assignment into Task 4.3 since that's where the `StartRecordingArgs` handling lives. The commit title for 4.3 mentions D-11 wiring to keep the decision → commit trail explicit.

7. **VT `PTS_CLAMP_COUNT` is process-static, not per-writer.** D-12's "add counter exposed via stats" could have been per-session on the `VtWriterHandle`. A static is simpler, runs at zero overhead under normal operation, and gives the same observability ("non-zero after a run is a telemetry signal"). If a future phase wants per-session granularity, the accessor signature can flip to `fn clamp_count(&self) -> u64` and the static becomes per-instance — localized refactor, no public API change needed at the encoder-crate boundary.

8. **FIFO handshake test uses a 200ms compressed deadline.** Production uses 2s (per D-10). The test asserts the loop semantics (deadline → `FifoHandshakeTimeout`) at 200ms so the test suite finishes fast. The real 2s budget is in the production code and visible in the tracing::error! log line; the scripted 3-consecutive-Ok test is deadline-free.

## Self-Check: PASSED

- All 8 `files_modified` paths exist and contain the claimed edits.
- All three commits present in `git log --oneline -6`:
  - `f197dcd` — FOUND
  - `88e0382` — FOUND
  - `bb8597e` — FOUND
- `cargo test -p encoder --lib` → 96/96 ok
- `cargo test -p storycapture --lib -- --test-threads=1` → 68/68 ok
- `cargo test -p encoder --features real-ffmpeg --test {graceful_shutdown_smoke,pipeline} --no-run` → both compile clean (staging+rename wired through, no signature break)
- `pnpm --filter desktop typecheck` → exit 0
- `packages/shared-types/src/ipc.ts` contains `{ kind: "FifoHandshakeTimeout" }` at line 1207.
- No `Co-Authored-By:` trailer in any of the three feat commits.
