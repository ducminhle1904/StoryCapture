---
phase: 12
plan: 03
subsystem: encoder
tags: [encoder, encode-config, letterbox, bitrate-target, call-sites, phase-12]
requires: [12-01, 12-02]
provides:
  - "EncodeConfig with capture_* / output_* dim split"
  - "fit_mode, pad_color, scale_algo, quality_preset fields on EncodeConfig"
  - "with_output_resolution / with_auto_bitrate / with_fit_mode / with_pad_color / with_scale_algo / with_quality_preset builders"
  - "to_ffmpeg_args delegating -vf to filters::build_vf and rate-control to quality::resolve"
  - "bitrate_kbps semantics flipped from floor -> target"
  - "Phase 12 default Letterbox + P1080 + Med applied in start_recording"
affects:
  - crates/encoder/src/config.rs
  - crates/encoder/src/macos/vt_writer.rs
  - apps/desktop/src-tauri/src/commands/encode.rs
tech-stack:
  added: []
  patterns:
    - "Builder methods return Self / Result<Self>"
    - "Native VT fast-path reads capture_* and maps bitrate=0 to pixel_based_kbps"
    - "-s always carries capture dims; -vf carries output dims; -b:v emitted only by NVENC"
key-files:
  created:
    - .planning/phases/12-fix-video-output-resolution-lock-letterbox/12-03-SUMMARY.md
  modified:
    - crates/encoder/src/config.rs
    - crates/encoder/src/macos/vt_writer.rs
    - apps/desktop/src-tauri/src/commands/encode.rs
decisions:
  - "bitrate_kbps=0 means preset-driven; reserved for Phase 13 manual override"
  - "VT writer fast-path maps bitrate=0 to pixel_based_kbps(capture_w, capture_h) so AVAssetWriter gets a sane target"
  - "Default output dims = capture dims (even-floored) so callers skipping with_output_resolution still get valid -s / -vf pair"
  - "Removed #[deprecated] shim path per L-09; no backwards-compat aliases"
metrics:
  duration: "~40 minutes"
  completed: 2026-04-20
---

# Phase 12 Plan 03: EncodeConfig Refactor (Letterbox Switch-Flip) Summary

One-liner: Refactor `EncodeConfig` to split `capture_width/height` (rawvideo `-s`) from `output_width/height` (filter target), delegate `-vf` to `filters::build_vf` and rate-control to `quality::resolve`, flip `bitrate_kbps` from floor→target, and wire Phase 12 defaults (P1080 + Letterbox + Black + Lanczos + Med) into `start_recording`.

## What Shipped

- `EncodeConfig` new fields: `capture_width`, `capture_height`, `output_width`, `output_height`, `fit_mode`, `pad_color`, `scale_algo`, `quality_preset`. `width`/`height` removed.
- `EncodeConfig::new(output_path, capture_w, capture_h, fps, encoder)` sets capture dims from args, output dims = even-floor(capture dims), fit=Letterbox, pad=Black, algo=Lanczos, preset=Med, bitrate=0.
- Builders: `with_output_resolution(preset) -> Result<Self>`, `with_fit_mode`, `with_pad_color`, `with_scale_algo`, `with_quality_preset`, `with_auto_bitrate`.
- `validate()` now rejects zero capture dims, zero output dims, and odd output dims (in addition to fps / path checks).
- `to_ffmpeg_args()` rewritten to delegate:
  - `-s` emits capture dims (`{capture_width}x{capture_height}`).
  - `-vf` calls `filters::build_vf(&FilterSpec{...})`.
  - Rate-control flags come from `quality::resolve(preset, encoder, output_w, output_h)` — no hand-rolled `-b:v`, `-q:v`, `-maxrate`, `-bufsize` left.
  - `-pix_fmt yuv420p` after `-c:v` retained (defense-in-depth per RESEARCH L-07).
  - Audio mapping / framing / `-progress pipe:2` / `+faststart` / `-shortest` preserved byte-identical.
- `bitrate_kbps` semantics: now a manual target override (0 = preset-driven). Closes tech-debt `06-CLEANUP-BACKLOG.md:99`.
- macOS `VtWriter` fast-path (bypasses filter graph) now reads `cfg.capture_width/height` and maps `bitrate_kbps == 0` to `quality::pixel_based_kbps(capture_w, capture_h)` so AVAssetWriter gets a sane average bitrate.
- `apps/desktop/src-tauri/src/commands/encode.rs::start_recording` constructs `EncodeConfig` with `with_output_resolution(P1080) → with_fit_mode(Letterbox) → with_pad_color(Black) → with_scale_algo(Lanczos) → with_quality_preset(Med) → force_ffmpeg_path()`. Import block extended with `FitMode, OutputResolution, PadColor, QualityPreset, ScaleAlgo`.

## Tests

`cargo test -p encoder --lib` → **88 passed, 0 failed**.

New / flipped config tests:
- `test_4k_uses_target_bitrate` — asserts `with_auto_bitrate()` on P2160 yields 24_883 kbps, and libopenh264 Med emits `-crf 23 / -tune stillimage` and **no** `-b:v`.
- `test_letterbox_vf_wired` — 1920×1130 → P1080 emits `-vf` containing `force_original_aspect_ratio=decrease`, `pad=1920:1080`, `setsar=1`.
- `test_output_dims_differ_from_capture_in_minus_s` — 1920×1130 capture + P1080 output → `-s 1920x1130` (capture dims).
- `test_validate_rejects_odd_output_dims` — odd output width triggers `EncoderError::InvalidConfig`.
- `ffmpeg_args_contain_required_flags` updated: `-s 1280x720`, `anullsrc`, `libopenh264`, `-progress pipe:2`, `-fps_mode cfr`, `+faststart`, `-pix_fmt bgra`, `-f rawvideo`, `pipe:0`.
- `validate_rejects_zero_dims` updated to set `capture_width = 0`.

Deleted: `test_4k_exceeds_floor` (floor semantics eliminated).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 — Missing critical] VT writer native fast-path bitrate=0 handling**
- **Found during:** Task 12-03-01 field-rename sweep.
- **Issue:** `crates/encoder/src/macos/vt_writer.rs` reads `cfg.bitrate_kbps` and `cfg.width/height` directly. With the new default `bitrate_kbps = 0`, AVAssetWriter would receive `AVVideoAverageBitRateKey = 0` and either reject or produce garbage. The plan only specified updating `pipeline.rs`/`vt_writer_macos.rs` *tests* but missed the `vt_writer.rs` source itself.
- **Fix:** Renamed `cfg.width → cfg.capture_width`, `cfg.height → cfg.capture_height`, and added a `bitrate_kbps == 0` branch that maps to `crate::quality::pixel_based_kbps(capture_w, capture_h)`. VT writer is a native fast-path that encodes at capture dims (no filter graph), so capture dims are the correct axis for bitrate derivation.
- **Files modified:** `crates/encoder/src/macos/vt_writer.rs`.
- **Commit:** included in b9470ab.

### Files Removed from `files_modified`
- `crates/encoder/tests/pipeline.rs` — positional `EncodeConfig::new(path, w, h, fps, encoder)` signature unchanged; the test constructs but never reaches into renamed fields. `cargo check` passed with zero edits.
- `crates/encoder/tests/vt_writer_macos.rs` — same: the two `EncodeConfig::new(...)` sites still compile; the test never touches renamed fields.
- `crates/encoder/src/lib.rs` — the re-exports already added by Plan 12-01 / 12-02 cover everything this plan needed (`FilterSpec, FitMode, OutputResolution, PadColor, QualityPreset, ScaleAlgo, build_vf`, `pixel_based_kbps`, `resolve`).

Final `files_modified`: `config.rs`, `vt_writer.rs`, `encode.rs` — matches `git diff --name-only HEAD~1 HEAD`.

### Files Added Beyond `files_modified`
- `crates/encoder/src/macos/vt_writer.rs` — added per Rule 2 above (not in the original plan frontmatter's `files_modified`).

## Acceptance Criteria — Verified

- `cargo check -p encoder --all-targets` → clean, 0 errors.
- `cargo check -p encoder -p capture -p storage -p effects --all-targets` → clean (only unrelated pre-existing warnings).
- `cargo check -p storycapture` → clean (required stub `binaries/` files which are a pre-existing packaging requirement — reverted after verification).
- `cargo test -p encoder --lib` → **88 passed, 0 failed, 0 ignored**.
- `grep "pub struct EncodeConfig" -A 20 crates/encoder/src/config.rs` shows all required fields (`capture_width`, `capture_height`, `output_width`, `output_height`, `fit_mode`, `pad_color`, `scale_algo`, `quality_preset`).
- `grep "scale='min(1920,iw)':-2" crates/encoder/` → 0 matches (old filter eliminated).
- `grep "target_kbps = pixel_based_kbps.max" crates/encoder/` → 0 matches (old floor formula eliminated).
- `grep "filters::build_vf" crates/encoder/src/config.rs` → 2 (one `use` path, one call).
- `grep "quality::resolve" crates/encoder/src/config.rs` → 2 (one `use` stmt, one call).
- `grep "test_4k_exceeds_floor" crates/encoder/src/config.rs` → 0 (deleted).
- `grep "test_4k_uses_target_bitrate" crates/encoder/src/config.rs` → 1.
- `grep "OutputResolution::P1080" apps/desktop/src-tauri/src/commands/encode.rs` → 1.
- `grep "FitMode::Letterbox" apps/desktop/src-tauri/src/commands/encode.rs` → 1.
- `git log -1 --format=%B | grep -i "co-authored-by"` → empty.

## Known Stubs

None.

## Threat Flags

None. No new surface beyond compile-time literal FFmpeg flags; capture dims are already trust-bounded at the capture crate.

## Commits

- `b9470ab` — refactor(12-03): split capture/output dims, delegate -vf + RC, fix bitrate-floor tech-debt

## Self-Check: PASSED

- [x] `crates/encoder/src/config.rs` modified (new field shape + delegating to_ffmpeg_args)
- [x] `crates/encoder/src/macos/vt_writer.rs` modified (renamed fields + bitrate=0 handling)
- [x] `apps/desktop/src-tauri/src/commands/encode.rs` modified (Phase 12 defaults)
- [x] Commit `b9470ab` present in `git log`
- [x] No `Co-Authored-By` trailer in commit
- [x] 88/88 encoder lib tests pass
