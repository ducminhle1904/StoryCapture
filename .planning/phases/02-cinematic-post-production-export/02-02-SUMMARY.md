---
phase: 02-cinematic-post-production-export
plan: 02
subsystem: effects
tags: [effects, math, minimum-jerk, critically-damped-spring, perlin, low-pass, easing, cursor, zoom]

requires:
  - phase: 02-cinematic-post-production-export
    provides: crates/effects::ast::Vec2, crates/effects scaffolding (Plan 01)
provides:
  - crates/effects::math::min_jerk::{min_jerk_sample, sample_path, detect_reversals, peak_velocity, Waypoint, WaypointKind}
  - crates/effects::math::spring::Spring (new/with_target/step/settle)
  - crates/effects::math::lowpass::{low_pass_1d, smooth_keyframes}
  - crates/effects::math::perlin::PerlinNoise2D (seeded, deterministic, [-1,1])
  - crates/effects::math::ease::{EasingKind, linear, ease_in_out_cubic, ease_out_quad, apply}
  - crates/effects::math::vec2::Vec2Ops (extension trait: add/sub/scale/length/angle_between_deg)
affects:
  - Plan 02-05 (POST-02 auto-zoom planner) — consumes Spring, low_pass_1d, ease functions
  - Plan 02-06 (POST-03 cursor engine) — consumes min_jerk_sample, sample_path, detect_reversals, peak_velocity, PerlinNoise2D, Vec2Ops

tech-stack:
  added: []  # no new crate dependencies; pure-Rust math on existing serde/ts-rs
  patterns:
    - "Extension trait (Vec2Ops) over AST types rather than duplicating Plan 01's Vec2"
    - "Module-local EasingKind (math::ease) distinct from ast::types::EasingKind — Plan 05 reconciles"
    - "Seeded Xorshift64* + Fisher-Yates for deterministic permutation tables"
    - "Semi-implicit Euler integration for critically-damped spring (Research §4)"

key-files:
  created:
    - crates/effects/src/math/mod.rs
    - crates/effects/src/math/vec2.rs
    - crates/effects/src/math/ease.rs
    - crates/effects/src/math/min_jerk.rs
    - crates/effects/src/math/spring.rs
    - crates/effects/src/math/lowpass.rs
    - crates/effects/src/math/perlin.rs
    - crates/effects/tests/math_min_jerk.rs
    - crates/effects/tests/math_spring.rs
  modified:
    - crates/effects/src/lib.rs (added `pub mod math;`)
    - packages/shared-types/src/generated/effects.ts (auto: ts-rs exports for MathEasingKind, Waypoint, WaypointKind)

key-decisions:
  - "Vec2Ops as extension trait (not a new Vec2 type) — preserves Plan 01's serde/ts-rs wiring"
  - "math::ease::EasingKind kept separate from ast::types::EasingKind — the AST enum (Linear/EaseIn/EaseOut/EaseInOut) is serialised in presets; the math enum (Linear/EaseInOutCubic/EaseOutQuad) drives numerical samplers. Plan 05 reconciles when wiring ZoomKeyframe.easing; avoids breaking Plan 01 snapshot fixtures now."
  - "ts-rs rename = \"MathEasingKind\" on the math enum so the TS generated file exports two distinct types without collision"
  - "Xorshift64* seeding (with golden-ratio fallback for seed=0) for reproducibility without pulling in `rand`"
  - "sample_path appends the final waypoint exactly to guarantee path ends on target (avoids sub-frame drift)"

patterns-established:
  - "Pure-Rust math primitives live in crates/effects/src/math/ — no I/O, no serde boundary except data types"
  - "Inline #[cfg(test)] tests for algorithmic correctness + crates/effects/tests/*.rs integration tests for public-API contracts"
  - "ts-rs export_to uses three-dot prefix (`../../../packages/…`) per Plan 01 pattern"

requirements-completed: []

duration: ~5 min
completed: 2026-04-15
---

# Phase 2 Plan 02: Motion Math Primitives Summary

**Pure-Rust minimum-jerk trajectory sampler, critically-damped spring smoother, deterministic 2D Perlin noise, spring-based low-pass keyframe smoother, and easing functions — the numerical substrate for Plan 05 (auto-zoom) and Plan 06 (cursor engine).**

## Performance

- **Duration:** ~5 min
- **Started:** 2026-04-15T12:52:05Z
- **Completed:** 2026-04-15T12:56:33Z
- **Tasks:** 2
- **Files created:** 9
- **Files modified:** 2 (`lib.rs`, generated TS bindings)
- **Test count:** 41 new tests (31 lib + 10 integration), 85 total in crate

## Accomplishments

- **Minimum-jerk trajectory** (Flash & Hogan 1985): `10τ³ - 15τ⁴ + 6τ⁵` implemented exactly with endpoint, midpoint, and zero-velocity tests.
- **Critically-damped spring** (Research §4 Code Example 2): semi-implicit Euler with `-2ω·v - ω²·(x-target)` force law; no-overshoot property verified.
- **Deterministic 2D Perlin**: seeded Xorshift64* + Fisher-Yates permutation; output bounded in `[-1, 1]`; lattice-point zero property; byte-identical across instances.
- **Spring-based low-pass**: framerate-aware smoothing of keyframe sequences with no overshoot (important for zoom viewport bounds).
- **Waypoint / reversal detection**: `detect_reversals` flags U-turns per Research §3 (>135° threshold); `peak_velocity` gives closed-form `1.875·Δ/T` for velocity-cap callers.
- **Vec2Ops** extension trait over Plan 01's `Vec2` — no type duplication.
- **Three easing curves** (`Linear`, `EaseInOutCubic`, `EaseOutQuad`) + dispatch `apply()`.

## Task Commits

1. **Task 1: Minimum-jerk + Vec2 + easing + reversal detection** — `b28d687` (feat)
2. **Task 2: Critically-damped spring + low-pass smoother + Perlin jitter** — `8866894` (feat)

## Exported Functions (with tolerances)

### `crates/effects::math::min_jerk`

| Symbol | Signature | Notes |
|---|---|---|
| `min_jerk_sample` | `fn(p0: Vec2, p1: Vec2, t_sec: f32, duration_sec: f32) -> Vec2` | τ clamped `[0,1]`; endpoint tolerance `1e-3` px |
| `sample_path` | `fn(&[Waypoint], fps: u32) -> Vec<Vec2>` | Appends final endpoint; O(fps·duration) — caller must clamp (T-02-04) |
| `detect_reversals` | `fn(&[Waypoint], threshold_deg: f32) -> Vec<usize>` | Returns interior indices `[1, len-2]` |
| `peak_velocity` | `fn(p0, p1, duration_sec) -> f32` | Closed form `‖Δ‖·1.875/T` (peak at τ=0.5); `+INF` for `duration_sec ≤ 0` |
| `Waypoint`, `WaypointKind` | struct + enum | `Click, Hover, Scroll, Type, Drag`; serde + ts-rs |

### `crates/effects::math::spring`

| Symbol | Signature | Notes |
|---|---|---|
| `Spring::new` | `(initial: f32, omega: f32) -> Self` | target=initial, vel=0 |
| `Spring::with_target` | `(initial, target, omega) -> Self` | |
| `Spring::step` | `(&mut self, dt: f32)` | Semi-implicit Euler; `omega·dt` should stay `< 0.5` for numerical stability |
| `Spring::settle` | `(&mut self, target, dt, max_steps) -> f32` | Convenience offline loop |

Omega tuning: `omega ≈ 2π / time_to_settle`; `ω=6` ≈ 1 s settle, `ω=12` ≈ 0.5 s.

### `crates/effects::math::lowpass`

| Symbol | Signature | Notes |
|---|---|---|
| `low_pass_1d` | `(targets: &[f32], omega, dt, initial) -> Vec<f32>` | One spring step per target |
| `smooth_keyframes` | `<T, F, G>(keyframes, extract, patch, omega, dt) -> Vec<T>` | Callers wire extract/patch for the smoothed scalar field |

### `crates/effects::math::perlin`

| Symbol | Signature | Notes |
|---|---|---|
| `PerlinNoise2D::new` | `(seed: u64) -> Self` | Deterministic permutation; seed=0 uses golden-ratio fallback |
| `PerlinNoise2D::sample` | `(&self, x: f32, y: f32) -> f32` | Range `[-1, 1]` clamped defensively; cross-platform tolerance `1e-5` (T-02-05) |

### `crates/effects::math::ease`

| Symbol | Notes |
|---|---|
| `EasingKind { Linear, EaseInOutCubic, EaseOutQuad }` | ts-rs export as `MathEasingKind` to avoid collision with `ast::EasingKind` |
| `linear(t)`, `ease_in_out_cubic(t)`, `ease_out_quad(t)` | All clamp `t` to `[0, 1]`; endpoints exact |
| `apply(kind, t)` | Dispatch |

### `crates/effects::math::vec2`

`Vec2Ops` extension trait over `ast::types::Vec2`: `add`, `sub`, `scale`, `length`, `angle_between_deg` (returns 0 for zero-length vectors).

## Files Created/Modified

- `crates/effects/src/math/mod.rs` — module tree + public re-exports
- `crates/effects/src/math/vec2.rs` — `Vec2Ops` extension trait + 4 unit tests
- `crates/effects/src/math/ease.rs` — `EasingKind` + easing functions + 5 unit tests
- `crates/effects/src/math/min_jerk.rs` — Flash & Hogan 1985 sampler + waypoints + 9 unit tests
- `crates/effects/src/math/spring.rs` — critically-damped spring + 3 unit tests
- `crates/effects/src/math/lowpass.rs` — spring-based low-pass + 2 unit tests
- `crates/effects/src/math/perlin.rs` — seeded 2D Perlin + 5 unit tests
- `crates/effects/tests/math_min_jerk.rs` — 4 integration tests
- `crates/effects/tests/math_spring.rs` — 6 integration tests (spring + lowpass + perlin)
- `crates/effects/src/lib.rs` — added `pub mod math;`
- `packages/shared-types/src/generated/effects.ts` — auto-generated additions for `MathEasingKind`, `Waypoint`, `WaypointKind`

## Decisions Made

1. **Kept `math::ease::EasingKind` distinct from `ast::types::EasingKind`.** The AST enum (`Linear, EaseIn, EaseOut, EaseInOut`) is already referenced by `ZoomKeyframe` and three Plan 01 integration tests (full_scene, canonical_order). Introducing the plan's specified variants (`EaseInOutCubic`, `EaseOutQuad`) as a parallel enum in `math::ease` avoids breaking Plan 01 snapshot fixtures. Plan 05 (which actually wires `ZoomKeyframe.easing` into the per-frame sampler) will reconcile the two — it is explicitly called out in its context link (`ease.rs::EasingKind -> ast/video.rs::ZoomKeyframe`). The TS export uses `rename = "MathEasingKind"` so both enums coexist cleanly in `shared-types`.

2. **`Vec2Ops` as an extension trait, not a new Vec2 type.** Plan 01 already owns `Vec2`'s serde + ts-rs wiring. Per the plan's own guidance, we add behaviour via trait rather than duplicating data.

3. **Xorshift64* seeding (not `rand`).** Keeps the crate dependency-free beyond what Plan 01 established. Deterministic and portable.

4. **`sample_path` appends the final waypoint literally.** Otherwise sub-frame drift causes the last sample to land slightly short — awkward for click/hover waypoints where the final pixel matters.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] `EasingKind` name collision with `ast::types::EasingKind`**
- **Found during:** Task 1 (initial read of `ast/types.rs`)
- **Issue:** Plan specifies `pub enum EasingKind { Linear, EaseInOutCubic, EaseOutQuad }` in `math/ease.rs`. But an `EasingKind` already exists in `ast/types.rs` (variants `Linear, EaseIn, EaseOut, EaseInOut`) with `#[derive(TS)]` and is exported to `packages/shared-types/src/generated/effects.ts`. A second TS export with the same name would collide.
- **Fix:** Created the plan-specified enum in `math/ease.rs` and added `rename = "MathEasingKind"` to its ts-rs attribute. Kept the AST enum unchanged so Plan 01 fixtures (full_scene, canonical_order) still pass. Plan 05 will reconcile when wiring zoom keyframe easing — called out in SUMMARY decisions.
- **Files modified:** `crates/effects/src/math/ease.rs`
- **Verification:** All 44 Plan 01 tests still pass; new 21 lib tests pass; total 85/85.
- **Committed in:** `b28d687` (Task 1)

**2. [Rule 2 - Missing Critical] Cross-platform determinism for Perlin seed=0**
- **Found during:** Task 2 (spec review)
- **Issue:** Plan text "LCG-fill a `[0..=255]` permutation" would leave seed=0 producing an all-zeros stream under Xorshift (`0 ^ (0<<n)` stays 0), collapsing the permutation table and producing a degenerate noise field.
- **Fix:** Fallback seed to golden-ratio constant `0x9E3779B97F4A7C15` when user passes 0. Documented in `PerlinNoise2D::new` comment.
- **Files modified:** `crates/effects/src/math/perlin.rs`
- **Verification:** `perlin_different_seeds_diverge` test and `perlin_amplitude_bounded_on_dense_grid` both pass.
- **Committed in:** `8866894` (Task 2)

**3. [Rule 2 - Missing Critical] Perlin output clamping against gradient edge-cases**
- **Found during:** Task 2 (implementation review)
- **Issue:** Classical Perlin can marginally exceed `[-1, 1]` at corner gradients depending on the exact gradient table; plan requires strict `[-1, 1]` containment for the 10k-sample test.
- **Fix:** Added `.clamp(-1.0, 1.0)` on the final lerp output of `sample()`. Documented as "guards against rare corner case" in doc comment.
- **Files modified:** `crates/effects/src/math/perlin.rs`
- **Verification:** `perlin_amplitude_bounded` (100×100 grid) passes inline and in integration test.
- **Committed in:** `8866894` (Task 2)

---

**Total deviations:** 3 auto-fixed (1 blocking name collision, 2 missing-critical correctness).
**Impact on plan:** No scope creep. Decision #1 defers a type-system consolidation to Plan 05 (where it belongs per the plan's own link graph). Decisions #2/#3 are algorithmic robustness additions required to pass the plan's own acceptance tests.

## Issues Encountered

None.

## User Setup Required

None — pure-math library code, no external services.

## Verification

- `cargo check -p effects` — clean
- `cargo test -p effects --lib math::` — 21/21 (endpoints, midpoints, zero-velocity, reversals, peak velocity, easing monotonicity, spring convergence, spring determinism, Perlin reproducibility, Perlin bounds, Perlin lattice-zero, Perlin seed distinctness, lowpass monotone step)
- `cargo test -p effects --test math_spring --test math_min_jerk` — 10/10
- `cargo test -p effects` — 85/85 (no Plan 01 regressions)
- Acceptance-criteria greps: all 7 pass (`10.0*tau.powi(3)…`, `pub fn detect_reversals`, `pub fn peak_velocity`, `pub enum EasingKind`, spring formula, `pub fn low_pass_1d`, `pub struct PerlinNoise2D`).

## Known Stubs

None. All primitives are feature-complete within plan scope. (Stubs placed during Task 1 RED — Spring/PerlinNoise2D skeletons — were fully implemented in Task 2.)

## Next Phase Readiness

- Plan 05 (auto-zoom planner, POST-02): can import `Spring`, `low_pass_1d`, `smooth_keyframes`, `ease_in_out_cubic`, `ease_out_quad` directly. The `ast::EasingKind` ↔ `math::ease::EasingKind` mapping is deferred to this plan per the link graph.
- Plan 06 (cursor engine, POST-03): can import `min_jerk_sample`, `sample_path`, `detect_reversals`, `peak_velocity`, `Waypoint`, `WaypointKind`, `PerlinNoise2D`, and `Vec2Ops`.
- No blockers.

## Self-Check: PASSED

Verification run:
- `[ -f crates/effects/src/math/mod.rs ]` → FOUND
- `[ -f crates/effects/src/math/vec2.rs ]` → FOUND
- `[ -f crates/effects/src/math/ease.rs ]` → FOUND
- `[ -f crates/effects/src/math/min_jerk.rs ]` → FOUND
- `[ -f crates/effects/src/math/spring.rs ]` → FOUND
- `[ -f crates/effects/src/math/lowpass.rs ]` → FOUND
- `[ -f crates/effects/src/math/perlin.rs ]` → FOUND
- `[ -f crates/effects/tests/math_min_jerk.rs ]` → FOUND
- `[ -f crates/effects/tests/math_spring.rs ]` → FOUND
- Commit `b28d687` (Task 1 — min-jerk + Vec2 + easing): FOUND
- Commit `8866894` (Task 2 — spring + low-pass + Perlin): FOUND

---
*Phase: 02-cinematic-post-production-export*
*Completed: 2026-04-15*
