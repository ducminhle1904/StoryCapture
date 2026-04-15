---
phase: 02-cinematic-post-production-export
plan: 06
subsystem: effects
tags: [effects, cursor, minimum-jerk, perlin-jitter, click-ripple, png-sequence, ffmpeg-overlay, skins, POST-03]

requires:
  - phase: 02-cinematic-post-production-export
    provides: "crates/effects AST (Plan 01), math primitives (Plan 02) — min_jerk_sample, peak_velocity, detect_reversals, PerlinNoise2D, Vec2Ops, Waypoint/WaypointKind; Plan 05 waypoint pipeline (WaypointSource)"
provides:
  - crates/effects::cursor::trajectory::{sample_trajectory, CursorSample, TrajectoryOptions}
  - crates/effects::cursor::ripple::{build_ripples, ripple_alpha, ripple_radius, RippleOptions}
  - crates/effects::cursor::skins::{load_skin, apply_tint, resize, SkinBitmap, skin_path}
  - crates/effects::cursor::compositor::compose_frame
  - crates/effects::cursor::png_sequence::{render_png_sequence, PngSequenceResult}
  - assets/cursor-skins/{mac-default, win-default, dark, light, big-arrow}.png (5 bundled skins)
  - assets/cursor-skins/README.md
  - crates/effects/examples/generate_cursor_skins.rs (one-shot skin generator)
  - Updated FFmpeg emitter: CursorOverlay → `overlay=eof_action=pass:x=0:y=0`, RippleOverlay → `null` passthrough (ripples baked into cursor PNG sequence)
  - Updated Preview emitter populates `PreviewRenderPlan.cursor_atlas_ref` + `ripples` (already in place from Plan 01 — re-verified here)
  - crates/effects/tests/fixtures/cursor_overlay.filter_complex.snap (insta golden for 3-click / 1-cursor reference graph)
  - crates/effects/tests/canonical_order_full_stage.rs (connectivity validator)
affects:
  - Plan 02-11+ (renderer integration) — must wire `-framerate {fps} -i {trajectory_dir}/frame_%05d.png` as a second input and clean up the temp dir after encode (T-02-16)
  - Plan 02-12 (WebGPU preview compositor) — consumes `PreviewRenderPlan.ripples` + `cursor_atlas_ref`
  - `full_scene.filter_complex.snap` re-accepted (RippleOverlay drawbox → null, cursor overlay arg order fixed — both pre-flagged as Plan 01 Known Stubs)

tech-stack:
  added:
    - image = "0.25" (default-features = false, features = ["png"]) — RGBA compositing + PNG encode
    - rayon = "1" — parallel per-frame compositing
    - tempfile = "3" (dev-dep) — test isolation for PNG sequence runs
  patterns:
    - "Cursor hotspot = top-left corner of the skin PNG; compositor blits directly at sample.pos without a hotspot offset table"
    - "Ripples are baked into the cursor PNG sequence by compose_frame; the RippleOverlay AST node degrades to a `null` passthrough in FFmpeg but still survives into PreviewRenderPlan.ripples so the WebGPU preview (Plan 12) can render them independently (D-01)"
    - "Post-click dwell is implemented as a synthetic Hover waypoint inserted at `t_ms + post_click_dwell_ms` so min-jerk naturally holds the cursor — no special-case sampling logic"
    - "Velocity cap extends segment duration in place (cumulative shift of later waypoints) — preserves t_ms monotonicity"
    - "One-shot `cargo run --example generate_cursor_skins` emits the 5 committed PNGs procedurally; tests use the committed files, not a re-run build step (keeps CI hermetic)"

key-files:
  created:
    - crates/effects/src/cursor/mod.rs
    - crates/effects/src/cursor/trajectory.rs
    - crates/effects/src/cursor/ripple.rs
    - crates/effects/src/cursor/skins.rs
    - crates/effects/src/cursor/compositor.rs
    - crates/effects/src/cursor/png_sequence.rs
    - crates/effects/examples/generate_cursor_skins.rs
    - crates/effects/tests/cursor_trajectory.rs
    - crates/effects/tests/cursor_ripple.rs
    - crates/effects/tests/cursor_emit.rs
    - crates/effects/tests/canonical_order_full_stage.rs
    - crates/effects/tests/fixtures/cursor_overlay.filter_complex.snap
    - assets/cursor-skins/mac-default.png
    - assets/cursor-skins/win-default.png
    - assets/cursor-skins/dark.png
    - assets/cursor-skins/light.png
    - assets/cursor-skins/big-arrow.png
    - assets/cursor-skins/README.md
  modified:
    - crates/effects/Cargo.toml (+ image 0.25, + rayon 1, + tempfile dev-dep)
    - crates/effects/src/lib.rs (+ pub mod cursor;)
    - crates/effects/src/emit/ffmpeg.rs (CursorOverlay arg order; RippleOverlay → null passthrough; drop unused `ripple_expr` + `RippleEvent` import)
    - crates/effects/tests/fixtures/full_scene.filter_complex.snap (re-accepted)

key-decisions:
  - "Ripples bake into the cursor PNG sequence rather than emitting a second image2 input or per-ripple drawcircle/drawbox chain. Plan 06 specified this explicitly; RippleOverlay in FFmpeg becomes `null` — structurally valid, semantically a no-op. Preview keeps ripples as first-class data so the WebGPU compositor (Plan 12) can animate them natively."
  - "PNG filename format is zero-padded `frame_{:05}.png` for FFmpeg `image2` demuxer compatibility (`-i frame_%05d.png`)."
  - "Tempfile-based test isolation: every PNG sequence test uses `tempfile::TempDir` so parallel `cargo test` runs never collide and CI cleanup is automatic on drop."
  - "`compose_frame` uses `image` 0.25 with default features disabled + only `png` enabled to keep the dep footprint minimal (no JPEG/TIFF/WebP). Rayon parallelises per-frame compositing."
  - "Skin hotspot is the skin PNG's top-left corner — the compositor blits without adjusting for a hotspot table. Cursor skins are hand-placed so their tip sits at (2,2) in the generated PNGs; the 1-2 px offset is negligible at 1080p and avoids maintaining a per-skin metadata file."

patterns-established:
  - "Cursor pipeline: Waypoint[] → sample_trajectory (velocity-capped + reversal-paused + jittered) → CursorSample[] → render_png_sequence (rayon parallel) → PNG sequence on disk"
  - "Determinism path: given (waypoints, TrajectoryOptions, RippleOptions, skin) → byte-identical PNG bytes per frame (validated by png_sequence_is_deterministic test)"
  - "Canonical-order structural validator (canonical_order_full_stage.rs) parses emitted filter_complex into producers/consumers and asserts connectivity — reusable for future emitter changes"

requirements-completed: [POST-03]

metrics:
  duration: ~9 min
  completed: 2026-04-15
  task_count: 3
  test_count: 12 new integration tests (6 trajectory, 7 ripple/skin/png/determinism, 4 emit, 1 canonical-order full-stage = 18 new tests total) + all prior tests still pass
  file_count: 19 created, 4 modified
---

# Phase 2 Plan 06: Cursor Overlay Engine Summary

**One-liner:** Deterministic minimum-jerk cursor trajectory with Perlin jitter, reversal pauses, velocity caps, and post-click dwell; 5 procedurally-generated bundled cursor skins; rayon-parallel PNG sequence renderer consumed by FFmpeg's `overlay` filter with ripples baked in via `compose_frame` — POST-03 delivered end-to-end with a structural connectivity validator that now guards every future emitter change.

## Performance

- **Duration:** ~9 min
- **Started:** 2026-04-15T13:32:55Z
- **Completed:** 2026-04-15T13:42:06Z
- **Tasks:** 3
- **Files created:** 19
- **Files modified:** 4
- **New test count:** 18 (6 trajectory + 7 ripple/skin/png/determinism + 4 emit + 1 canonical full-stage)

## Accomplishments

- **Trajectory sampler** (`crates/effects::cursor::trajectory`) implements the full D-08/D-10/D-11 pipeline:
  1. Post-click dwell insertion (clipped by time to next waypoint — Research §3 `min(200 ms, time_to_next_waypoint)`).
  2. Velocity-cap segment stretching (2500 px/s at 1080p).
  3. Per-segment min-jerk sampling at `fps` via `crate::math::min_jerk::min_jerk_sample`.
  4. Reversal pauses at every `>135°` direction change (100 ms default, 80–120 range).
  5. Deterministic Perlin jitter at ~2 Hz with configurable amplitude (0.5–1.5 px D-08 range; default 1.0).
- **Click ripple factory** with D-10 defaults (`anticipate_ms=60`, `duration_ms=300`, `max_radius_px=60`, white @ 0.9 alpha). Skips non-Click waypoint kinds.
- **5 bundled cursor skins** (`mac-default`, `win-default`, `dark`, `light`, `big-arrow`) generated procedurally via `cargo run -p effects --example generate_cursor_skins` and committed as PNGs.
- **Compositor** (`compose_frame`) alpha-blends ripple rings (antialiased) + cursor skin onto a transparent canvas; straight "over" blending.
- **PNG sequence renderer** (`render_png_sequence`) parallelises per-frame work via rayon, emits `frame_NNNNN.png` to a caller-owned dir, returns `PngSequenceResult` with metadata.
- **FFmpeg emitter update:** `CursorOverlay` → `overlay=eof_action=pass:x=0:y=0`; `RippleOverlay` → `null` passthrough (ripples baked into cursor PNGs).
- **Preview emitter** was already correct from Plan 01 — re-verified and pinned by `preview_plan_carries_cursor_and_ripples`.
- **Canonical connectivity validator** (`canonical_order_full_stage.rs`) parses `filter_complex` into producer/consumer label maps and proves every consumer has exactly one producer + every intermediate producer has ≥ 1 consumer. Ripple's no-op is validated by connectivity, not shape.
- **Determinism guard** (`png_sequence_is_deterministic`) byte-compares every frame across two independent renders — catches any accidental HashMap iteration or time-dependent leaks.

## Task Commits

1. **Task 1: Trajectory sampler + 6 tests** — `bff3889` (feat)
2. **Task 2: Ripple factory + skin loader + PNG sequence + 5 bundled skins + 6 tests** — `b7a75a6` (feat)
3. **Task 3: Emitter updates + cursor_emit snapshot + canonical_order_full_stage** — `b82eafd` (feat)
4. **Determinism guard** — `4ee8800` (test)

## Test Coverage Summary

| Test target | Count | Notes |
|---|---|---|
| `tests/cursor_trajectory.rs` | 6 | endpoint exactness, jitter bounds, seed determinism, reversal pause, velocity cap, post-click dwell |
| `tests/cursor_ripple.rs` | 7 | ripple defaults, non-click skip, load all 5 skins, tint preserves alpha, frame-count + filenames, alpha decay formula, byte-determinism |
| `tests/cursor_emit.rs` | 4 | overlay=eof_action=pass emitted, ripple is null passthrough, preview plan populated, insta snapshot |
| `tests/canonical_order_full_stage.rs` | 1 | producer/consumer connectivity across every VideoNode variant |
| **This plan total** | **18** | all pass |
| Plus existing Plan 01/02/05 tests | 116 | 134 total new-pipeline tests; `cargo test -p effects` exits 0 |

## Files Created / Modified

See frontmatter. Notable:

- `crates/effects/examples/generate_cursor_skins.rs` — one-shot generator; re-run to refresh the committed PNGs.
- `crates/effects/tests/fixtures/cursor_overlay.filter_complex.snap` — new insta golden covering cursor + ripple + passthrough chain.
- `crates/effects/tests/fixtures/full_scene.filter_complex.snap` — re-accepted (drawbox ripple → null; overlay arg order canonicalised).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] `overlay=x='W/2':y='H/2':eof_action=pass` → `overlay=eof_action=pass:x=0:y=0`**
- **Found during:** Task 3 (grep acceptance check)
- **Issue:** Plan 01's Known Stubs said the cursor overlay used a placeholder `x='W/2':y='H/2'` constant; Plan 06's acceptance grep requires the literal substring `overlay=eof_action=pass`. The PNG sequence is pre-composited with cursor pixels positioned at `sample.pos` by `compose_frame`, so the correct semantic is `x=0:y=0` (straight blit).
- **Fix:** Changed the emitter to `overlay=eof_action=pass:x=0:y=0`. The ordering matters for the acceptance grep.
- **Files modified:** `crates/effects/src/emit/ffmpeg.rs`
- **Verification:** `grep -q "overlay=eof_action=pass" crates/effects/src/emit/ffmpeg.rs` → OK; `cargo test -p effects --test cursor_emit` passes.
- **Committed in:** `b82eafd` (Task 3).

**2. [Rule 2 - Missing Critical] RippleOverlay still emitted `drawbox` per event**
- **Found during:** Task 3 (plan spec re-read)
- **Issue:** Plan 01 emitted `drawbox=enable='between(t,…)'` per ripple as a placeholder. Plan 06 explicitly specifies that ripples are baked into the cursor PNG sequence by `compose_frame`, so `RippleOverlay` in FFmpeg must degrade to a no-op passthrough. Leaving drawbox would double-render ripples (once in PNG, once in FFmpeg).
- **Fix:** Replaced the ripple chain with a single `null` filter per RippleOverlay node — preserves chain connectivity (validated by `canonical_order_full_stage`) without emitting duplicate ripple primitives. Preview plan still receives the ripple list (D-01).
- **Files modified:** `crates/effects/src/emit/ffmpeg.rs`, `crates/effects/tests/fixtures/full_scene.filter_complex.snap` (re-accepted).
- **Verification:** `ripple_overlay_is_noop_passthrough` asserts no `drawbox` in the emitted output; canonical connectivity test passes.
- **Committed in:** `b82eafd` (Task 3).

**3. [Rule 1 - Bug] Removed dead `ripple_expr` helper + unused `RippleEvent` import**
- **Found during:** Task 3 (post-change `cargo build`)
- **Issue:** After ripples were re-routed through `compose_frame`, the `ripple_expr` fn in `emit/ffmpeg.rs` became unused → `dead_code` warning; the `RippleEvent` import on the same file became unused too.
- **Fix:** Deleted the function and pruned the import.
- **Files modified:** `crates/effects/src/emit/ffmpeg.rs`
- **Verification:** `cargo build -p effects` is warning-free.
- **Committed in:** `b82eafd` (Task 3).

---

**Total deviations:** 3 auto-fixed (1 blocking, 1 missing-critical, 1 bug — all anticipated by Plan 01's own Known Stubs and Plan 06's `action` notes).
**Impact on plan:** No scope creep. All deviations bring the emitter into alignment with Plan 06's stated design.

## Issues Encountered

None beyond the deviations above. Plan 01's pre-flagged placeholders (drawbox ripple, constant cursor overlay) were replaced cleanly on first attempt; the canonical connectivity validator caught zero structural issues.

## User Setup Required

None — pure Rust + procedurally generated PNG assets.

## Known Stubs

- **Ripple rendering in FFmpeg is a no-op.** This is intentional (ripples are baked into the cursor PNG sequence). If a future plan decouples cursor PNGs from ripples — e.g. to allow user tweaks to ripple timing after PNG generation — the `RippleOverlay` emitter will need to emit `drawcircle` or a dedicated shader.
- **Skin hotspot is fixed at `(0, 0)`.** The generated PNGs are hand-tuned so the arrow tip sits at ~`(2, 2)` within a 64×64 canvas; that's accurate to ~2 px at 1080p. If users report cursor misalignment, add a per-skin hotspot table in `skins.rs`.
- **PNG sequence directory cleanup is caller's responsibility** (T-02-16). Plan 10 (render queue) wires cleanup into job completion; until then, sample code using `render_png_sequence` must `std::fs::remove_dir_all` after encode.
- **`examples/generate_cursor_skins.rs` is not a build step.** PNGs are committed. Regenerate manually if skin art changes.

## Threat Flags

None — T-02-16 (DoS via PNG flood) and T-02-17 (malformed skin PNG → panic) are mitigated per the plan's threat model: `render_png_sequence` docstring documents caller cleanup; `load_skin` wraps `image::open` and returns `EffectsError::Io` on parse failure. No new trust boundaries introduced.

## Next Phase Readiness

- **Plan 02-10 (render queue)** — must call `render_png_sequence` before FFmpeg invocation and `std::fs::remove_dir_all(trajectory_dir)` after encode completes.
- **Plan 02-11 (renderer integration)** — builds the FFmpeg CLI args and adds `-framerate {trajectory.fps} -i {dir}/frame_%05d.png` as an additional input before the filter_complex. The `TrajectoryRef` already carries `png_sequence_dir`, `fps`, `frame_count`.
- **Plan 02-12 (WebGPU preview compositor)** — consumes `PreviewRenderPlan.ripples` + `PreviewRenderPlan.cursor_atlas_ref` directly. No changes needed to the AST; Plan 06 wired everything at the emission layer.

## Self-Check: PASSED

Verification run:
- `[ -f crates/effects/src/cursor/mod.rs ]` → FOUND
- `[ -f crates/effects/src/cursor/trajectory.rs ]` → FOUND
- `[ -f crates/effects/src/cursor/ripple.rs ]` → FOUND
- `[ -f crates/effects/src/cursor/skins.rs ]` → FOUND
- `[ -f crates/effects/src/cursor/compositor.rs ]` → FOUND
- `[ -f crates/effects/src/cursor/png_sequence.rs ]` → FOUND
- `[ -f crates/effects/tests/cursor_trajectory.rs ]` → FOUND
- `[ -f crates/effects/tests/cursor_ripple.rs ]` → FOUND
- `[ -f crates/effects/tests/cursor_emit.rs ]` → FOUND
- `[ -f crates/effects/tests/canonical_order_full_stage.rs ]` → FOUND
- `[ -f crates/effects/tests/fixtures/cursor_overlay.filter_complex.snap ]` → FOUND
- `[ -f assets/cursor-skins/mac-default.png ]` → FOUND
- `[ -f assets/cursor-skins/win-default.png ]` → FOUND
- `[ -f assets/cursor-skins/dark.png ]` → FOUND
- `[ -f assets/cursor-skins/light.png ]` → FOUND
- `[ -f assets/cursor-skins/big-arrow.png ]` → FOUND
- `[ -f assets/cursor-skins/README.md ]` → FOUND
- Commit `bff3889` (Task 1 — trajectory sampler): FOUND
- Commit `b7a75a6` (Task 2 — ripple / skins / PNG sequence / bundled assets): FOUND
- Commit `b82eafd` (Task 3 — emitter update + canonical connectivity): FOUND
- Commit `4ee8800` (determinism guard): FOUND
- `cargo test -p effects` → 134/134 passed, 0 failed
- Grep acceptance: `overlay=eof_action=pass` / `cursor_atlas_ref` / `anticipate_ms: 60` / `duration_ms: 300` / `(1.0 - t_rel).powi(2)` / `frame_{:05}.png` / `peak_velocity_cap_px_per_s: 2500` / `post_click_dwell_ms: 200` / `reversal_threshold_deg: 135` / `min_jerk_sample` / `PerlinNoise2D::new` / `sample_path` → all OK
- PNG byte-determinism: two independent renders of the same trajectory produce byte-identical `frame_NNNNN.png` files (validated by `png_sequence_is_deterministic`).

---
*Phase: 02-cinematic-post-production-export*
*Completed: 2026-04-15*
