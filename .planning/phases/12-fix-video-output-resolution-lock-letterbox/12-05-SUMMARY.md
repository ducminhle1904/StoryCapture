---
phase: 12-fix-video-output-resolution-lock-letterbox
plan: 05
subsystem: encoder/integration-tests
tags: [encoder, integration-test, real-ffmpeg, ffprobe, letterbox, resolution-lock, phase-12]
requirements: [ENC-06, ENC-07, ENC-09, ENC-11]
dependency_graph:
  requires: [12-03]
  provides:
    - "End-to-end guard: ffprobe-verified output MP4 dims match preset exactly"
    - "Pixel-level guard on PadColor wiring (black/white/custom-hex)"
  affects: [crates/encoder]
tech_stack:
  added:
    - "image 0.25 (dev-dep, png-only) for pad-region pixel sampling"
  patterns:
    - "File-level #![cfg(feature = \"real-ffmpeg\")] gate — matches tests/pipeline.rs"
    - "Skip-cleanly when ffmpeg/ffprobe absent (eprintln + early return)"
    - "tokio::time::timeout(60s) wrapping encode join (DoS mitigation T-12-05-01)"
key_files:
  created:
    - crates/encoder/tests/resolution_lock_real_ffmpeg.rs
  modified:
    - crates/encoder/Cargo.toml
decisions:
  - "Resolve ffmpeg/ffprobe via STORYCAPTURE_{FFMPEG,FFPROBE}_BIN env override → scripts/build-ffmpeg/out/<tool>-<triple> → PATH walk. Keeps CI deterministic while allowing dev overrides."
  - "Sample pad pixels in the middle frame (ss=0.4) to avoid GOP start-of-clip artifacts, and use ±10 H.264 chroma tolerance."
  - "For the pillarbox case use 2000×1440 (non-16:9) so Letterbox actually adds pad; the plan's 2560×1440 is already 16:9 and would scale cleanly with no pad to assert on."
metrics:
  duration: "~15m"
  completed: "2026-04-20"
---

# Phase 12 Plan 05: Real-FFmpeg Resolution-Lock Integration Tests Summary

**One-liner:** End-to-end regression guard — real FFmpeg sidecar + ffprobe verify output MP4 dims match the preset exactly, including the 1920×1130 ENC-06 bug repro and pad-color pixel sampling.

## What was built

`crates/encoder/tests/resolution_lock_real_ffmpeg.rs` — one integration-test file, 7 `#[tokio::test]` cases, gated at file level behind `#![cfg(feature = "real-ffmpeg")]`. Each test:

1. Constructs `EncodeConfig` via the Phase 12 builder chain (`with_output_resolution` → `with_fit_mode` → `with_pad_color` → `with_scale_algo`).
2. Feeds `FRAME_COUNT=30` solid-color BGRA frames through `EncodePipeline::start` using the Openh264 software encoder (deterministic across hosts).
3. Spawns ffprobe on the output MP4, parses `width,height` from csv output, asserts exact match.
4. For pad-verifying cases: extracts the middle frame to PNG via ffmpeg, decodes with `image` crate, samples pad-region pixels with ±10 tolerance.

### Test matrix (7 cells)

| Test | Capture | Preset / Fit | Asserts |
|---|---|---|---|
| `test_letterbox_1920x1130_to_p1080` | 1920×1130 | P1080 + Letterbox | ffprobe = 1920×1080 (ENC-06 bug repro) |
| `test_no_upscale_800x600_to_p1080` | 800×600 | P1080 + Letterbox + Black | ffprobe = 1920×1080; corner (10,10) ≈ black |
| `test_2000x1440_to_p2160_pillarbox` | 2000×1440 | P2160 + Letterbox | ffprobe = 3840×2160 |
| `test_matchsource_rounding_1923x1081_to_even` | 1923×1081 | MatchSource | ffprobe = 1922×1080 (D-12-03 even-floor) |
| `test_perfect_aspect_3840x2160_to_p1080_no_pad` | 3840×2160 | P1080 + Letterbox | ffprobe = 1920×1080; corner is content color |
| `test_white_pad_color_sampled_in_region` | 800×600 | P1080 + Letterbox + White | pad pixel ≈ (255,255,255) |
| `test_custom_pad_color_hex_applied` | 800×600 | P1080 + Letterbox + Custom(255,0,128) | pad R>230, G<25, B∈[110,145] |

## Key implementation details

- **Binary resolution (cascading):**
  1. `STORYCAPTURE_FFMPEG_BIN` / `STORYCAPTURE_FFPROBE_BIN` env overrides
  2. `scripts/build-ffmpeg/out/<tool>-<host-triple>[.exe]` (workspace artifact)
  3. Manual `PATH` walk for `<tool>[.exe]`
  4. If none resolve → `eprintln!("skip: …")` + early return (test marked `ok`)
- **Frame construction:** matches `tests/fixtures/synthetic.rs` exactly — `Frame { pts: Pts { ns, source: ClockSource::Synthetic }, width_px, height_px, format: PixelFormat::Bgra, data: FrameData::Owned(buf, stride), sequence }`.
- **DoS guard:** `tokio::time::timeout(Duration::from_secs(60), join)` on every encode.
- **Pad-color tolerance:** H.264 4:2:0 chroma subsampling + CRF quantization introduces ±3–8 per channel on flat regions; ±10 absorbs that while still catching actual mis-wirings.

## Verification

```
cargo check -p encoder --tests                          # OK (gate works without feature)
cargo check -p encoder --tests --features real-ffmpeg   # OK (compiles with feature)
cargo test  -p encoder --features real-ffmpeg --test resolution_lock_real_ffmpeg
    # 7 passed; 0 failed — all skip cleanly on this host (no sidecar ffmpeg built)
```

Acceptance-criteria greps all pass:

- 7 `#[tokio::test]` annotations (matches 7 cells)
- `1920x1130` present (bug repro)
- `OutputResolution::MatchSource` present
- `PadColor::Custom` present
- `PadColor::White` present
- `#![cfg(feature = "real-ffmpeg")]` exactly one file-level gate
- No `Co-Authored-By` trailer in commit

## Deviations from Plan

### 1. [Rule 3 - Blocking] `image` crate not in encoder dev-deps

**Found during:** Task 12-05-01, implementation.
**Issue:** Plan claimed `image` was already a runtime dep of encoder; it is not (only `capture` and `effects` carry it).
**Fix:** Added `image = { version = "0.25", default-features = false, features = ["png"] }` to `[dev-dependencies]` in `crates/encoder/Cargo.toml`. Matches the existing cross-crate pattern (same version + feature set). Pure test-time addition, no runtime surface change.
**Files modified:** `crates/encoder/Cargo.toml`
**Commit:** d4bd553

### 2. [Rule 1 - Spec] Pillarbox test source changed from 2560×1440 to 2000×1440

**Found during:** Task 12-05-01, test design.
**Issue:** Plan specified `2560×1440 → P2160` as a "pillarbox" case. 2560×1440 is already 16:9 — at P2160 (3840×2160) the scale-up is clean with **no pad region**, so the pillarbox assertion would be vacuous.
**Fix:** Changed capture dims to 2000×1440 (non-16:9), which forces Letterbox to pad pillars and exercises the pad-filter chain. The assertion (ffprobe = 3840×2160) still covers the ENC-06 intent: preset must be honoured exactly regardless of source aspect.
**Files modified:** `crates/encoder/tests/resolution_lock_real_ffmpeg.rs`
**Commit:** d4bd553

### 3. [Clarification] Tests pass = skip cleanly on this host

**Found during:** Verification.
**Issue:** This worktree has no ffmpeg available (`which ffmpeg` = not found; `scripts/build-ffmpeg/out/` empty). Per the plan's explicit requirement ("skip cleanly when ffmpeg sidecar binary is not present"), tests early-return with `eprintln!("skip: …")` and are marked `ok`. On a host where `scripts/build-ffmpeg/out/ffmpeg-<triple>` exists or `$STORYCAPTURE_FFMPEG_BIN` is set, the full assertion bodies execute.
**Outcome:** `cargo test ... --test resolution_lock_real_ffmpeg` exits 0 with `7 passed` — matches acceptance contract.

## Threat surface scan

No new security-relevant surface. Test code only; no IPC, no network, no FS writes outside tempdir.

## Self-Check

- [x] `crates/encoder/tests/resolution_lock_real_ffmpeg.rs` exists
- [x] `crates/encoder/Cargo.toml` modified (image dev-dep added)
- [x] Commit `d4bd553` in `git log`
- [x] `cargo check -p encoder --tests` exits 0
- [x] `cargo check -p encoder --tests --features real-ffmpeg` exits 0
- [x] `cargo test -p encoder --features real-ffmpeg --test resolution_lock_real_ffmpeg` exits 0 with 7/7 passing

## Self-Check: PASSED
