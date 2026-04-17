# Phase 5 Deferred Items

Pre-existing issues discovered during Plan 05-03 execution that are OUT OF
SCOPE for this plan's changes (per the executor scope boundary rule).

## 1. macOS clippy unnecessary-cast warnings — 05-01 sck_backend.rs

File: `crates/capture/src/macos/sck_backend.rs` lines 163–164

```
let width = disp.width() as u32;
let height = disp.height() as u32;
```

`SCDisplay::width()` already returns `u32`; the `as u32` is redundant.
`cargo clippy -p capture -- -D warnings` fails on macOS because of this.
Landed in Plan 05-01 commit `779514c`.

**Why deferred:** Not related to Plan 05-03's Windows work; would pollute
05-03's macOS surface-area. Plan 05-03's CI gate uses
`--target x86_64-pc-windows-msvc`, so this does not block the new workflow.

**Fix (one-line):** drop the `as u32` casts on both lines.

## 2. tauri-build requires `binaries/ffmpeg-<triple>` on desktop app builds

Pre-existing: `cargo check -p storycapture` (and downstream full desktop
build) fails with `resource path 'binaries/ffmpeg-aarch64-apple-darwin'
doesn't exist` when the developer hasn't run the FFmpeg sidecar bootstrap.

**Why deferred:** Unrelated build-infra item; 05-03 only verifies the
capture crate cross-compile + the new IPC wiring in `commands/capture.rs`
(which compiles cleanly under `cargo check -p capture`). A desktop-app
compile requires the operator to drop the FFmpeg sidecar into place —
documented in Phase 1.
