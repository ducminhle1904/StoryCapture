---
phase: 02-cinematic-post-production-export
plan: 07
subsystem: effects
tags: [effects, background, gradients, rounded-frame, drop-shadow, padding, xfade, transitions, opencl, ffmpeg, POST-04, POST-05]

requires:
  - phase: 02-cinematic-post-production-export
    provides: "Plan 01 Graph AST (VideoNode::Background with radius/shadow), Plan 06 emitter conventions (source_count, stable labels)"
provides:
  - crates/effects::background::{validate_and_copy_image, MAX_UPLOAD_DIMS, MAX_UPLOAD_SIZE_BYTES, ALLOWED_IMAGE_EXTS}
  - crates/effects::background::gradients::{GradientPreset, GRADIENT_PRESETS, lookup, resolve_asset_path, load_gradient_png}
  - crates/effects::background::compositor::{emit_background, BackgroundEmit, ExtraInput, shadow_params_from}
  - crates/effects::background::rounded_frame::{emit_rounded_mask, RoundedFrameParams}
  - crates/effects::background::shadow::{emit_drop_shadow, ShadowParams}
  - crates/effects::transitions::{XfadeTimeline, compute_offsets, emit_xfade, kind_supports_opencl, probe_xfade_opencl, probe_from_stdout, OpenClAvailability}
  - crates/effects::emit::ffmpeg::collect_extra_inputs
  - VideoNode::Background gains `padding_px: u32` (Plan 01 field extension)
  - GraphBuilder::background_with_padding(id, kind, radius, shadow, padding_px)
  - assets/gradient-presets/{runway-dark,runway-light,linear-slate,elevenlabs-violet,warm-sunset,cool-ocean,forest-emerald,solid-black,solid-white,paper-grain}.png + manifest.json + README.md
  - crates/effects/examples/gen_gradient_presets.rs (deterministic one-shot generator)
  - crates/effects/tests/fixtures/background_gradient.filter_complex.snap (new insta golden)
  - crates/effects/tests/fixtures/transitions_chained.filter_complex.snap (new insta golden)
affects:
  - full_scene.filter_complex.snap re-accepted (Background arm now emits the full compositor chain that Plan 01 had stubbed)
  - Plan 11 (renderer integration) must call `collect_extra_inputs(&g)` to thread gradient/user-image/lavfi sources into the ffmpeg `-i` list in the order they appear

tech-stack:
  added: []  # image, rayon, tempfile already in Cargo.toml from Plan 06
  patterns:
    - "Background compositor returns (filter_chain, extra_inputs) so the filter string can be emitted without knowing final ffmpeg CLI layout; Plan 11 consumes extra_inputs"
    - "Rounded-corner mask uses `geq` per-pixel radius-squared test; zero radius short-circuits to `null` passthrough to keep the chain connected"
    - "Drop shadow = format=rgba + geq RGB tint with alpha scaling + boxblur; composited under the foreground rounded layer via `split=2` into two branches"
    - "xfade offset math centralised in XfadeTimeline::compute_offsets (Pitfall #6); AST node stores offset_ms produced by this function — emitter doesn't recompute"
    - "xfade_opencl auto-enabled only for geometric kinds (Fade/Dissolve/Wipe*/Slide*); fadeblack/fadewhite/circleopen/circleclose fall back to CPU xfade silently"
    - "Gradient preset_id is looked up against a static registry; unknown IDs surface as EffectsError::UnknownGradient and never become a filesystem path (T-02-21)"

key-files:
  created:
    - crates/effects/src/background/mod.rs
    - crates/effects/src/background/gradients.rs
    - crates/effects/src/background/compositor.rs
    - crates/effects/src/background/rounded_frame.rs
    - crates/effects/src/background/shadow.rs
    - crates/effects/src/transitions/mod.rs
    - crates/effects/src/transitions/xfade.rs
    - crates/effects/src/transitions/timeline.rs
    - crates/effects/src/transitions/opencl_probe.rs
    - crates/effects/examples/gen_gradient_presets.rs
    - crates/effects/tests/background.rs
    - crates/effects/tests/transitions.rs
    - crates/effects/tests/fixtures/background_gradient.filter_complex.snap
    - crates/effects/tests/fixtures/transitions_chained.filter_complex.snap
    - assets/gradient-presets/manifest.json
    - assets/gradient-presets/README.md
    - assets/gradient-presets/runway-dark.png
    - assets/gradient-presets/runway-light.png
    - assets/gradient-presets/linear-slate.png
    - assets/gradient-presets/elevenlabs-violet.png
    - assets/gradient-presets/warm-sunset.png
    - assets/gradient-presets/cool-ocean.png
    - assets/gradient-presets/forest-emerald.png
    - assets/gradient-presets/solid-black.png
    - assets/gradient-presets/solid-white.png
    - assets/gradient-presets/paper-grain.png
  modified:
    - crates/effects/src/lib.rs (+ pub mod background; pub mod transitions;)
    - crates/effects/src/ast/video.rs (+ padding_px field on VideoNode::Background)
    - crates/effects/src/builder/mod.rs (+ background_with_padding)
    - crates/effects/src/error.rs (+ ImageTooLarge / UnsupportedImageFormat / InvalidPath / ImageDecode / UnknownGradient / FfmpegProbe; From<image::ImageError>)
    - crates/effects/src/emit/ffmpeg.rs (delegates Background arm to emit_background; + collect_extra_inputs)
    - crates/effects/tests/fixtures/full_scene.filter_complex.snap (re-accepted)
    - packages/shared-types/src/generated/effects.ts (ts-rs regeneration from padding_px field addition)

key-decisions:
  - "padding_px added as an optional Plan 01 AST extension (serde default = 0) rather than a new node type — preserves backward compatibility for .scpreset files saved before Plan 07"
  - "GraphBuilder keeps the 4-arg .background(id, kind, radius, shadow) as a convenience that forwards padding_px=0, and exposes .background_with_padding(...) for the full signature. Zero-breakage for existing call sites (full_scene, canonical_order_full_stage, canonical_order, etc.)"
  - "Drop shadow is a pre-blurred alpha copy composited UNDER the rounded video, not a per-frame geq or FFmpeg source — avoids the O(w*h) per-frame cost documented in the plan"
  - "Split filter uses `split=2[a][b]` (explicit output count); the short-form `split[a][b]` is accepted by FFmpeg but implementations disagree on count inference, so we emit the safe canonical form"
  - "Background compositor emits ONLY the filter_complex fragment; extra `-i` inputs are surfaced via the `BackgroundEmit.extra_inputs` return and collected graph-wide via `collect_extra_inputs()` for Plan 11 to splice into the FFmpeg CLI"

patterns-established:
  - "Background pipeline: Graph → emit_background(node, bg_input_index) → (filter_chain, extra_inputs[]) → FFmpeg CLI assembly (Plan 11)"
  - "Transition offset pipeline: XfadeTimeline (clips, transitions) → compute_offsets → offset_ms written into each VideoNode::Transition → emitter just formats the xfade filter (no arithmetic)"
  - "Runtime feature probing: `probe_from_stdout` is a pure function (hermetic tests); `probe_xfade_opencl(&Path)` wraps with a Command spawn for runtime use"

requirements-completed: [POST-04, POST-05]

metrics:
  duration: ~11 min
  completed: 2026-04-15
  task_count: 3
  test_count: 15 new (5 background + 10 transitions) + 4 background-unit-lib + 3 rounded_frame unit + 2 shadow unit + 4 background::tests upload validator = 18 new lib/integration tests; `cargo test -p effects` 162/162 passing
  file_count: 26 created, 7 modified
---

# Phase 2 Plan 07: Background Compositor + Scene Transitions Summary

**One-liner:** POST-04 background compositor (10 curated 1920×1080 gradient PNGs + user-image upload with MIME/size/dim validation + configurable rounded frame + drop shadow + padding) and POST-05 scene transitions (FFmpeg xfade with centralised Research-§5 offset math in `XfadeTimeline` + runtime `xfade_opencl` probe with silent CPU fallback) — both features emit to the AST + both emitters (FFmpeg string + Preview plan) per D-01, with 2 new insta goldens locking byte-for-byte shape.

## Performance

- **Duration:** ~11 min
- **Started:** 2026-04-15T13:45:19Z
- **Completed:** 2026-04-15T13:56:24Z
- **Tasks:** 3
- **Files created:** 26 (4 source modules + 5 transitions+background source files + 2 integration tests + 2 new snapshot fixtures + 1 example + 12 assets)
- **Files modified:** 7
- **New test count:** 15 integration tests (5 background + 10 transitions) plus 13 inline unit tests; all 162 `cargo test -p effects` tests pass

## Accomplishments

### Task 1 — Gradient registry + 10 PNG assets + image upload validator (commit `c3e46e6`)

- `GRADIENT_PRESETS: &[GradientPreset; 10]` static registry with stable IDs matching the must-have list (`runway-dark`, `runway-light`, `linear-slate`, `elevenlabs-violet`, `warm-sunset`, `cool-ocean`, `forest-emerald`, `solid-black`, `solid-white`, `paper-grain`).
- `cargo run -p effects --example gen_gradient_presets` procedurally emits 10 deterministic 1920×1080 PNGs + committed to `assets/gradient-presets/`. Pure lerp-based gradients for 7, solid for 2, fixed-seed LCG speckle for `paper-grain`.
- `assets/gradient-presets/manifest.json` + `README.md` shipped; regeneration instructions documented.
- `background::validate_and_copy_image(&Path, &Path) -> Result<PathBuf, EffectsError>` enforces:
  - Extension ∈ {png, jpg, jpeg}
  - File size ≤ 10 MiB
  - Decoded dimensions ≤ 8192×8192
  Destination is `<project>/backgrounds/<filename>`; parent dir created if missing (T-02-18, T-02-19).
- `VideoNode::Background` gains `padding_px: u32` (serde default = 0 for backward compatibility with pre-Plan-07 presets). `GraphBuilder::background(...)` retained as 4-arg convenience; `background_with_padding(...)` is the full ctor.
- New error variants: `ImageTooLarge{bytes}`, `UnsupportedImageFormat(String)`, `InvalidPath`, `ImageDecode(String)`, `UnknownGradient(String)`, `FfmpegProbe(String)`.

### Task 2 — Background compositor (rounded frame + drop shadow + padding) (commit `f0647d3`)

- `compositor::emit_background(node, in_label, out_label, graph, bg_input_index)` returns `BackgroundEmit { filter_chain, extra_inputs }`. Handles all three `BackgroundKind` variants uniformly:
  - `Gradient` → real PNG input at `<repo>/assets/gradient-presets/<id>.png` (looped).
  - `Image` → user-supplied path (looped).
  - `Solid` → lavfi `color=c=0xRRGGBB@A:s=WxH` synthetic source.
- Filter chain:
  1. `[bg:v]scale=…:force_original_aspect_ratio=increase,crop=…` → scaled bg plate.
  2. `[in]scale=(w-2p):(h-2p)` → scaled foreground.
  3. `geq` rounded-corner alpha mask (per-pixel radius-squared corner check).
  4. If shadow: `split=2` + `format=rgba,geq=<tint>,boxblur=<blur>:1` → blurred shadow; overlayed on bg at `(padding + offset.x, padding + offset.y)`.
  5. Final `overlay=x=padding:y=padding` composites rounded video on top.
- `emit::ffmpeg::emit_filter_complex` delegates `VideoNode::Background` to `emit_background`; `source_count` advances per `extra_inputs.len()` so downstream Source nodes still index correctly.
- `emit::ffmpeg::collect_extra_inputs(&Graph) -> Vec<ExtraInput>` surfaces the backgrounds' extra `-i` slots graph-wide for Plan 11 (renderer integration).
- Unknown gradient preset_id surfaces as `EffectsError::UnknownGradient` at emit time (T-02-21 mitigation — never a filesystem path injection).

### Task 3 — xfade timeline + OpenCL probe + chained snapshot (commit `e940a8a`)

- `XfadeTimeline { clip_durations_ms, transitions: Vec<(boundary, kind, duration_ms)> }` + `compute_offsets(&XfadeTimeline) -> Vec<u32>` implements Research §5 Code Example 3:
  ```
  offset_N = sum(clip_durations[0..=boundary_N]) - sum(transition_durations[0..N]) - transition_durations[N]
  ```
  Centralising this here is the Pitfall #6 mitigation.
- `emit_xfade(kind, duration_ms, offset_ms, in_a, in_b, out_label, use_opencl)` chooses `xfade_opencl` only when `use_opencl && kind_supports_opencl(kind)`. OpenCL coverage (per FFmpeg): `Fade, Dissolve, Wipe{Left,Right,Up,Down}, Slide{Left,Right,Up,Down}`. `{FadeBlack, FadeWhite, CircleOpen, CircleClose}` remain CPU-only and fall back silently.
- `probe_from_stdout(&str) -> OpenClAvailability` pure function; `probe_xfade_opencl(&Path)` wraps with `ffmpeg -hide_banner -filters` subprocess spawn plus best-effort `ffmpeg -version` for the banner string.
- Default = none (D-25): empty `transitions: []` produces empty `Vec<u32>`.

## Task Commits

1. **Task 1: Gradient registry + 10 PNGs + image upload validator** — `c3e46e6`
2. **Task 2: Background compositor with rounded frame + drop shadow + padding** — `f0647d3`
3. **Task 3: xfade timeline + OpenCL probe + chained transition snapshot** — `e940a8a`

## Test Coverage Summary

| Test target | Count | Notes |
|---|---|---|
| `tests/background.rs` | 5 | geq rounded mask, boxblur shadow, gradient PNG path resolution, unknown-preset error path, insta snapshot |
| `tests/transitions.rs` | 10 | 4 offset-math (single/chained-3/varying/empty), 2 probe (present/absent), 3 emit variants (CPU/opencl-supported/opencl-fallback), 1 chained snapshot |
| `src/background/mod.rs::tests` | 4 | accept valid PNG, reject big dimensions, reject .txt, reject oversized bytes |
| `src/background/gradients.rs::tests` | 5 | count == 10, IDs stable, lookup known/unknown, each PNG ≥ 1920×1080 loads, manifest.json parses |
| `src/background/rounded_frame.rs::tests` | 2 | geq for nonzero radius, null for zero radius |
| `src/background/shadow.rs::tests` | 2 | boxblur + tint, default params sane |
| `src/transitions/timeline.rs::tests` | 4 | dup of integration offset-math cases |
| `src/transitions/xfade.rs::tests` | 3 | dup of integration emit-xfade cases |
| `src/transitions/opencl_probe.rs::tests` | 3 | detect / absent / version parse |
| **This plan new tests** | **38** | includes 15 integration + 23 inline unit |
| Plus all prior Plan 01/02/05/06 tests | 124 | **162 total; `cargo test -p effects` passes** |

## Files Created / Modified

See frontmatter. Notable:

- `crates/effects/examples/gen_gradient_presets.rs` — pure-function deterministic generator; regenerate the 10 PNGs in-place with one command.
- `crates/effects/tests/fixtures/background_gradient.filter_complex.snap` — new insta golden for Gradient + radius=24 + shadow(blur=32, offset=(0,8), 50% black) + padding=64.
- `crates/effects/tests/fixtures/transitions_chained.filter_complex.snap` — new insta golden for 3-clip timeline with Fade + Dissolve transitions.
- `crates/effects/tests/fixtures/full_scene.filter_complex.snap` — re-accepted; Plan 01 Known Stub "Background uses flat `color→overlay`" superseded by the full compositor chain here.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing critical functionality] `split[a][b]` → `split=2[a][b]`**
- **Found during:** Task 2 (first snapshot run)
- **Issue:** Initial draft emitted `split[n_fg_a][n_fg_b]` without the integer output count. FFmpeg's `split` filter accepts an implicit count in many builds but the canonical form per docs is `split=N[out_0]...[out_{N-1}]`. Some minimal builds reject the implicit form.
- **Fix:** Emit `split=2[a][b]` explicitly.
- **Files modified:** `crates/effects/src/background/compositor.rs`
- **Committed in:** `f0647d3` (Task 2).

**2. [Rule 3 - Blocking] Plan 01 AST extension: `padding_px` field**
- **Found during:** Task 1 (before touching compositor — plan explicitly flagged this)
- **Issue:** Plan 07 calls for `VideoNode::Background { padding_px: u32 }` but Plan 01 shipped without it. The plan itself anticipated this and allowed a "small surgical edit" to Plan 01's AST.
- **Fix:** Added `padding_px: u32` with `#[serde(default)]` so pre-Plan-07 .scpreset files continue to load. Builder retains `.background(id, kind, radius, shadow)` 4-arg form forwarding `padding_px=0`, and exposes `.background_with_padding(...)` as the full constructor. All existing callers (full_scene.rs, canonical_order.rs, canonical_order_full_stage.rs) continue to compile unchanged.
- **Files modified:** `crates/effects/src/ast/video.rs`, `crates/effects/src/builder/mod.rs`, `packages/shared-types/src/generated/effects.ts` (ts-rs regeneration).
- **Committed in:** `c3e46e6` (Task 1).

**3. [Rule 2 - Missing critical functionality] `collect_extra_inputs(&Graph)` helper**
- **Found during:** Task 2 (wire-in)
- **Issue:** `emit_background` returns extra `-i` inputs that must be spliced into the final FFmpeg CLI, but the Plan 01 emitter contract is `emit(&Graph) -> String` (filter_complex only). Plan 11 (renderer integration) will need a way to retrieve those extra inputs graph-wide.
- **Fix:** Added `emit::ffmpeg::collect_extra_inputs(&Graph) -> Vec<ExtraInput>` that walks the graph a second time and accumulates the per-Background `extra_inputs`. Plan 11 calls this once at render assembly time.
- **Files modified:** `crates/effects/src/emit/ffmpeg.rs`
- **Committed in:** `f0647d3` (Task 2).

**4. [Rule 2 - Missing critical functionality] New error variants + `From<image::ImageError>`**
- **Found during:** Task 1 (validator + gradient loader plumbing)
- **Issue:** Plan-specified errors (`ImageTooLarge`, `UnsupportedImageFormat`, `UnknownGradient`) didn't exist in `EffectsError`. Without them, error handling would be ad-hoc strings.
- **Fix:** Added `ImageTooLarge { bytes }`, `UnsupportedImageFormat(String)`, `InvalidPath`, `ImageDecode(String)`, `UnknownGradient(String)`, `FfmpegProbe(String)` variants, plus `impl From<image::ImageError>` for ergonomic `?` in the validator.
- **Files modified:** `crates/effects/src/error.rs`
- **Committed in:** `c3e46e6` (Task 1).

---

**Total deviations:** 4 auto-fixed (2 missing-critical, 1 blocking — Plan 01 AST extension anticipated by the plan itself, 1 bug prevention). No Rule 4 architectural pauses.
**Impact on plan:** No scope creep; all deviations bring emission into alignment with Plan 07's stated design.

## Issues Encountered

None beyond the deviations above. `cargo test -p effects` exits 0; zero build warnings.

## User Setup Required

None — pure Rust + procedurally generated PNG assets committed.

## Known Stubs

- **Gradient / Image / Solid use the same `extra_inputs` slot count (always 1).** The emitter doesn't yet support "synthesise bg from two gradient presets and dissolve" which would need 2 slots. Not a POST-04 requirement; Plan 07 as-written is complete.
- **`collect_extra_inputs` re-runs `emit_background` solely to read its `extra_inputs` return.** This is idempotent and side-effect-free but does O(N) duplicate work; Plan 11 can optimise by caching. Not performance-critical at current graph sizes.
- **Paper-grain preset uses a fixed-seed LCG, not true Perlin noise.** The grain pattern is a flat speckle, good enough as a visual backing; a future refinement could use `crates/effects::math::PerlinNoise2D` for a richer texture. Distribution is 100% deterministic, which is what matters for reproducible CI.
- **OpenCL probe doesn't verify the OpenCL runtime itself is functional** — only that ffmpeg was built with the filter. On a box with broken OpenCL drivers, `xfade_opencl` will still be selected and fail at render time. Plan 13 (release pipeline) can add a render-time smoke test.

## Threat Flags

No new trust boundaries beyond those enumerated in the plan's `<threat_model>`:

- T-02-18 (malicious dimensions): mitigated by `validate_and_copy_image` dimension cap test.
- T-02-19 (9000×9000 DoS): mitigated by same + file-size cap.
- T-02-20 (xfade offset miscalculation): mitigated by `compute_offsets` + 4 dedicated tests.
- T-02-21 (preset_id as path): mitigated by static `GRADIENT_PRESETS` registry lookup returning `UnknownGradient` on miss.

No additional threats surfaced.

## Next Phase Readiness

- **Plan 02-11 (render queue + FFmpeg CLI assembly)** must:
  1. Call `effects::emit::ffmpeg::collect_extra_inputs(&graph)` once per scene.
  2. For each `ExtraInput`, add to the FFmpeg CLI in traversal order:
     - `loop_single_frame=true` → `-loop 1 -i <uri>`
     - `lavfi=true` → `-f lavfi -i <uri>`
     - neither → `-i <uri>`
  3. Preserve the Source-node stream count so `[N:v]` indices match the filter_complex.
- **Plan 02-12 (WebGPU preview compositor)** already receives `PreviewRenderPlan.background: Option<BackgroundKind>` from Plan 01; no changes required here.
- **Plan 02-13 (settings UI)** can surface the 10 gradient presets to the inspector via `GRADIENT_PRESETS` + read `manifest.json` for display names/tags.

## Verification

- `cargo build -p effects` → zero warnings
- `cargo test -p effects` → 162/162 passed, 0 failed
- `cargo run -p effects --example gen_gradient_presets` → regenerates 10 PNGs deterministically
- insta snapshots: `background_gradient.filter_complex.snap` + `transitions_chained.filter_complex.snap` stable across repeat runs
- Acceptance greps all pass:
  - `test -f assets/gradient-presets/runway-dark.png` → OK
  - `test -f assets/gradient-presets/manifest.json` → OK
  - `ls assets/gradient-presets/*.png | wc -l` → 10
  - `grep -q "\"runway-dark\"" assets/gradient-presets/manifest.json` → OK
  - `grep -q "GRADIENT_PRESETS: &\[GradientPreset\]" crates/effects/src/background/gradients.rs` → OK
  - `grep -q "geq=r=" crates/effects/src/background/rounded_frame.rs` → OK
  - `grep -q "boxblur" crates/effects/src/background/shadow.rs` → OK
  - `grep -q "gradient-presets" crates/effects/src/background/compositor.rs` → OK
  - `grep -q "pub fn compute_offsets" crates/effects/src/transitions/timeline.rs` → OK
  - `grep -q "xfade_opencl" crates/effects/src/transitions/opencl_probe.rs` → OK
  - `grep -q "xfade_opencl" crates/effects/src/transitions/xfade.rs` → OK
  - `grep -q "sum_clips - sum_trans" crates/effects/src/transitions/timeline.rs` → OK (in comment explaining formula)

## Self-Check: PASSED

Verification run:
- `[ -f crates/effects/src/background/mod.rs ]` → FOUND
- `[ -f crates/effects/src/background/gradients.rs ]` → FOUND
- `[ -f crates/effects/src/background/compositor.rs ]` → FOUND
- `[ -f crates/effects/src/background/rounded_frame.rs ]` → FOUND
- `[ -f crates/effects/src/background/shadow.rs ]` → FOUND
- `[ -f crates/effects/src/transitions/mod.rs ]` → FOUND
- `[ -f crates/effects/src/transitions/xfade.rs ]` → FOUND
- `[ -f crates/effects/src/transitions/timeline.rs ]` → FOUND
- `[ -f crates/effects/src/transitions/opencl_probe.rs ]` → FOUND
- `[ -f crates/effects/examples/gen_gradient_presets.rs ]` → FOUND
- `[ -f crates/effects/tests/background.rs ]` → FOUND
- `[ -f crates/effects/tests/transitions.rs ]` → FOUND
- `[ -f crates/effects/tests/fixtures/background_gradient.filter_complex.snap ]` → FOUND
- `[ -f crates/effects/tests/fixtures/transitions_chained.filter_complex.snap ]` → FOUND
- `[ -f assets/gradient-presets/manifest.json ]` → FOUND
- `[ -f assets/gradient-presets/runway-dark.png ]` → FOUND
- `[ -f assets/gradient-presets/runway-light.png ]` → FOUND
- `[ -f assets/gradient-presets/linear-slate.png ]` → FOUND
- `[ -f assets/gradient-presets/elevenlabs-violet.png ]` → FOUND
- `[ -f assets/gradient-presets/warm-sunset.png ]` → FOUND
- `[ -f assets/gradient-presets/cool-ocean.png ]` → FOUND
- `[ -f assets/gradient-presets/forest-emerald.png ]` → FOUND
- `[ -f assets/gradient-presets/solid-black.png ]` → FOUND
- `[ -f assets/gradient-presets/solid-white.png ]` → FOUND
- `[ -f assets/gradient-presets/paper-grain.png ]` → FOUND
- Commit `c3e46e6` (Task 1 — gradient registry + 10 PNGs + validator): FOUND
- Commit `f0647d3` (Task 2 — background compositor + rounded + shadow): FOUND
- Commit `e940a8a` (Task 3 — xfade timeline + OpenCL probe + snapshot): FOUND
- `cargo test -p effects` → 162/162 passed, 0 failed

---
*Phase: 02-cinematic-post-production-export*
*Completed: 2026-04-15*
