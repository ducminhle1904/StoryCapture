---
phase: 260418-gkg
type: quick
status: complete
date: 2026-04-18
---

# Quick Task 260418-gkg — Summary

Recording engine quick fixes: three independent, atomically-committable fixes landed on `main`.

## Commits

| SHA       | Message |
|-----------|---------|
| `960dee8` | `fix(recording): drop stale 'Chromium' Playwright sentinel in start_recording` |
| `830e6d0` | `fix(encoder): close ffmpeg stdin via RAII guard on unwind/early-return` |
| `1fe6fe8` | `feat(recording): emit per-session FramesDropped telemetry to UI` |

Based on `7f879fb`. Fast-forward merged from worktree `worktree-agent-a8c6e0d4`.

## Files changed (net)

```
 apps/desktop/src-tauri/src/commands/encode.rs | 28 ++++++++++++-
 crates/capture/src/lib.rs                     |  2 +-
 crates/capture/src/pipeline.rs                | 58 ++++++++++++++++++++++++++-
 crates/capture/tests/pipeline.rs              |  4 +-
 crates/capture/tests/soak.rs                  |  2 +-
 crates/encoder/src/pipeline.rs                | 48 ++++++++++++++++++++--
 6 files changed, 132 insertions(+), 10 deletions(-)
```

## Fix-level notes

### 1 — Drop stale "Chromium" sentinel (`960dee8`)
Removed the `Some("Chromium")` arm from the Playwright-sentinel match in `start_recording`. Only `"storycapture-playwright"` now triggers the PID-stash lookup. Aligns with commit `f899d6a` which had already dropped the hint from `resolve_playwright_target`. Users recording a real Chromium-titled window are no longer misrouted.

### 2 — RAII stdin guard (`830e6d0`)
Introduced a `StdinGuard` owning `ChildStdin` inside the encoder frame-pump task. `Drop` closes the pipe on every exit path: normal completion, `Err(EncoderError::Io(...))` early-return, and panic unwind. FFmpeg now sees EOF deterministically instead of waiting out the ~15 s `SHUTDOWN_TIMEOUT`. Existing normal-path "frame channel closed; signaling FFmpeg EOF" tracing ordering preserved (explicit `take` before `child.wait`). Panic propagation unchanged (no `catch_unwind`).

### 3 — `FramesDropped` telemetry (`1fe6fe8`)
- Added `RecordingEvent::FramesDropped { total: u64, delta: u64 }` — additive variant, matching existing serde/specta derives.
- `CapturePipeline::start` now takes an optional `Box<dyn Fn(u64, u64) + Send + Sync>` drop-event callback (object-safe, additive). All existing callers pass `None`.
- A 500 ms ticker task polls `QueueStats.dropped_frames`, fires the callback only when `delta >= 1`, and exits on a oneshot cancel fired by `CapturePipeline::stop`.
- `start_recording` wires the callback to the existing `on_event: Channel<RecordingEvent>` (Arc'd where Channel wasn't Clone). Sends are best-effort; failures logged at `debug` and ignored — capture never blocks.

## Verification run in worktree

- `cargo build --workspace` — green
- `cargo test -p encoder` — green
- `cargo test -p capture` — green
- No new clippy warnings
- Zero `Co-Authored-By` trailers

## Deviations (environment-only, no code impact)

1. Plan referenced Cargo package `storycapture-desktop`; actual name is `storycapture`. Used correct name for verification commands.
2. Worktree's gitignored sidecar binaries (`ffmpeg-*`, `playwright-sidecar-*`) had to be symlinked from main checkout so `build.rs` could resolve `resource path`. No tracked files affected.

## Follow-ups / deferred

Still open from the original audit (tracked separately — not in scope for this quick task):

- GPU-side downscale to 1920 wide (Metal / D3D11 compute) instead of libswscale — phase-sized.
- Cursor overlay in live capture pipeline (currently post-only).
- `SessionActor` ↔ recorder-command wiring so DSL stop propagates to `stop_recording`.

UI side also needs a toast/badge handler for the new `FramesDropped` event — not wired in frontend yet; desktop side only.
