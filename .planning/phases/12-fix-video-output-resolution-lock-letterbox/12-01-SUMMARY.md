---
phase: 12
plan: 01
subsystem: encoder
tags: [encoder, ffmpeg, filters, letterbox, phase-12]
requires: []
provides:
  - "encoder::filters module"
  - "FilterSpec, FitMode, ScaleAlgo, PadColor, OutputResolution, QualityPreset"
  - "build_vf(&FilterSpec) -> Result<String>"
  - "EncoderError::InvalidFilterSpec variant"
affects:
  - crates/encoder/src/error.rs
  - crates/encoder/src/lib.rs
  - crates/encoder/Cargo.toml
tech-stack:
  added:
    - "insta dev-dependency (yaml feature) on encoder crate"
  patterns:
    - "Pure-additive module; zero edits to crates/encoder/src/config.rs"
    - "Insta snapshot tests lock canonical FFmpeg filter strings"
key-files:
  created:
    - crates/encoder/src/filters.rs
    - crates/encoder/src/snapshots/encoder__filters__tests__snapshot_letterbox_1920x1130_to_p1080_black_lanczos.snap
    - crates/encoder/src/snapshots/encoder__filters__tests__snapshot_letterbox_800x600_to_p1080_black_lanczos.snap
    - crates/encoder/src/snapshots/encoder__filters__tests__snapshot_letterbox_3840x2160_to_p1080_white_bicubic.snap
    - crates/encoder/src/snapshots/encoder__filters__tests__snapshot_letterbox_2560x1440_to_p2160_black_lanczos.snap
    - crates/encoder/src/snapshots/encoder__filters__tests__snapshot_letterbox_1920x1080_to_p1080_passthrough.snap
    - crates/encoder/src/snapshots/encoder__filters__tests__snapshot_letterbox_matchsource_1920x1080_passthrough.snap
    - crates/encoder/src/snapshots/encoder__filters__tests__snapshot_letterbox_matchsource_1923x1081_rounds_to_1922x1080.snap
    - crates/encoder/src/snapshots/encoder__filters__tests__snapshot_fillcrop_1920x1080_to_p720_black_lanczos.snap
    - crates/encoder/src/snapshots/encoder__filters__tests__snapshot_stretch_1920x1080_to_p720_black_bilinear.snap
    - crates/encoder/src/snapshots/encoder__filters__tests__snapshot_padcolor_custom_lowercase_hex.snap
  modified:
    - crates/encoder/src/error.rs
    - crates/encoder/src/lib.rs
    - crates/encoder/Cargo.toml
    - Cargo.lock
decisions:
  - "Implement shell-injection resistance via u8-typed PadColor::Custom fields — the rendered hex is always 0x + 6 ascii-lowercase hex chars, no shell-metachar path exists."
  - "Degenerate Letterbox (capture == output) returns `format=yuv420p` fast-path shared with MatchSource passthrough — guarantees byte-identical snapshots for both entry points."
  - "config.rs intentionally left untouched (plan is pure-additive); Plan 12-03 will refactor existing call sites."
metrics:
  duration: "~25 minutes (excluding rustup toolchain repair)"
  completed: 2026-04-20
---

# Phase 12 Plan 01: Letterbox filter module Summary

One-liner: Pure-additive `encoder::filters` module with `build_vf()` emitting canonical FFmpeg Letterbox / FillCrop / Stretch chains, plus MatchSource passthrough and u8-typed injection-resistant PadColor — all locked by 10 insta snapshots.

## What Shipped

- New module `crates/encoder/src/filters.rs` (~380 lines) providing the Phase 12 foundation enums (`FitMode`, `ScaleAlgo`, `PadColor`, `OutputResolution`, `QualityPreset`) and the `FilterSpec` struct per D-12-01..D-12-07.
- `build_vf(&FilterSpec) -> Result<String>` emitter producing:
  - **Letterbox (canonical):** `scale=W:H:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=<algo>,pad=W:H:(ow-iw)/2:(oh-ih)/2:color=<c>,setsar=1,format=yuv420p`
  - **FillCrop:** `scale=W:H:force_original_aspect_ratio=increase:flags=<algo>,crop=W:H,setsar=1,format=yuv420p`
  - **Stretch:** `scale=W:H:flags=<algo>,setsar=1,format=yuv420p`
  - **MatchSource / degenerate Letterbox:** `format=yuv420p` (fast-path)
- `EncoderError::InvalidFilterSpec(String)` added to the encoder error taxonomy; validates capture/output non-zero, output even, Custom range 16..=7680 × 16..=4320.
- `OutputResolution::resolve_even()` maps named presets to dims and rounds odd capture dims to even via `n & !1` for MatchSource (e.g. 1923×1081 → 1922×1080).
- `PadColor` renders `Black`/`White` as literals and `Custom{r,g,b}` as lowercase `0xRRGGBB` — the `u8` bound on fields makes shell-metacharacter injection impossible (asserted by 5×5×5 exhaustive property-style test).
- 10 insta snapshots lock the canonical filter strings (filter order, flag names, setsar-after-pad invariant L-06).

## Deviations from Plan

None — plan executed exactly as written. The only non-code hiccup was a local rustup toolchain corruption that required clearing xattrs on `~/.rustup/downloads/` before 1.88.0 would install; this was environment repair, not a code deviation.

## Key Links Provided (for downstream plans)

| From | To | Via |
|------|----|----|
| `crates/encoder/src/filters.rs` | `crates/encoder/src/error.rs` | `EncoderError::InvalidFilterSpec` |
| Plan 12-02 (QualityResolver) | this module | `ScaleAlgo`, `QualityPreset` enums |
| Plan 12-03 (EncodeConfig refactor) | this module | `FilterSpec`, `OutputResolution`, `FitMode`, `PadColor`, `build_vf` |

## Verification

- `cargo check -p encoder` — PASS (43.34s clean build with insta added).
- `cargo test -p encoder --lib filters::tests` — 17/17 PASS.
- `grep -n "pub fn build_vf" crates/encoder/src/filters.rs` — exactly 1 match (line 118).
- `grep -n "pub mod filters" crates/encoder/src/lib.rs` — exactly 1 match.
- `grep -n "pub use filters::" crates/encoder/src/lib.rs` — re-exports `build_vf, FilterSpec, FitMode, OutputResolution, PadColor, QualityPreset, ScaleAlgo`.
- `grep -n "InvalidFilterSpec" crates/encoder/src/error.rs` — matches the new variant.
- Canonical Letterbox string present in `encoder__filters__tests__snapshot_letterbox_1920x1130_to_p1080_black_lanczos.snap`: `scale=1920:1080:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,format=yuv420p`.
- Both passthrough snapshots (`snapshot_letterbox_1920x1080_to_p1080_passthrough`, `snapshot_letterbox_matchsource_1920x1080_passthrough`) contain the byte-identical single line `format=yuv420p`.
- Every snapshot (10/10) contains `format=yuv420p` — enforced by grep count.
- `git diff --stat crates/encoder/src/config.rs` is empty — plan is additive-only against config.rs.
- `git log -1 --format=%B | grep -i "co-authored-by" | wc -l` returns `0` — no AI attribution trailers.

## Commits

- `cd41529` — feat(12-01): add filters module with FilterSpec + build_vf letterbox emitter

## Self-Check: PASSED

- [x] `crates/encoder/src/filters.rs` exists
- [x] `crates/encoder/src/error.rs` has `InvalidFilterSpec`
- [x] `crates/encoder/src/lib.rs` has `pub mod filters` + re-exports
- [x] `crates/encoder/Cargo.toml` has insta dev-dep
- [x] 10 snapshot files under `crates/encoder/src/snapshots/`
- [x] Commit `cd41529` in `git log`
- [x] No `Co-Authored-By` trailer in commit message
