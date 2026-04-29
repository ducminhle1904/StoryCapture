# Phase 20 — Cursor Overlay Render Fix

**Status:** PROPOSED
**Date drafted:** 2026-04-28
**Depends on:** Phase 19-02 (trajectory sidecar)
**Blocker level:** 🔴 CRITICAL — cursor track in graph cannot render until this lands

## The mismatch

| Side | Format |
|---|---|
| Effects crate (`crates/effects/src/ast/video.rs:111`) | `TrajectoryRef { png_sequence_dir: PathBuf }` — directory of PNG images, one per frame |
| FFmpeg emit (`emit/ffmpeg.rs:178`) | Reads `png_sequence_dir` via image2 demuxer |
| Phase 19-02 ship | `<basename>.trajectory.json` with `[{ t_ms, x, y, click }]` array |
| compute-graph.ts (TS) | Passes JSON path as `png_sequence_dir` |

→ FFmpeg image2 demuxer cannot decode JSON. Cursor track in `graph.video[]` produces a hard FFmpeg error at render time.

## Architecture decision

**D-1 LOCKED: Option B — render PNG sequence at export time.**

| Option | Pro | Con |
|---|---|---|
| **A** PNGs at recording time | Simple at render | 3600 PNGs/min bloat recording artifacts; slow recording I/O |
| **B** PNGs at export time ✓ | Recording stays minimal; tmp-only PNGs | Adds export-time pre-processing step |
| **C** Refactor effects to JSON-aware overlay | Cleanest long-term | Touches `effects` crate AST + emit; FFmpeg `overlay` filter cannot easily express 60Hz time-varying x/y without either huge `if(between(...))` chains or external sidecar mechanisms (sendcmd, ZMQ); higher risk |

Option B chosen: minimal architectural touch, leverages existing `png_sequence_dir` plumbing, tmp PNGs auto-cleanup with the export job.

**D-2 LOCKED: Skin assets bundled in `crates/effects/assets/cursors/`.**
- 5 PNGs at design size (e.g. 32×32 or 64×64): `mac-default.png`, `win-default.png`, `dark.png`, `light.png`, `big-arrow.png`.
- Match the `CursorSkin` enum variants exported from `timeline-slice.ts` and `effects/src/ast/video.rs`.
- If skin assets don't yet exist, Plan 20-03 sources them (CC0 or in-house draw).

**D-3 LOCKED: Tmp dir layout.** Per export job: `<exports_dir>/.tmp-render-<job_id>/cursor-<clip_id>/<frame>.png`. Cleanup regardless of success / failure.

## Goal

Cursor-overlay nodes in the graph render correctly into the output MP4. After this phase, exporting a recording with auto-populated cursor track yields a video with the cursor visually overlaid at trajectory positions.

## Acceptance criteria

1. **AC1** — Render a Graph with one `cursor-overlay` VideoNode whose `trajectory.png_sequence_dir` is a `.trajectory.json` path. Output MP4 has cursor visibly overlaid at the recorded positions.
2. **AC2** — Tmp dir under `<exports_dir>/.tmp-render-<job_id>/` is created at export start, populated with rendered PNGs, and removed when the export job finishes (success or failure).
3. **AC3** — Skin asset is selected from `CursorClip.skin` (mac-default / win-default / dark / light / big-arrow). Falls back to `mac-default` if asset is missing.
4. **AC4** — `cargo check --workspace` + `cargo test -p encoder` + `cargo test -p effects` PASS. New unit tests for cursor PNG renderer.
5. **AC5** — No regression in existing export paths (recordings without cursor-overlay still encode end-to-end).

## Plan breakdown — 4 plans, sequential

### Plan 20-01 — Cursor PNG renderer module

**Scope:** Pure Rust function. No IPC, no orchestrator integration yet.

**Files:**
- NEW `crates/encoder/src/cursor_render.rs` (or `crates/effects/src/cursor/png_render.rs` — pick the closer existing namespace; effects already owns cursor skin logic in `cursor/skins.rs`, so colocate there).
- EDIT crate's `src/lib.rs` to `pub mod cursor::png_render`.

**API:**
```rust
pub fn render_cursor_pngs(
    trajectory_json: &Path,
    skin_png: &Path,
    output_dir: &Path,
) -> Result<RenderedCursorPng, CursorRenderError>;

pub struct RenderedCursorPng {
    pub png_dir: PathBuf,
    pub fps: u32,
    pub frame_count: u32,
    pub canvas_width: u32,
    pub canvas_height: u32,
}
```

**Implementation:**
- Parse trajectory JSON via `serde_json::from_str::<TrajectoryDto>`.
- Load skin PNG via `image::open` (already a workspace dep).
- For each frame `(t_ms, x, y, click)`:
  - Create blank RGBA canvas at `capture_rect.width × capture_rect.height`.
  - Composite skin PNG centered at `(x - capture_rect.x, y - capture_rect.y)`. Cursor hot-spot at top-left for default skins.
  - Write `<output_dir>/<frame_idx:06>.png`.
- Skip frames with NaN/inf/out-of-bounds x,y (log warn).
- `click=true` future hook: tint canvas / scale skin briefly. v1 ignores click.

**Tests:**
- Unit: 3-frame trajectory + 16×16 skin → 3 PNGs in output dir, dimensions match capture_rect.
- Unit: malformed JSON → CursorRenderError variant.
- Unit: missing skin file → CursorRenderError.

**Estimate:** ~45 min, 1 agent.

### Plan 20-02 — Skin asset bundle

**Scope:** Ship 5 cursor skin PNGs.

**Files:**
- NEW `crates/effects/assets/cursors/mac-default.png` (and 4 others).
- EDIT `crates/effects/src/cursor/skins.rs` — add `pub fn skin_asset_path(skin: CursorSkin) -> &'static Path` helper that returns the bundled path. Use `include_dir!` macro or `CARGO_MANIFEST_DIR` resolution.

**Asset sourcing options:**
- CC0 sources: macOS-style cursor at https://www.iconfinder.com/iconsets/cursor (license-check), or use opentape/Vecteezy CC0 set.
- In-house: draw 32×32 with arrow shape via Figma + 1px stroke.
- Use existing assets in `apps/desktop/src-tauri/icons/` as reference style.

**Tests:**
- Unit: each `CursorSkin` variant resolves to a real file with width > 0.
- Unit: file is valid PNG (`image::ImageReader::open`).

**Estimate:** ~30 min if assets exist, +1h if drawing from scratch.

### Plan 20-03 — Wire renderer into export orchestrator

**Scope:** Pre-process step before encoder runs. Must not change Graph wire format.

**Files:**
- EDIT `crates/encoder/src/export/orchestrator.rs` (or wherever `export_run_inner` lives — check Phase 18-B's commit). Add pre-process pass:
  1. Walk `graph.video[]`. For each `cursor-overlay` node:
     - If `trajectory.png_sequence_dir` ends with `.trajectory.json`, treat as JSON sidecar.
     - Resolve skin path via `skin_asset_path(node.skin)`.
     - Compute tmp dir: `exports_dir.join(format!(".tmp-render-{job_id}/cursor-{node_id}"))`.
     - Call `render_cursor_pngs(json_path, skin_path, tmp_dir)`.
     - Mutate node in-place: replace `trajectory.png_sequence_dir` with `tmp_dir`.
  2. Pass mutated graph to existing FFmpeg pipeline.
- EDIT same file: register tmp dirs in a `Drop` guard for cleanup. Failure-path safe: cleanup runs even if encoder panics.

**Risk:** Mutating Graph in-place is OK because the orchestrator owns the value. Don't propagate back via IPC.

**Tests:**
- Integration: build graph with cursor-overlay JSON path → run orchestrator pre-process → verify node's `png_sequence_dir` now points to a tmp dir with PNGs.
- Integration: orchestrator failure path → tmp dir is cleaned up.
- Existing snapshot tests (`crates/encoder/tests/`) untouched.

**Estimate:** ~45-60 min, 1 agent.

### Plan 20-04 — E2E render test

**Scope:** Verify whole path produces a valid MP4 with cursor visible.

**Files:**
- NEW `crates/encoder/tests/cursor_overlay_e2e.rs` (or similar).
- Test fixture: synthetic 30-frame trajectory JSON + 1-second 1080p test video (use existing test fixtures dir).
- Test runs full `export_run_inner` → asserts MP4 output exists, ffprobe shows correct duration + resolution.
- Optionally: pixel-diff the output MP4's middle frame against a golden image to confirm cursor rendered.

**Tests:**
- 1 E2E test: small trajectory → MP4 with cursor visible.
- Skip if FFmpeg sidecar missing in test env (gate on env var).

**Estimate:** ~45 min, 1 agent.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Skin assets need design work | Medium | +1h | Use placeholder cursor (basic arrow in code) initially; design later |
| `image` crate doesn't support PNG composite cleanly | Low | +30m | `image::imageops::overlay` works for RGBA→RGBA |
| Tmp dir cleanup races with encoder finalize | Low | data loss | Use guarded `Drop` + tracing::warn on cleanup failure |
| Capture rect (0,0,frame_w,frame_h) for window targets is wrong frame of reference | Medium | cursor offset incorrect for window captures | v1: accept; future phase wires real window-origin lookup. Document in commit. |
| FFmpeg image2 sequence input requires `-framerate` flag synced to trajectory.fps | Medium | 30fps trajectory rendered as 60fps mismatch | Verify in Plan 20-04 E2E test; fix in 20-03 if needed |

## Out of scope

- Click visualization (ripple, scale-up at click). Phase 23 wires click events, future polish phase adds visual.
- High-DPI scale: assume capture rect is already pixel-accurate.
- Multi-cursor (e.g. trajectory has both user + automation cursors).

## Estimated total

- 20-01 (renderer): 45 min
- 20-02 (assets): 30 min — 1h
- 20-03 (orchestrator): 45-60 min
- 20-04 (E2E test): 45 min
- **Total: ~2h45m — 3h30m**

Sequential execution. No parallelism within this phase (each plan depends on the prior).
