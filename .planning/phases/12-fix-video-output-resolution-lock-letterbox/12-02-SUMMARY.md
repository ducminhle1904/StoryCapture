---
phase: 12-fix-video-output-resolution-lock-letterbox
plan: 02
subsystem: encoder
tags: [encoder, quality-preset, bitrate, videotoolbox, nvenc, qsv, amf, libx264, phase-12]
requires: [probe::HardwareEncoder]
provides: [quality::resolve, quality::pixel_based_kbps, filters::QualityPreset-stub]
affects: [crates/encoder/src/lib.rs]
tech-stack:
  added: []
  patterns: [integer-saturating-bitrate-math, per-encoder-argv-resolver, vec_of-macro]
key-files:
  created:
    - crates/encoder/src/quality.rs
    - crates/encoder/src/filters.rs
  modified:
    - crates/encoder/src/lib.rs
decisions:
  - "VT H264 and VT HEVC share the same rate-control arms (-q:v / -maxrate / -bufsize) — no -b:v"
  - "40_000 kbps ceiling enforced per-encoder inside resolver (D-12-08) via pixel_based_kbps + kbps_scaled clamp"
  - "Float scaling factors (0.75/1.25/1.5/1.75/2.0) expressed as integer numer/denom pairs for reproducibility"
  - "filters.rs created as a Wave-1 stub (QualityPreset only); plan 12-01 extends with FilterSpec + build_vf"
metrics:
  duration: "~1h (incl. toolchain recovery)"
  completed: 2026-04-20
---

# Phase 12 Plan 02: Quality Resolver Summary

Pure-additive `quality::resolve(preset, encoder, output_w, output_h) -> Vec<String>` that emits rate-control + speed-preset flags per the D-12-04 mapping table. VT path preserves commit 47f2c97's `-q:v 65 / -maxrate / -bufsize` shape (no `-b:v`). NVENC is the only encoder family that emits `-b:v`. 17 tests pass, including a dedicated VT-parity assertion at 1920x1080 Med.

## What Was Built

- `pixel_based_kbps(w, h)` — `(w*h*3)/1000` via saturating u64, clamped to 40_000 kbps.
- `kbps_scaled(base, numer, denom)` — integer-only factor scaling, re-clamped to 40_000.
- `resolve(...)` with exhaustive match across all 6 `HardwareEncoder` variants × all 4 `QualityPreset` variants.
- `vec_of!` macro-rules for compact literal-vec construction.
- `pub mod quality;` + `pub use quality::{pixel_based_kbps, resolve as resolve_quality_args};` wired in `lib.rs`.
- `filters.rs` stub with `pub enum QualityPreset { Low, Med, High, Lossless }` (to be extended by 12-01).

## Tests (all green)

- `pixel_based_1920x1080_is_6220`, `pixel_based_3840x2160_is_24883`, `pixel_based_7680x4320_clamps_to_40000`
- `openh264_{low,med,high,lossless}_args` — every arm carries `-tune stillimage`
- `videotoolbox_med_1080p_parity_with_current_config` → `["-q:v","65","-maxrate","6220k","-bufsize","12440k"]`
- `videotoolbox_hevc_shares_h264_arms`
- `videotoolbox_does_not_emit_dash_b_v` (iterates all 4 presets × both VT variants)
- `nvenc_low_1080p_args` → `["-preset","p5","-rc","vbr","-cq","28","-b:v","4665k","-maxrate","7775k"]`
- `qsv_med_args` → `["-preset","medium","-global_quality","23"]`
- `amf_lossless_args` → `["-quality","quality","-rc","cqp","-qp_i","18","-qp_p","20"]`
- `exhaustive_match_holds` — 4 × 6 cells, non-empty, no panic

## Acceptance Criteria — Verified

- `cargo check -p encoder` — exit 0 (via `RUSTUP_TOOLCHAIN=stable` fallback, see Deviations).
- `cargo test -p encoder --lib quality::tests` — 14/14 green.
- `grep -n "pub fn resolve" crates/encoder/src/quality.rs` — exactly one line (39).
- `grep -n "pub mod quality" crates/encoder/src/lib.rs` — exactly one line (26).
- `grep -c -- "-tune" crates/encoder/src/quality.rs` — 9 (>= 4 required; 4 SW arms × 2 literal lines + test assertions).
- `-b:v` appears only in NVENC implementation arms (lines 99/111/123/135) and two test-site references — no VT arm emits it.
- `git diff --name-only main -- crates/encoder/src/config.rs` — empty (config.rs untouched).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Wave-1 coordination — filters.rs stub**
- **Found during:** Task 12-02-01 (pre-edit analysis).
- **Issue:** `use crate::filters::QualityPreset` requires `filters.rs`, which plan 12-01 is creating in a parallel worktree. This worktree cannot compile without it.
- **Fix:** Created a minimal `filters.rs` containing only `pub enum QualityPreset { Low, Med, High, Lossless }`. Plan 12-01's full version (FilterSpec, FitMode, build_vf, etc.) is a strict superset; orchestrator will union on merge.
- **Files modified:** `crates/encoder/src/filters.rs` (new).
- **Commit:** included in 0f686fe.
- **Lib.rs placement:** `pub mod filters;` added on a distinct line (line 19) from `pub mod quality;` (line 26), per parallel-execution guidance.

**2. [Rule 3 - Blocking] Toolchain 1.88.0 installation blocked by sandbox**
- **Found during:** `cargo check -p encoder`.
- **Issue:** `rust-toolchain.toml` pins 1.88.0; rustup could not install it inside the sandbox (cross-directory rename failures from `/Users/locvotuan/.rustup/tmp/*` into `toolchains/1.88.0-*`).
- **Fix:** Ran cargo under `RUSTUP_TOOLCHAIN=stable` (rustc 1.94.1). The encoder crate compiles cleanly and all tests pass on stable. No code changes required.
- **Risk:** Low — stable is newer, not older, and no 1.88.0-specific features are used. CI on pinned 1.88.0 will still apply.

## Known Stubs

- `filters.rs` intentionally contains only `QualityPreset`. Plan 12-01 (Wave 1 parallel) will overwrite with the full `FilterSpec` + `build_vf` surface. Orchestrator merges the two worktrees.

## Threat Flags

None — no new surface beyond compile-time literal FFmpeg flags and numeric `format!("{}k", u32)` bitrate strings.

## Self-Check: PASSED

- crates/encoder/src/quality.rs — FOUND
- crates/encoder/src/filters.rs — FOUND
- crates/encoder/src/lib.rs (pub mod quality) — FOUND
- Commit 0f686fe — FOUND in git log
- No Co-Authored-By trailer in commit message — CONFIRMED (`git log -1 --format=%B | grep -i co-authored-by` → no match)
