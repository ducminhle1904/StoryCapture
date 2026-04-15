---
phase: 02-cinematic-post-production-export
plan: 01
subsystem: effects
tags: [effects, ast, filter-graph, ffmpeg, canonical-order, insta, snapshot-tests, serde, ts-rs]
requires:
  - Phase 1 storage/story-parser ts-rs pattern
provides:
  - crates/effects::Graph
  - crates/effects::VideoNode
  - crates/effects::AudioNode
  - crates/effects::GraphBuilder
  - crates/effects::FfmpegEmit
  - crates/effects::PreviewEmit
  - crates/effects::PreviewRenderPlan
  - crates/effects::ast::SCHEMA_VERSION (2)
  - crates/effects::builder::order::CanonicalStage
  - crates/effects::builder::order::validate_order
  - packages/shared-types/src/generated/effects.ts (ts-rs mirror)
affects:
  - All subsequent Phase 2 plans (05–13) emit AST nodes produced here
tech-stack:
  added:
    - insta = "1.40" (dev)
    - indexmap = "2.5"
    - ts-rs = "10" (optional, default feature)
  patterns:
    - "ts-rs export_to relative paths are resolved via CWD (`./bindings`), not source-file location — 3 dots for crates under crates/*"
    - "NodeId::stable_label produces `<prefix>_<4hex>` deterministic labels derived from the low 16 bits of the UUID"
    - "Runtime validator for canonical order (not typestate builder) per Research §1 simpler-is-better rationale"
key-files:
  created:
    - crates/effects/src/ast/mod.rs
    - crates/effects/src/ast/types.rs
    - crates/effects/src/ast/video.rs
    - crates/effects/src/ast/audio.rs
    - crates/effects/src/builder/mod.rs
    - crates/effects/src/builder/order.rs
    - crates/effects/src/emit/mod.rs
    - crates/effects/src/emit/ffmpeg.rs
    - crates/effects/src/emit/preview.rs
    - crates/effects/src/error.rs
    - crates/effects/tests/canonical_order.rs
    - crates/effects/tests/minimal_scene.rs
    - crates/effects/tests/full_scene.rs
    - crates/effects/tests/audio_mix.rs
    - crates/effects/tests/fixtures/minimal_scene.filter_complex.snap
    - crates/effects/tests/fixtures/full_scene.filter_complex.snap
    - crates/effects/tests/fixtures/audio_mix.filter_complex.snap
    - packages/shared-types/src/generated/effects.ts
  modified:
    - crates/effects/Cargo.toml
    - crates/effects/src/lib.rs
decisions:
  - "GraphBuilder.build() takes &mut self (not self) so fluent `&mut Self` chaining composes cleanly with a terminal .build() call; graph is cloned on build"
  - "ts-rs export_to path uses 3 dots (matches story-parser pattern); the PLAN sketched 2 dots which resolves outside the crate dir and fails at runtime"
  - "Transition emission uses a placeholder [next] input label; Plan 10 (multi-scene) wires actual next-scene labels"
  - "FFmpeg drawtext text and path arguments are escaped (`:`, `'`, `\\`) per T-02-02"
metrics:
  duration: ~90 minutes
  completed: 2026-04-15
  task_count: 3
  test_count: 44
  file_count: 19
---

# Phase 2 Plan 01: Filter-Graph AST + Dual Emitters Summary

**One-liner:** Typed Rust enum tree (`crates/effects`) with serde round-trip, ts-rs TS mirror, canonical-order validator, and dual FFmpeg/Preview emitters pinned by insta snapshot fixtures — eliminating string-concatenated filtergraphs (D-18) and Pitfall #1 label collisions.

## AST shape delivered

**VideoNode (7 variants):** Source, ZoomPan, Background, CursorOverlay, RippleOverlay, TextOverlay, Transition.

**AudioNode (6 variants):** AudioSource, Volume, Delay, Sidechain, Amix, Alimiter.

**Root:** `Graph { schema_version: u32 (=2), output_width, output_height, output_fps, video: Vec<VideoNode>, audio: Vec<AudioNode> }`.

**Supporting types:** `NodeId(Uuid)`, `Rgba`, `Vec2`, `Duration`, `EasingKind`, `ZoomKeyframe`, `ZoomTarget`, `BackgroundKind`, `Shadow`, `CursorSkin`, `TrajectoryRef`, `RippleEvent` (with `RippleEvent::at_impact()` defaulting from Research §3), `FontChoice`, `TextAnim`, `BoxStyle`, `TextBox`, `XfadeKind` (14-value subset + `ffmpeg_token()`), `SidechainParams` (with `Default` matching D-22 / Research §6: threshold=0.08, ratio=8, attack=80ms, release=400ms), `AmixParams`.

**Canonical order enum:** `CanonicalStage { Source=0, ZoomPan=1, Background=2, Cursor=3, Ripple=4, Text=5, Transition=6, AudioMix=7 }`.

## Emit function signatures (for downstream plan reference)

```rust
// FFmpeg filter_complex (byte-for-byte deterministic)
pub struct FfmpegEmit;
impl FfmpegEmit { pub fn emit(g: &Graph) -> String; }
pub fn emit_filter_complex(g: &Graph) -> String;

// WebGPU preview plan
pub struct PreviewEmit;
impl PreviewEmit { pub fn emit(g: &Graph) -> PreviewRenderPlan; }
pub fn emit_preview_plan(g: &Graph) -> PreviewRenderPlan;

pub struct PreviewRenderPlan {
    pub output_width: u32,
    pub output_height: u32,
    pub fps: u32,
    pub zoom_matrices: Vec<ZoomMatrixFrame>,
    pub cursor_atlas_ref: Option<TrajectoryRef>,
    pub ripples: Vec<RippleEvent>,
    pub text_boxes: Vec<TextBox>,
    pub background: Option<BackgroundKind>,
}
```

Builder:

```rust
pub struct GraphBuilder { /* ... */ }
impl GraphBuilder {
    pub fn new(w: u32, h: u32, fps: u32) -> Self;
    pub fn source(&mut self, id: NodeId, path: impl Into<PathBuf>, pts_offset_ms: u64) -> &mut Self;
    pub fn zoom_pan(&mut self, id, target: ZoomTarget, keyframes: Vec<ZoomKeyframe>) -> &mut Self;
    pub fn background(&mut self, id, kind: BackgroundKind, radius_px: f32, shadow: Option<Shadow>) -> &mut Self;
    pub fn cursor(&mut self, id, skin, size_scale, color_tint, trajectory) -> &mut Self;
    pub fn ripple(&mut self, id, events: Vec<RippleEvent>) -> &mut Self;
    pub fn text(&mut self, id, boxes: Vec<TextBox>) -> &mut Self;
    pub fn transition(&mut self, id, kind: XfadeKind, duration_ms, offset_ms) -> &mut Self;
    pub fn audio_source / audio_volume / audio_delay / audio_sidechain / audio_mix / audio_limiter(...) -> &mut Self;
    pub fn build(&mut self) -> Result<Graph, BuilderError>;
}
```

## Deviations from Plan

**[Rule 3 - Blocking] ts-rs path resolution: 3 dots, not 2**
- **Found during:** Task 1 (initial `cargo test`)
- **Issue:** Plan sketch used `export_to = "../../packages/shared-types/src/generated/effects.ts"`. ts-rs 10 resolves `export_to` relative to CWD + `./bindings` (not the source file). From `crates/effects/` that means `bindings/../../packages/…` lands **outside** the repo.
- **Fix:** Use `"../../../packages/shared-types/src/generated/effects.ts"` (3 dots) — identical pattern to the Phase 1 `story-parser` crate. Generated file now lands correctly at `packages/shared-types/src/generated/effects.ts`.
- **Files modified:** all six `src/ast/*.rs`, `src/builder/order.rs`, `src/emit/preview.rs`.
- **Commit:** `7c0d9cc` (initial feat commit contains the corrected path).

**[Rule 2 - Missing critical functionality] drawtext / path escaping (T-02-02)**
- Added explicit `escape_drawtext()` and `escape_ffmpeg_path()` helpers in `emit/ffmpeg.rs`. The full_scene snapshot fixture includes a text string with `'` and `:` to lock the escape behaviour into CI.

**[Rule 1 - Bug] Builder ownership pattern**
- Initial build signature was `fn build(mut self) -> ...`, incompatible with `&mut Self` fluent methods. Changed to `fn build(&mut self) -> Result<Graph, _>` which clones the graph out so the builder remains usable. Integration tests now chain cleanly.

**Minor scope-internal choices (not plan deviations):**
- Added `AudioNode::Delay` and `audio_delay` builder method for ducking prototypes (referenced by Research §6; harmless to add now).
- `CanonicalStage` variant is `AudioMix` (not `Audio`) to match the PLAN's acceptance-criterion grep target `CanonicalStage::AudioMix`.

## Test Coverage Summary

| Test target | Count | Notes |
|---|---|---|
| `--lib` (ts-rs auto-generated exports) | 27 | One per `#[derive(TS)]` type — validates export paths |
| `--lib ast::tests` | 3 | schema version, serde round-trip, stable_label determinism |
| `tests/canonical_order.rs` | 7 | D-19 validator, gaps allowed, duplicate-id, sidechain defaults |
| `tests/minimal_scene.rs` | 2 | shortest emittable graph + determinism |
| `tests/full_scene.rs` | 4 | all canonical stages + preview plan + drawtext escape |
| `tests/audio_mix.rs` | 1 | audio-only chain |
| **Total** | **44** | `cargo test -p effects` exits 0 |

## Verification

- `cargo build -p effects`: ✅
- `cargo test -p effects`: ✅ 44/44 passing
- `cargo check -p effects`: ✅
- Generated TS file: `packages/shared-types/src/generated/effects.ts` (~19KB, 23 exported types)
- Deterministic emission verified (same Graph → identical filter_complex strings on repeat runs)

## Known Stubs

The following are intentional placeholders refined by downstream plans; they emit the correct **shape** but not yet the final algorithms:

- **ZoomPan filter expression** (`emit/ffmpeg.rs`): uses first keyframe only — Plan 05 implements keyframe interpolation with easing.
- **Preview `zoom_matrices`**: one frame per keyframe (not per output frame) — Plan 05 expands to per-frame sampling with full 3x3 transforms.
- **CursorOverlay overlay expression**: constant `x='W/2':y='H/2'` — Plan 08 (cursor trajectory) wires per-frame lookup.
- **RippleOverlay**: uses `drawbox` as a placeholder for the anti-anticipation pulse — Plan 09 (ripples) will emit `drawcircle`/shader.
- **TextOverlay**: no animation math (alpha ramps for Fade are shape-only) — Plan 07 fills in.
- **Transition**: uses a literal `[next]` label; Plan 10 (multi-scene) wires actual scene labels.

## Self-Check: PASSED

Verification run:
- `[ -f crates/effects/src/ast/mod.rs ]` → FOUND
- `[ -f crates/effects/src/ast/video.rs ]` → FOUND
- `[ -f crates/effects/src/ast/audio.rs ]` → FOUND
- `[ -f crates/effects/src/builder/order.rs ]` → FOUND
- `[ -f crates/effects/src/emit/ffmpeg.rs ]` → FOUND
- `[ -f crates/effects/src/emit/preview.rs ]` → FOUND
- `[ -f crates/effects/tests/fixtures/minimal_scene.filter_complex.snap ]` → FOUND
- `[ -f crates/effects/tests/fixtures/full_scene.filter_complex.snap ]` → FOUND
- `[ -f crates/effects/tests/fixtures/audio_mix.filter_complex.snap ]` → FOUND
- `[ -f packages/shared-types/src/generated/effects.ts ]` → FOUND
- Commit `7c0d9cc` (Task 1 — AST + scaffolding): FOUND
- Commit `cb75ec5` (Task 2 — builder + canonical order): FOUND
- Commit `28ef1f1` (Task 3 — insta goldens): FOUND
