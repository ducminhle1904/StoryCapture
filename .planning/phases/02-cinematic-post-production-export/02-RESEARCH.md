# Phase 2: Cinematic Post-Production & Export - Research

**Researched:** 2026-04-14
**Domain:** Typed video filter-graph AST, WebGPU preview compositor, cursor motion math, auto-zoom planning, FFmpeg-driven final render, multi-format export
**Confidence:** MEDIUM-HIGH (HIGH on FFmpeg ecosystem + WebGPU availability; MEDIUM on exact performance math — must validate with early benchmark)

---

## Summary

Phase 2 is the cinematic polish layer. It transforms Phase 1's raw MP4 + click coords + step timings + project.sqlite into Screen Studio-grade output via a **two-engine renderer**: an interactive **WebGPU preview** (WebGL2 fallback) in the Tauri webview for 60fps scrub, and **FFmpeg sidecar** (already bundled from Phase 1 D-22..D-24) for final export. Both engines consume a single **typed filter-graph AST** from `crates/effects` — never a string. Rust pre-computes all parametric overlay data (minimum-jerk cursor trajectories, ripple keyframes, zoom keyframes, background masks) once, emits them as PNG sequences or FFmpeg filter parameters, then FFmpeg composites + encodes with HW acceleration.

The dominant risk is **not technical novelty** (FFmpeg, WebGPU, minimum-jerk math are all well-trodden) but **integration complexity and performance validation**. The twelve research areas below each have a clear prescriptive answer; the planner's job is sequencing them so EXPORT-06 (1-min/<30s) is benchmarked in Wave 0, not end-of-phase.

**Primary recommendation:** Split Phase 2 into **three waves** (not separate phases) — Wave A: effects AST + cursor/zoom math + golden-fixture tests; Wave B: WebGPU preview + FFmpeg final render bridge + PSNR snapshot; Wave C: UI editor + presets + multi-format export + benchmark. 8-12 plans. Do NOT split into two phases — the two engines share the AST and must ship together.

---

## User Constraints (from CONTEXT.md)

### Locked Decisions (D-01..D-33 — binding)

**Rendering architecture (D-01..D-04):**
- D-01: Two-engine renderer — WebGPU (primary) / WebGL2 (fallback) preview + FFmpeg final. Typed AST shared; never string-concat filtergraphs.
- D-02: Rust pre-computes parametric overlays → PNG sequences / filter-graph params → FFmpeg composites + encodes. NO custom Rust+wgpu final renderer in Phase 2.
- D-03: Scrub target = 60fps at 1080p preview; 4K may drop to 30fps. Final encode = capture-native full fidelity.
- D-04: Background render queue persisted in project.sqlite (job_id, story_id, format, status, progress). Sidecar pool N=2 configurable. Cancel + priority. Built on Phase 1 D-06 actor pattern. Progress via Tauri `Channel<T>`.

**Auto-zoom (D-05..D-07):**
- D-05: Default preset "**Dynamic**" (max 3x, dwell 500ms, min shot 1.2s, ≤10 changes/min). Ship "Calm" + "Subtle (pan-only)" as presets.
- D-06: Look-ahead offline scheduler → keyframe list → critically-damped spring low-pass filter. **Pan first, then scale in, then hold — never combine.**
- D-07: Click coords + step timings come from project.sqlite (Phase 1 capture). NO CV re-detection.

**Cursor engine (D-08..D-11):**
- D-08: **Minimum-jerk trajectory** (Flash et al. 1985, 5th-order polynomial). Sample at 60fps, pre-compute full path. Sub-pixel Perlin jitter ~0.5-1.5px.
- D-09: Bundled cursor skins (4-5): mac default, win default, dark, light, "big arrow" presentation. User controls size + color tint. Custom upload DEFERRED.
- D-10: Click ripple = anticipate 60ms + radial expand 300ms. One default style (radial gradient ring).
- D-11: Ground truth = DSL click coords; interpolate motion between clicks via minimum-jerk through waypoints.

**Timeline editor UX (D-12..D-14):**
- D-12: **5 fixed tracks**: Video / Cursor / Zoom / Sound / Annotations. User CANNOT add/remove.
- D-13: Magnetic snap default ON. Snap targets = playhead + scene boundary + neighbor clip edges. Hold **Alt** to disable. **NO ripple-edit** in Phase 2.
- D-14: Layout: Timeline bottom (~30%), Preview top-left (60%), Inspector top-right (25%), Sound browser left drawer, Export panel modal/right drawer. Panel sizes persist in Zustand.

**Undo/redo (D-15..D-17):**
- D-15: **Per-action coalesced** undo. Drag=1 step. Text edit coalesce 500ms idle. Figma/Sketch behavior.
- D-16: **In-memory ring buffer 50 steps**. Reset on reload. NOT persisted in SQLite.
- D-17: Covers: timeline ops, effect settings, preset apply/revert, text overlays, background/framing. Does NOT cover .story DSL edits (CodeMirror owns its own).

**Effects, presets, sound (D-18..D-23):**
- D-18: **Filter-graph AST = typed Rust enum tree** in `crates/effects`. Each node: serde Serialize/Deserialize + golden filter-graph snapshot tests (POST-08) + version field for preset migration.
- D-19: **Canonical filter-graph order (POST-08)**: zoom/pan → background composite → cursor overlay → ripple overlay → text/annotations overlay → transitions (xfade) → audio mix. Enforced by builder pattern, NOT string ordering.
- D-20: Presets per-project (project.sqlite) + global (app.sqlite). Export/import `.scpreset` JSON. Cloud sync DEFERRED to Phase 4. Bundle ~5 cinematic-style presets (Linear, Runway, Tella, Loom, Plain).
- D-21: Bundled sound pack ~30MB in installer (CC0/CC-BY Pixabay/Freesound + attribution.json): 10-15 SFX + 5-8 BGM. Installer budget may exceed 50MB — update PROJECT.md after measurement.
- D-22: BGM auto-duck -12dB when voiceover present (Phase 3 slot). Manual duck control in Sound inspector. Click SFX: off / subtle / pronounced.
- D-23: Background compositor: 8-12 curated gradients + user image upload (PNG/JPG validated + persisted in project folder) + rounded frame (radius / drop shadow blur+offset / padding). Logo/brand-kit DEFERRED to Phase 4.

**Scene transitions (D-24..D-25):**
- D-24: Default transitions: fade, dissolve, wipe-left, wipe-right (FFmpeg `xfade`). `xfade_opencl` feature-detected at startup; auto-enable preview if available, optional final.
- D-25: Default transition = **none**. User opt-in per scene boundary.

**Text overlay (D-26..D-27):**
- D-26: FFmpeg `drawtext` (final) + Canvas2D/WebGPU text (preview). Bundled fonts: Geist Sans, JetBrains Mono + 2-3 display fonts. Animations: fade, slide-up, scale-in.
- D-27: Step annotations auto-derive from DSL step metadata when user clicks "auto-annotate" (default off).

**Storage & state (D-28..D-29):**
- D-28: Effect AST + timeline state in project.sqlite. New tables: `timeline_state`, `effect_presets`, `effect_settings`, `render_jobs`, `sound_library_index`. Use `rusqlite_migration`.
- D-29: Snapshot fixtures for POST-08 in `crates/effects/tests/fixtures/`.

**Performance & pipeline (D-30..D-31):**
- D-30: **Smart batch reuse** — render composite once → intermediate stream → fan-out to N FFmpeg encoders (one per format). Inter-process pipe; if bottleneck, cache lossless intermediate (FFV1) in tempfile. EXPORT-04 + EXPORT-06 depend on this.
- D-31: CI benchmark job (EXPORT-06): 1-min standardized recording → batch MP4+WebM → must stay <30s on reference HW (M2 Pro / Ryzen 7 + NVENC). Fail build if exceeded.

**Frontend state (D-32..D-33):**
- D-32: Timeline state, undo stack, panel layout, selection → Zustand. Render jobs, preset list, sound library → TanStack Query over IPC. Phase 1 D-39 pattern.
- D-33: Preview player owns WebGPU/WebGL2 context lifecycle. AST changes → diff → incremental GPU resource patch (NOT full re-upload per frame).

### Claude's Discretion
- Exact xfade default duration, text-overlay easing curves.
- Gradient color palette exact values — UI plan with designer review.
- FFmpeg sidecar pool size (start 2, configurable).
- Exact sound files in bundled pack.
- Perlin jitter amplitude (0.5-1.5px range).
- Inspector panel layout detail.
- Snapping threshold pixel distance.

### Deferred Ideas (OUT OF SCOPE — do not pull back)
- AI voiceover synced to DSL steps → **Phase 3** (BGM duck slot prepared)
- LSP for DSL + NL chat → **Phase 3**
- Cloud preset sync → **Phase 4**
- Branded org-level presets (logo + brand kit) → **Phase 4**
- Web upload / embed / analytics → **Phase 4**
- Custom cursor upload / per-step cursor override → v2
- Persistent undo journal / named versions → v2
- Full per-step font customization → v2
- Multi-viewport / responsive batch export → v2
- HDR pipeline → v2
- Native Rust+wgpu final renderer → v2
- DAW-style flexible track management → anti-feature
- Real-time collaborative timeline → v2/Phase 5

---

## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| POST-01 | Typed filter-graph AST in `effects` crate | §1 Typed FFmpeg Filter-Graph AST |
| POST-02 | Auto-zoom engine from click coords | §4 Auto-Zoom Planner |
| POST-03 | Cursor overlay + ripple + minimum-jerk interpolation | §3 Cursor Trajectory |
| POST-04 | Background compositor (gradient/image + rounded window + shadow) | §7 Text + Background + Callouts |
| POST-05 | xfade scene transitions (+ optional GPU) | §5 FFmpeg xfade Catalogue |
| POST-06 | Sound mixer (click SFX + transition whoosh + BGM + ducking) | §6 Audio Mixing & Ducking |
| POST-07 | Text overlay engine (drawtext + callouts + highlight rings) | §7 Text + Callouts |
| POST-08 | Canonical filter-graph order + PSNR snapshot test | §1 AST + §9 Pipeline |
| POST-09 | Effect presets system (per-project + global) | §8 Preset System |
| EXPORT-01 | Render final polished video | §9 Multi-Format Export |
| EXPORT-02 | Multi-format MP4/WebM/GIF | §9 Multi-Format Export |
| EXPORT-03 | Resolution presets 720/1080/4K + FPS/quality | §9 Multi-Format Export |
| EXPORT-04 | Batch export to multiple formats in one run | §9 + D-30 smart reuse |
| EXPORT-05 | Background rendering + progress + continue editing | D-04 render queue |
| EXPORT-06 | 1-min video < 30s on reference HW (CI benchmark) | §12 Performance Validation |
| UI-05 | Post-Production Editor (5-track timeline + preview + presets + sound library + export) | §11 Editor UI Shape |
| UI-11 | Undo/redo for post-production | §10 Per-Action Coalesced Undo |

---

## Project Constraints (from CLAUDE.md)

- **All work MUST go through a GSD workflow** (`/gsd-execute-phase`). No direct edits outside it.
- **Tauri v2, NOT Electron.** Performance budgets binding.
- **shadcn/ui + Base UI (`base-vega`)** — NOT Radix.
- **No telemetry by default.** Recordings/projects local.
- **WCAG 2.1 AA** across all custom UI. Post-production editor must be keyboard-navigable, focus-managed, screen-reader-labelled.
- **API keys in OS keychain** (keyring plugin) — not relevant Phase 2 directly, but if any future license-check surface is added, respect.
- **Installer budget < 50MB excl. FFmpeg** (D-21 may require PROJECT.md update — flag it).
- **Performance:** 1-min → <30s render on reference HW (EXPORT-06).

---

## Standard Stack

### Core (Rust)

| Crate | Version | Purpose | Why Standard | Verification |
|-------|---------|---------|--------------|--------------|
| `ffmpeg-next` | 7.1.x | Safe libavfilter/libavformat bindings for AST→Graph construction (optional — see §1 tradeoff) | Most maintained Rust FFmpeg wrapper; provides typed `filter::Graph::add/parse/validate` API | [CITED: docs.rs/ffmpeg-next] |
| `ffmpeg` sidecar | 7.1 static universal | Final encode, xfade, drawtext, amix, palettegen | Already built in Phase 1 D-22..D-24 — reuse | [VERIFIED: Phase 1 CONTEXT D-22] |
| `serde` / `serde_json` | 1.x | AST serde (snapshot tests + `.scpreset` export) | Phase 1 standard | [VERIFIED: STACK.md] |
| `insta` | 1.x | Golden snapshot tests (canonical filter-graph string output) | Already used in Phase 1 for DSL parser | [VERIFIED: STACK.md] |
| `rusqlite` + `rusqlite_migration` | 0.33.x / 1.3.x | Add tables (timeline_state, effect_presets, effect_settings, render_jobs, sound_library_index) | Phase 1 D-27 | [VERIFIED: Phase 1] |
| `image` | 0.25.x | PNG sequence emit for cursor/ripple/background pre-rendered overlays | Already in STACK.md | [VERIFIED: STACK.md] |
| `rayon` | 1.x | Parallelize per-frame overlay pre-computation | STACK.md standard | [VERIFIED: STACK.md] |
| `hound` | 3.5.x | WAV decode/encode for bundled SFX if we need per-step splicing outside FFmpeg | Small, pure Rust | [CITED: crates.io/crates/hound] |
| `ts-rs` / `specta` | — | Mirror AST types to TS for frontend inspector editing | Phase 1 D-10 | [VERIFIED: Phase 1] |

### Core (Frontend)

| Package | Version | Purpose | Why Standard | Verification |
|---------|---------|---------|--------------|--------------|
| `@webgpu/types` | latest | TS WebGPU types (Chrome 113+ / webview) | Canonical WebGPU typing | [VERIFIED: npm] |
| wgsl (inline shaders) | — | Shaders for cursor/ripple/zoom compositor | Standard for WebGPU | [CITED: W3C WebGPU spec] |
| `wavesurfer.js` | 7.x | Sound library waveform previews | De facto standard waveform component | [CITED: wavesurfer-js.org] |
| `@tanstack/react-virtual` | 3.x | Virtualize long clip/preset lists in timeline | Standard for perf | [CITED: tanstack.com] |
| `motion/react` | 12.x | UI micro-interactions in editor (NOT video animation) | Phase 1 D-35 | [VERIFIED: Phase 1] |
| `react-hotkeys-hook` | 4.x | Keyboard shortcuts (cmd+z/shift+z, space=play, delete=remove clip) | De facto React hotkeys | [CITED: npm] |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Our own typed AST (D-18) | `ffmpeg-next` Graph directly as AST | ffmpeg-next Graph is a runtime object, not serializable, can't snapshot-test POST-08 fixtures — **D-18 requires typed AST**. Use ffmpeg-next only as optional in-process build target; primary path emits filter_complex string to sidecar. |
| PNG sequence overlay for cursor | FFmpeg `drawtext`+`overlay` procedural | PNG sequence is 60fps × 60s × small = ~3600 tiny PNGs, but gives shader-driven fidelity unattainable in pure drawtext. **Go PNG sequence** for cursor, `drawtext` for text. |
| WebGPU primary preview | WebGL2 only | WebGPU lets us share compute for zoom/cursor/ripple in one pass; WebGL2 fallback is for older webviews only. D-01 requires both. |
| `ffmpeg-gl-transition` bundle | FFmpeg `xfade` CPU + optional `xfade_opencl` | ffmpeg-gl-transition adds 30+MB plugin with separate GLSL runtime; `xfade_opencl` ships in FFmpeg 7 already. D-24 chose `xfade_opencl`. |

**Installation:** No new npm adds beyond `@webgpu/types`, `wavesurfer.js`, `react-hotkeys-hook`, `@tanstack/react-virtual`. Rust side adds `ffmpeg-next` (optional) + `hound`. Bundled sound pack is an asset drop, not a package.

**Version verification note:** Before Wave A kickoff, run `npm view wavesurfer.js version`, `npm view @webgpu/types version`, `cargo info ffmpeg-next` to capture current versions — training data may be 3-6 months stale.

---

## Architecture Patterns

### Recommended Crate Layout (extends Phase 1)

```
crates/
├── effects/                   # Phase 2 PRIMARY crate — typed filter-graph AST + pre-compute
│   ├── src/
│   │   ├── ast/               # Typed node enums (VideoNode, AudioNode, OverlayNode, ...)
│   │   ├── builder/           # Fluent builder enforcing canonical order (POST-08)
│   │   ├── emit/              # AST → filter_complex string + input/output labelling
│   │   ├── cursor/            # Minimum-jerk trajectory sampler + PNG sequence emit
│   │   ├── zoom/              # Look-ahead planner + critically-damped spring smoothing
│   │   ├── ripple/            # Click-anticipation + radial expand keyframes
│   │   ├── background/        # Gradient presets + mask/rounded-frame compositor
│   │   ├── text/              # drawtext param builder + callout box geometry
│   │   ├── audio/             # amix + sidechaincompress graph builders
│   │   └── preset/            # .scpreset serde + migration by version field
│   └── tests/
│       ├── fixtures/          # POST-08 golden filter-graph strings + PSNR reference frames
│       └── snapshot.rs        # insta snapshots
├── encoder/                   # Phase 1 — extended with render queue actor
│   ├── src/
│   │   ├── queue/             # Persistent job queue (project.sqlite-backed, D-04)
│   │   ├── pool/              # Sidecar pool (N=2 configurable)
│   │   ├── fanout/            # Smart batch reuse: composite once → N encoders (D-30)
│   │   └── hw_probe/          # Phase 1 detector — re-used for per-format encoder choice
│   └── ...
└── storage/                   # Phase 1 — extended with v2 migrations
    └── migrations/v2/         # timeline_state, effect_presets, effect_settings, render_jobs, sound_library_index
```

```
apps/desktop/src/
├── features/
│   └── post-production/       # UI-05 surface
│       ├── components/
│       │   ├── timeline/      # 5-track timeline (D-12), snapping (D-13)
│       │   ├── preview/       # WebGPU/WebGL2 player owns GPU context lifecycle (D-33)
│       │   ├── inspector/     # Effect/preset editor
│       │   ├── sound-browser/ # Waveform-preview drawer
│       │   └── export-panel/  # Modal / right drawer
│       ├── shaders/           # WGSL + GLSL fallback
│       ├── state/             # Zustand slices (timeline, undo, panels)
│       └── hooks/             # useInvoke(render), useChannel(progress), useUndo
└── shaders/                   # Shared shader loader + feature detection
```

### Pattern 1: Typed AST with Builder Enforcing Canonical Order (POST-08)

**What:** Rust enum tree where each constructor represents a filter node. A fluent builder exposes only methods that preserve the canonical order (D-19): zoom → background → cursor → ripple → text → transitions → audio. Builder state machine prevents "cursor before zoom" in the type system.

**Why:** Free compile-time POST-08 enforcement. Snapshot tests (insta) pin the emitted filter_complex string; drift fails CI.

**Sketch:**
```rust
// crates/effects/src/ast/mod.rs
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub enum VideoNode {
    Source { path: PathBuf, pts_offset: Duration },
    ZoomPan { target: ZoomTarget, keyframes: Vec<ZoomKeyframe> },
    Background { kind: BackgroundKind, radius_px: f32, shadow: Option<Shadow> },
    CursorOverlay { skin: CursorSkin, trajectory: TrajectoryRef }, // TrajectoryRef points to PNG seq
    RippleOverlay { events: Vec<RippleEvent> },
    TextOverlay { boxes: Vec<TextBox> },
    Transition { kind: XfadeKind, duration_ms: u32, offset_ms: u32 },
}

// Canonical order builder
pub struct GraphBuilder<S: State> { /* phantom state */ }
impl GraphBuilder<NeedSource> {
    pub fn source(self, path: PathBuf) -> GraphBuilder<CanZoom> { ... }
}
impl GraphBuilder<CanZoom> {
    pub fn zoom(self, zp: ZoomPan) -> GraphBuilder<CanBackground> { ... }
    pub fn skip_zoom(self) -> GraphBuilder<CanBackground> { ... }
}
// ... etc., each state only offers next-in-order methods
```

**Alternative (simpler):** runtime Vec<VideoNode> with a `validate_canonical_order()` fn. Faster to write, less compile-time safety. **Recommendation:** start with runtime validation + insta golden fixtures (sufficient for POST-08); upgrade to typestate builder only if regressions occur.

### Pattern 2: AST → Dual Emitter (filter_complex string + WebGPU render plan)

**What:** Two `impl Emit for GraphBuilder` implementations:
1. `FfmpegEmit` → canonical `-filter_complex "..."` string with consistent `[vN]` / `[aN]` labels
2. `PreviewEmit` → JSON render plan (zoom matrices per frame, cursor PNG list, ripple keyframes, text box geometry) consumed by WebGPU preview player

**Why:** Single source of truth. Preview and export cannot drift.

### Pattern 3: Render Queue Actor Persisted in project.sqlite

**What:** tokio mpsc actor reads pending jobs from `render_jobs` table on start. Each job: FFmpeg sidecar child + `Channel<RenderProgress>` to UI. Cancel = mpsc signal + child kill. Priority = ORDER BY in the job poll. N=2 concurrent.

**Why:** D-04 requires resume-on-relaunch. Matches Phase 1 D-06 actor pattern.

### Pattern 4: WebGPU Preview Pipeline

**What:** One `GPUCommandEncoder` per frame. Passes:
1. Upload `VideoFrame` (from `<video>` element or `VideoDecoder`) as `GPUExternalTexture`
2. Compute pass — zoom transform matrix
3. Render pass — composite: background → video (with rounded mask) → cursor PNG lookup → ripple SDF circle → text atlas
4. Blit to canvas

**WebGL2 fallback:** Single fragment shader with multiple uniforms; slower but covers any webview without WebGPU.

**Feature detection:** `'gpu' in navigator && await navigator.gpu.requestAdapter()` — if null, route to WebGL2.

### Anti-Patterns to Avoid

- **String-concat filtergraphs.** Violates D-18, breaks POST-08. **Always AST-first.**
- **Simultaneous scale + pan keyframes.** Pitfall #5; D-06 forbids. Sequence: pan → scale in → hold.
- **Per-frame AST re-upload to GPU.** D-33: diff + patch incrementally.
- **Frame-count bounded queue.** 4K60 BGRA × 60 = ~1.5GB. Use byte budget (Phase 1 D-19 already established).
- **Custom Rust+wgpu final renderer.** D-02 explicitly deferred.
- **Ripple fires on click event.** Must anticipate 60ms before (D-10; Pitfall #4).

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Video decoding for preview scrub | Custom MP4 demuxer | HTML `<video>` with `seekable` + `currentTime`, optionally WebCodecs `VideoDecoder` for frame-accurate scrub | Browser ships it; WebCodecs gives per-frame `VideoFrame` for `copyExternalImageToTexture` into WebGPU |
| Waveform rendering | Custom canvas rendering | `wavesurfer.js` 7.x | Handles peaks pre-compute, zoom, region selection, streaming |
| xfade transitions | Custom GLSL transition library | FFmpeg `xfade` (44 transitions built-in) + `xfade_opencl` for GPU | [VERIFIED: FFmpeg 7.1 docs] covers fade/dissolve/wipe/slide/circle/... |
| Palette generation for GIF | Custom quantizer | FFmpeg `palettegen` + `paletteuse` (2-pass) | De-facto GIF pipeline |
| Audio ducking | Manual amplitude envelope | FFmpeg `sidechaincompress` | 1-filter solution, producer-grade |
| BGM mixing | Custom mixer | FFmpeg `amix=inputs=N:duration=longest` | Standard |
| Minimum-jerk math | Spline library | Direct 5th-order polynomial (~10 LoC) | Smaller than any dep |
| Cursor interpolation | CV-based smoothing | Flash/Hogan 1985 minimum-jerk over KNOWN click waypoints | We own coords (D-07); CV is wasted |
| Timeline DOM math | Custom drag/drop | shadcn/Base UI + `@dnd-kit/core` for track reordering (within fixed 5-track display limits) | Scope is minimal (no add/remove tracks) — dnd-kit is optional |
| Text shaping / RTL | Custom | FFmpeg `drawtext` with `text_align` + bundled fonts | Sufficient for v1 |
| Undo coalescing | Custom timer logic | Just `lodash.debounce` (or `use-debounce`) around dispatch + ring buffer | Trivially small |
| Sound library licensing | Hunt each file | Pixabay + Freesound CC0/CC-BY bulk | attribution.json shipped in `assets/sound-library/` |

**Key insight:** Phase 2 is 90% composition of mature FFmpeg + WebGPU primitives. Every "custom" build is a red flag — the work is *orchestration*, not *invention*.

---

## Common Pitfalls

### Pitfall 1: Filter-Graph Label Collisions

**What goes wrong:** Hand-managed `[v0][v1][audio]` labels collide when user adds scenes.
**Why:** AST → string emission lacks unique naming.
**Avoid:** Emitter generates labels from stable node IDs (UUID or monotonic counter); golden fixture diffs catch drift.
**Warning signs:** FFmpeg error "Output pad already in use" or "No such filter output."

### Pitfall 2: Auto-Zoom Motion Sickness (Pitfall #5 from research)

Covered by D-05..D-07. Key: dwell debounce 500ms, min shot 1.2s, max 3x, ≤10 changes/min, pan-then-scale never simultaneous, low-pass with critically-damped spring.
**Warning signs:** Zoom heatmap shows clusters <500ms apart; internal QA reports nausea.

### Pitfall 3: Cursor Uncanny Valley (Pitfall #4 from research)

Covered by D-08..D-11. Key: minimum-jerk + ~1px Perlin jitter + ripple anticipation 60ms.
**Warning signs:** A/B test vs human reference shows "feels automated."

### Pitfall 4: WebGPU Unavailable in Webview

**What goes wrong:** Older Tauri webview on Windows (WebView2 runtime behind) or Linux builds (not in scope v1, but...) lack WebGPU.
**Avoid:** Feature-detect at mount; render WebGL2 path. Ship both shader sets. Chromium 113+ has WebGPU [CITED: web.dev/blog/webgpu-supported-major-browsers], WebView2 typically 2-4 weeks behind.
**Warning signs:** `navigator.gpu` undefined; log + auto-switch to WebGL2 without UI interruption.

### Pitfall 5: WebCodecs `VideoFrame` Not Closed

**What goes wrong:** `VideoFrame` must be `.close()`-d after use — leaked frames crash the preview pipeline within ~30s.
**Avoid:** Wrap every `VideoFrame` acquisition in `try { ... } finally { frame.close(); }`.
**Warning signs:** "Cannot allocate VideoFrame" errors; memory climbs during scrubbing.

### Pitfall 6: xfade Offset Miscalculation

**What goes wrong:** Chained transitions drift because offset doesn't account for previous transition duration.
**Why:** `offset = sum(clip_durations_before) - sum(transition_durations_before)` — easy to miscount. [CITED: ottverse.com xfade guide]
**Avoid:** Centralize timing math in one `XfadeTimeline` builder that accepts a clip list + transition list and returns per-transition offsets.
**Warning signs:** Transitions start late / overlap wrong / cut to black.

### Pitfall 7: GIF Palette Flicker

**What goes wrong:** Single-pass GIF encode produces flickering colors frame-to-frame.
**Avoid:** Always 2-pass: `palettegen` → `paletteuse` with `dither=bayer:bayer_scale=5:diff_mode=rectangle`.
**Warning signs:** GIF looks fine at first frame but dances.

### Pitfall 8: drawtext Font Loading

**What goes wrong:** `fontfile=/path/with spaces/Geist.ttf` fails on Windows due to colon/path escaping.
**Avoid:** Copy bundled fonts to no-space temp path OR use `font=Geist Sans` with system font-config (unreliable cross-platform). Recommend: **resolve font path at runtime to a Rust-owned temp dir, always forward slashes, quote for filter expression**.
**Warning signs:** FFmpeg error "Could not load font."

### Pitfall 9: amix Volume Clipping

**What goes wrong:** Mixing BGM + SFX + voiceover via `amix` defaults to `avg` = everything sounds muffled; or `normalize=0` produces clipping when peaks align.
**Avoid:** Pre-scale each input with `volume=` filter before `amix=inputs=N:duration=longest:normalize=0`, then `alimiter=limit=0.95` as safety.
**Warning signs:** Peak meter hits 0 dBFS and stays clipped.

### Pitfall 10: A/V Drift on Long Videos (Pitfall #6 from research)

Covered by Phase 1 D-21 (single clock source). Phase 2 must NOT rewrite PTS when inserting overlays. Use `setpts=PTS` passthrough.

### Pitfall 11: project.sqlite Schema Drift Between Phase 1 and Phase 2

**What goes wrong:** User opens a Phase 1-created project in Phase 2 build; new tables missing.
**Avoid:** `rusqlite_migration` v2 migration, run on open (D-28). Prompt user before migrating (data is portable per D-28 Phase 1).
**Warning signs:** `no such table: timeline_state`.

### Pitfall 12: Background Render Queue Lost After Crash

**What goes wrong:** User closes app mid-render; no resume.
**Avoid:** D-04 — persist job rows BEFORE spawning sidecar; update `status` on start/progress/complete/fail. On startup, mark orphaned `status='running'` rows as `status='interrupted'` and offer resume.

---

## Code Examples

### 1. Minimum-Jerk Trajectory (Flash & Hogan 1985)

```rust
// crates/effects/src/cursor/min_jerk.rs
// Source: Flash & Hogan 1985, "The Coordination of Arm Movements"
// 5th-order polynomial between waypoints; duration T, positions p0 → p1.

pub fn min_jerk_sample(p0: Vec2, p1: Vec2, t: f32, duration: f32) -> Vec2 {
    let tau = (t / duration).clamp(0.0, 1.0);
    // x(τ) = x0 + (x1 - x0) * (10τ³ - 15τ⁴ + 6τ⁵)
    let s = 10.0 * tau.powi(3) - 15.0 * tau.powi(4) + 6.0 * tau.powi(5);
    p0 + (p1 - p0) * s
}

pub fn sample_path(waypoints: &[Waypoint], fps: u32) -> Vec<Vec2> {
    let dt = 1.0 / fps as f32;
    let mut out = Vec::new();
    for win in waypoints.windows(2) {
        let (a, b) = (win[0], win[1]);
        let seg = b.t - a.t;
        let n = (seg * fps as f32) as usize;
        for i in 0..n {
            out.push(min_jerk_sample(a.pos, b.pos, i as f32 * dt, seg));
        }
    }
    out
}
```

### 2. Critically-Damped Spring for Zoom Smoothing

```rust
// crates/effects/src/zoom/spring.rs
// Standard critically-damped spring; no oscillation, smoothest approach.
pub struct Spring { pos: f32, vel: f32, target: f32, omega: f32 }
impl Spring {
    pub fn step(&mut self, dt: f32) {
        let f = -2.0 * self.omega * self.vel - self.omega.powi(2) * (self.pos - self.target);
        self.vel += f * dt;
        self.pos += self.vel * dt;
    }
}
// omega ≈ 2π / time_to_settle. For zoom, use ~0.8-1.2s settle → omega ≈ 5-7.
```

### 3. FFmpeg xfade Chained Offsets

```
# Source: https://ottverse.com/crossfade-between-videos-ffmpeg-xfade-filter/
# Three clips: a (10s), b (10s), c (10s); transition duration 1s.
# offset_0 = 10 - 1 = 9
# offset_1 = (9 + 10) - 1 = 18  (relative to start of concat output)

[0:v][1:v]xfade=transition=fade:duration=1:offset=9[v01]
[v01][2:v]xfade=transition=fade:duration=1:offset=18[vout]
```

### 4. Auto-Zoom Planner (High-Level Algorithm)

```
Input: List<Waypoint { t, x, y, kind }>  // from project.sqlite
Output: List<ZoomKeyframe { t, center, scale, easing }>

1. Cluster waypoints by spatial proximity (< 200px) and time (< 800ms) — one cluster = one "target of interest"
2. For each cluster:
   a. If cluster duration < min_shot (1.2s): merge with previous or skip
   b. Compute center = centroid; scale = min(3.0, viewport_w / cluster_bbox_w * padding)
3. Enforce ≤10 zoom changes/min — if exceeded, drop lowest-importance clusters (click > hover)
4. For each transition between clusters:
   a. Phase 1: pan from prev_center → new_center at prev_scale (duration 400ms ease-in-out)
   b. Phase 2: scale from prev_scale → new_scale at new_center (duration 600ms)
   c. Phase 3: hold until next cluster
5. Pass full keyframe list through critically-damped spring smoother (omega ≈ 6)
```

### 5. WebGPU Feature Detection + Fallback

```typescript
// apps/desktop/src/features/post-production/preview/gpu.ts
export async function initPreviewContext(canvas: HTMLCanvasElement): Promise<PreviewCtx> {
  if ('gpu' in navigator) {
    const adapter = await navigator.gpu.requestAdapter();
    if (adapter) {
      const device = await adapter.requestDevice();
      return { kind: 'webgpu', device, ctx: canvas.getContext('webgpu')! };
    }
  }
  const gl = canvas.getContext('webgl2');
  if (!gl) throw new Error('Neither WebGPU nor WebGL2 available — preview unsupported');
  return { kind: 'webgl2', gl };
}
```

### 6. WebCodecs Frame-Accurate Scrub

```typescript
// Decode to target PTS for frame-accurate preview scrub
const decoder = new VideoDecoder({
  output: (frame) => {
    try {
      renderer.uploadExternalTexture(frame); // GPUExternalTexture or texImage2D
    } finally {
      frame.close(); // CRITICAL — see Pitfall #5
    }
  },
  error: (e) => console.error(e),
});
decoder.configure({ codec: 'avc1.640028' });
// Feed keyframe + delta chunks up to target timestamp
```

### 7. BGM Ducking with sidechaincompress

```
# BGM ducks under voiceover automatically
[1:a]asplit=2[vo_out][vo_sidechain]
[0:a][vo_sidechain]sidechaincompress=threshold=0.05:ratio=8:attack=50:release=500[ducked_bgm]
[ducked_bgm][vo_out]amix=inputs=2:duration=longest:normalize=0,alimiter=limit=0.95[aout]
```

### 8. GIF Export (2-pass)

```
ffmpeg -i in.mp4 -filter_complex "[0:v]fps=15,scale=720:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=full[p];[b][p]paletteuse=dither=bayer:bayer_scale=5" out.gif
```

---

## Twelve Research Areas (Deep Dives)

### §1 Typed FFmpeg Filter-Graph AST

**Decision:** **Build our own minimal typed AST** (D-18). Do NOT adopt `ffmpeg-next::filter::Graph` as the primary AST because it's a runtime object (libavfilter handle) — not serializable, can't snapshot-test, can't ship in `.scpreset`.

**Recommended shape:**
- `enum VideoNode` / `enum AudioNode` with serde
- Fluent builder with runtime validator for canonical order (upgrade to typestate only if regressions)
- `impl Emit` produces deterministic filter_complex string (stable label generation from node UUIDs)
- `tests/fixtures/*.filter_complex.snap` via insta for POST-08

**Alternatives surveyed:**
- `ffmpeg-next` 7.1.x — useful as in-process BUILDER if we ever need libavfilter native (e.g., preview pipeline without spawning process). Keep as optional backend. [CITED: docs.rs/ffmpeg-next]
- `rust-ffmpeg-cli-wrapper` — just shells out; gives no AST. Reject.
- OBS filter-graph pattern — C++ abstraction over libavfilter; instructive but not adoptable.

**Code sketch:** See "Code Examples §1 + Pattern 1" above.

**Pitfalls:** label collisions (Pitfall #1), canonical order drift (mitigate with insta + canonical builder).

**Open questions:** Do we need a separate `AudioGraph` + `VideoGraph` or unify? **Recommendation:** separate — audio graph has very different structure (amix trees, sidechain); unifying adds complexity.

**Plan-split implication:** §1 is foundational. Must ship in **Wave A**, plan 1.

### §2 WebGPU Preview Renderer in Webview

**Browser support (2026):** WebGPU ships in Chrome/Edge 113+ (May 2023), Firefox 145 on macOS ARM64 (Nov 2025), Safari/macOS Tahoe 26 / iOS 26. [CITED: web.dev/blog/webgpu-supported-major-browsers] Tauri uses WebView2 on Windows (Chromium-based, typically current within weeks) and WKWebView on macOS (WebGPU from Tahoe 26).

**Fallback:** WebGL2 — universal support on both webviews.

**Frame-accurate scrub strategy:**
- **Primary:** `<video>` element with `requestVideoFrameCallback()` + `currentTime` set + poll for `seeked` event. Simpler but ~10-30ms seek granularity.
- **Precision:** `VideoDecoder` (WebCodecs) — decodes individual chunks, emits `VideoFrame` per-frame. Requires demuxing (use `mp4box.js` or Tauri IPC to Rust demux). Gives exact PTS. [CITED: developer.chrome.com WebCodecs].

**Recommendation:** Ship `<video>` element baseline in Wave B; upgrade to WebCodecs only if scrub precision feedback demands it.

**Compositing strategy (WebGPU):**
```
Frame N input: GPUExternalTexture (from VideoFrame) + preview plan (zoom matrix, cursor PNG index, ripple list, text boxes)
Pass 1 (compute): apply zoom/pan transform → intermediate texture at output resolution
Pass 2 (render): background texture → composite video (with rounded-corner SDF mask) → cursor PNG lookup (atlas with N skins × K sizes) → ripple SDF circles (instanced) → text atlas rendering
Pass 3: present to canvas
```

**Time-sync audio:** `<audio>` element with `currentTime` slaved to `<video>.currentTime` OR use `AudioContext` + `AudioBufferSourceNode` for exact sample-accurate playback during scrub. **Recommendation:** `<audio>` (simpler) for scrub; upgrade to WebAudio only if sync feedback demands.

**Performance baseline (unvalidated — must benchmark early):** 1080p60 compositing should be <5ms/frame on M2 / RTX 3060 with WebGPU. WebGL2 fallback ~10-15ms.

**Pitfalls:** WebGPU unavailable (Pitfall #4), VideoFrame leak (Pitfall #5), context loss on webview navigate (re-init on mount).

**Open question:** Do we share the WebGPU device across preview + any other GPU feature? **Recommendation:** Single device owned by Preview component (D-33); release on unmount.

**Plan-split implication:** §2 is Wave B, plan 3-4. Complex enough to warrant its own plan.

### §3 Minimum-Jerk Cursor Trajectory

**Algorithm:** 5th-order polynomial per segment (Flash & Hogan 1985):
`s(τ) = 10τ³ - 15τ⁴ + 6τ⁵`, `τ ∈ [0,1]`
Position: `p(t) = p0 + (p1 - p0) * s(τ)` where `τ = t/T`.

Time derivatives (for velocity caps): `v(τ) = (p1-p0)/T * (30τ² - 60τ³ + 30τ⁴)` peaks at τ=0.5.

**Direction reversals:** If consecutive segments have angle > 135°, insert a 80-120ms pause between them (no human reverses instantly). Fires `CursorPause` event for rendering (optional idle-cursor skin).

**Dwells:** After a click, hold cursor at target for `min(200ms, time_to_next_waypoint)` to feel deliberate.

**Velocity caps:** If computed peak velocity exceeds ~2500 px/s at 1080p, lengthen segment duration (max cursor speed observation from Rekort + Pitfall #4 research).

**Rendering:**
- **Recommended:** Pre-computed PNG sequence at 60fps, named `cursor_000000.png`..`cursor_NNNNNN.png`, piped to FFmpeg `overlay` with `enable=between(t,0,END)` per scene. Simpler than shader; deterministic; cacheable.
- **Alternative (future):** WGSL shader that reads trajectory buffer + samples SDF cursor — deferred to v2 per D-02.

**Click ripple schema:**
```rust
struct RippleEvent {
    t_anticipate: Duration, // click_time - 60ms (D-10)
    t_impact: Duration,     // click_time
    duration: Duration,     // 300ms (D-10)
    center: Vec2,
    max_radius: f32,        // default 60px @ 1080p
    color: Rgba,            // default white 0.9 alpha
}
```
Render as radial gradient PNG overlay with alpha decay: `alpha(t) = (1 - t/duration)²`.

**Perlin jitter:** 2D Perlin noise, amplitude 0.5-1.5px (Claude's discretion), frequency ~2Hz. Add to trajectory samples post-hoc.

**Plan-split implication:** Wave A, plan 2. Testable in isolation (snapshot golden PNG sequence).

### §4 Auto-Zoom Planner

**Algorithm (D-06 look-ahead):** See "Code Examples §4".

**Parameter map (D-05 defaults = Dynamic):**
| Param | Dynamic | Calm | Subtle (pan-only) |
|-------|---------|------|-------------------|
| Max zoom | 3.0 | 2.2 | 1.0 (fixed) |
| Dwell debounce | 500ms | 800ms | 800ms |
| Min shot length | 1.2s | 2.0s | 2.0s |
| Max changes/min | 10 | 6 | 6 |
| Pan duration | 400ms | 600ms | 600ms |
| Scale-in duration | 600ms | 800ms | n/a |

**Low-pass filter:** Critically-damped spring (see Code Example §2), omega ≈ 6 (≈1s settle).

**Waypoint consumption:** Read `steps` table from project.sqlite (Phase 1 capture schema). Each step has `t_ms`, `x`, `y`, `kind ∈ {click, hover, scroll, type, ...}`. Weights: click=1.0, hover=0.4, type=0.7 (zoom to input), scroll=0.2.

**Direction reversals:** Detect when next cluster is in opposite quadrant; insert extra 200ms pan holding-frame to avoid whip-pan.

**Energy-minimizing alternative:** treat sequence as min-path problem weighted by (visual importance × transition cost). Overkill for v1. State machine + spring smoother is sufficient.

**Pitfalls:** motion sickness (Pitfall #2 above + research Pitfall #5), simultaneous pan+scale (D-06 forbids).

**Plan-split implication:** Wave A, plan 2 (bundle with cursor math — both share trajectory primitives).

### §5 FFmpeg xfade Transitions Catalogue

**Default set (D-24):** fade, dissolve, wipeleft, wiperight.

**Full xfade catalogue (FFmpeg 7.1):** fade, fadeblack, fadewhite, fadegrays, distance, wipeleft, wiperight, wipeup, wipedown, slideleft, slideright, slideup, slidedown, circlecrop, rectcrop, circleclose, circleopen, horzclose, horzopen, vertclose, vertopen, diagbl, diagbr, diagtl, diagtr, hlslice, hrslice, vuslice, vdslice, dissolve, pixelize, radial, hblur, wipetl, wipetr, wipebl, wipebr, squeezeh, squeezev, zoomin, fadefast, fadeslow. [CITED: ffmpeg.org filters doc 7.1]

**xfade offset/duration math:**
- `duration`: transition length in seconds
- `offset`: when transition starts, relative to start of first input
- Chained formula: `offset_N = cumulative_clip_duration[N] - cumulative_transition_duration[N]` [CITED: ottverse.com]

**Recommended exposed set for UI (Wave C):** fade, dissolve, wipe (×4 directions), slide (×4 directions), circleopen, circleclose = 11 transitions. Rest available via "custom" power-user field.

**GPU acceleration:** `xfade_opencl` (FFmpeg ≥5.0) supports a subset (fade, dissolve, wipe*, slide*). D-24: feature-detect at startup (`ffmpeg -filters | grep xfade_opencl`); enable for preview auto, optional for final. If OpenCL runtime flaky on target platform → silent CPU fallback.

**`ffmpeg-gl-transition` bundling:** NOT recommended. Adds GLSL runtime + 30+MB plugin; xfade + xfade_opencl cover 90% of desired transitions. Defer to v2 if users demand GL-transitions library's specific effects (e.g., "Directional").

**Plan-split implication:** Wave B, plan 5 (bundled with xfade wiring + sound mixing).

### §6 Audio Mixing and Ducking

**Graph sketch:**
```
Inputs:
  [0:a] = captured audio (from Phase 1 recording — may be silent)
  [1:a] = BGM track (selected from sound library)
  [2:a]..[N:a] = per-step click SFX + transition whooshes (spliced via adelay + amerge)

Filter:
  [1:a] volume=0.4 [bgm_raw]
  [vo_audio] = (Phase 3 voiceover slot) or silence
  [bgm_raw][vo_audio] sidechaincompress=threshold=0.08:ratio=8:attack=80:release=400 [ducked_bgm]
  [ducked_bgm][vo_audio][sfx_mix] amix=inputs=3:duration=longest:normalize=0 [mix_raw]
  [mix_raw] alimiter=limit=0.95 [aout]
```

**Click SFX splicing:** For each DSL click step at time `t_ms`, pick sound: `[click_N] adelay={t_ms}|{t_ms}` to align. Merge all delayed SFX with `amix`.

**Volume envelope automation:** FFmpeg `volume` filter supports expressions: `volume='if(between(t,5,6),0.5,1.0)'`. For more elaborate curves use `volume=weights=...` or pre-render envelope as PCM and mix.

**Bundled sounds (D-21):** 
- SFX (10-15): click-subtle, click-pronounced, hover-tick, whoosh-short, whoosh-long, pop, tap-click, soft-click, ding, scroll-tick, transition-slide, transition-fade-in, transition-fade-out (selection TBD).
- BGM (5-8): lo-fi-loop, corporate-gentle, upbeat-light, ambient-warm, ambient-cool, cinematic-rise, tech-pulse, indie-soft.
- **Sources:** Pixabay Music (CC0, no attribution required); Freesound (filter by CC0 for SFX); Mixkit (free for commercial, no attribution). Licensing: bundle a JSON manifest with per-file license + source URL + author (if CC-BY). Generate attribution.txt in About dialog.

**Plan-split implication:** Wave B, plan 5 (bundle with transitions — both are FFmpeg-graph concerns).

### §7 Text Overlay and Callout Boxes

**Engine split (D-26):**
- Final: FFmpeg `drawtext` per box.
- Preview: Canvas2D (for simplicity) or WGSL text atlas (for 60fps under many boxes).

**`drawtext` basics:**
```
drawtext=fontfile=/tmp/fonts/Geist.ttf:text='Step 3\: Click Save':x=100:y=50:fontcolor=white:fontsize=32:box=1:boxcolor=0x00000080:boxborderw=12:line_spacing=4:enable='between(t,5,9)'
```

**Multi-line:** use `\n` or separate drawtext with incrementing `y`.

**RTL:** `drawtext` text_shaping requires `libharfbuzz` + `libfribidi` linked into FFmpeg. Our LGPL static build must include these — add to Phase 1 `scripts/build-ffmpeg/` recipe (flag for Wave 0 verification).

**Callout boxes with arrow/pointer:** `drawtext` can't do shapes. **Recommendation:** pre-render callout box as PNG in Rust (using `image` + `imageproc`) per unique callout text+size; overlay with `overlay` filter. Box = rounded rect + optional triangle arrow from known element coords.

**Highlight ring around element:** Given known element bbox from DSL step + Phase 1 capture, render `image` → PNG → overlay with `enable` range. Animation: pulse via alpha expression on `overlay`: `alpha='0.5+0.5*sin(2*PI*(t-5))'`.

**Animation presets (3):**
| Preset | In | Hold | Out |
|--------|-----|------|-----|
| fade | alpha 0→1 300ms | 1.5s min | alpha 1→0 300ms |
| slide-up | y+40→y, alpha 0→1 350ms | 1.5s | translate y→y-20 + fade 300ms |
| scale-in | scale 0.8→1 + fade | 1.5s | fade 300ms |

**Auto-annotate (D-27):** Off default. When on, use DSL step `comment` or synthesize from verb (`Click "Save"` → "Click Save button").

**Pitfalls:** font path (Pitfall #8).

**Plan-split implication:** Wave B, plan 6 (bundle with background compositor — both are overlay concerns).

### §8 Preset System

**`.scpreset` JSON schema:**
```json
{
  "version": 2,
  "kind": "effect_preset",
  "name": "Runway Cinematic",
  "description": "...",
  "bundled": true,
  "ast": { /* VideoGraph + AudioGraph serialized */ },
  "metadata": {
    "author": "StoryCapture",
    "created_at": "2026-...",
    "tags": ["cinematic", "marketing"]
  }
}
```

**Version migration:** `rusqlite_migration` for the `effect_presets` table schema; **preset content migration** by `version` field — each preset type has a `fn migrate(v: u32, raw: Value) -> Result<Ast>`. Old fixtures stored for regression.

**Scope (D-20):** per-project (project.sqlite.effect_presets) + global (app.sqlite.effect_presets). UI shows both, with "install to global" / "copy to project" commands.

**Bundled defaults (5):** Linear (minimal pan-only, no ripple, white background), Runway (dynamic zoom + dark gradient + pronounced ripple), Tella (mid zoom + soft shadow + BGM), Loom (subtle + no zoom + narration-ready), Plain (raw + no effects — useful baseline).

**Import/export:** Drag-drop `.scpreset` file → validate schema → ask user per-project or global. Export from inspector "Share preset" button.

**Cloud sync:** DEFERRED to Phase 4 (D-20).

**Plan-split implication:** Wave C, plan 7 (independent, mostly data-plumbing).

### §9 Multi-Format Export Pipeline

**Format matrix:**
| Format | Container | Video codec | Audio codec | Phase 2 approach |
|--------|-----------|-------------|-------------|------------------|
| MP4 | MP4 | H.264 (libopenh264 fallback per Phase 1 D-24, or VideoToolbox/NVENC/QSV) | AAC | Primary |
| WebM | WebM | VP9 (libvpx-vp9) | Opus | 2nd format |
| GIF | GIF | palettegen+paletteuse | — | 3rd format, 2-pass |

**Hardware encoders (re-use Phase 1 D-22..D-24 probe):** VideoToolbox / NVENC / QSV selected via `hw_probe`; libopenh264 last resort. VP9 has no HW encode on most consumer HW — CPU-only (accept).

**Resolution presets (EXPORT-03):** 720p (1280×720), 1080p (1920×1080), 4K (3840×2160). Configurable FPS (24/30/60) + quality (low/med/high → CRF or bitrate mapping).

**Scale placement (critical):** Phase 1 research + ARCHITECTURE.md canonical order says: **crop/zoom at source resolution → scale to output ONCE → overlays at output resolution → encode**. Scaling twice introduces sampling loss.

**Smart batch reuse (D-30, EXPORT-04):** 
```
Composite pipeline (CPU/GPU): produce single high-fidelity intermediate frame stream at MAX(target_resolutions) at target FPS.
Fan-out:
  → ffmpeg -c:v h264_videotoolbox ... out.mp4
  → ffmpeg -c:v libvpx-vp9 ... out.webm
  → ffmpeg -filter_complex palettegen+paletteuse ... out.gif
Pipe: OS pipe OR FFV1 tempfile (lossless, ~10MB/s → disk).
```
**Recommendation:** Start with FFV1 tempfile for simplicity (parallel reads from same file; no pipe fan-out complexity); measure; move to named pipes only if disk I/O bottleneck at 4K.

**Background render queue (D-04, EXPORT-05):**
- `render_jobs` table: `id, story_id, preset_id, format, resolution, fps, quality, status, progress_pct, started_at, completed_at, error, priority`
- Actor polls `status='pending' ORDER BY priority DESC, id ASC LIMIT pool_size - running`
- FFmpeg sidecar spawn → progress parsed from `-progress pipe:1` stderr lines → `Channel<RenderProgress>` to UI
- Cancel: UI sends `CancelJob { id }` → actor looks up child, SIGKILL, mark status='cancelled'
- Resume on relaunch: any `status='running'` on boot → mark `status='interrupted'`; user prompted to restart

**Plan-split implication:** Wave C, plan 8-9 (render queue actor + multi-format + benchmark bench).

### §10 Per-Action Coalesced Undo/Redo

**State management pattern:** Zustand slice with `history: Snapshot[]`, `cursor: usize`. Each Action = `{ kind, prev: Patch, next: Patch, ts }`.

**Coalescing window:**
- Drag (e.g., clip trim handle): emit one `ActionStart` on mousedown, accumulate `Patch` on mousemove, emit one `ActionCommit` on mouseup → **1 undo step**.
- Text edit: debounce 500ms idle → coalesce all intermediate keystrokes into 1 step.
- Slider drag: same as drag.
- Discrete action (apply preset, delete clip): 1 step immediately.

**Snapshot vs delta:**
- **Recommendation:** **delta-based (Patch)** for memory efficiency. Use `immer` or manual jsonpatch-style. 50 snapshots × full timeline could be 50MB; deltas ~500KB.
- Full snapshot every 10 steps as safety (fast redo).

**Ring buffer 50 (D-16):** `Vec<Action>` with `push_truncate_from_cursor` semantics (redo-branch truncates on new action after undo).

**Keyboard shortcuts:**
- Cmd/Ctrl+Z = undo
- Cmd/Ctrl+Shift+Z (or Cmd/Ctrl+Y on Win) = redo
- No per-track undo in Phase 2 (keep simple; D-12 fixed tracks).

**Coverage (D-17):** timeline ops (move/trim/delete clip), effect settings, preset apply/revert, text overlay edits, background/framing. Does NOT cover .story DSL edits (CodeMirror owns its own).

**Pitfalls:** undo drift with preview renderer (AST changes → preview diff recompute) — ensure undo re-runs the same AST-diff path as normal edit.

**Plan-split implication:** Wave C, plan 10 (integrates deeply with UI-05 components).

### §11 Post-Production Editor UI Shape

**Layout (D-14):**
```
┌─────────────────────────────────────────────────────────────────┐
│ Top bar: project name | Undo/Redo | Play | Export ▼             │
├───────────────────────────────────────────┬─────────────────────┤
│                                           │                     │
│  Preview Player (60% × ~65%)              │  Inspector (25%)    │
│  [WebGPU/WebGL2 canvas]                   │  Current selection  │
│  transport controls                        │  - clip properties │
│                                           │  - preset picker    │
│                                           │  - effect params   │
│                                           │                     │
├───────────────────────────────────────────┴─────────────────────┤
│ Timeline (bottom, ~30%)                                          │
│ ┌─────────────────────────────────────────────────────────────┐ │
│ │ Video      ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ │ │
│ │ Cursor     ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒ │ │
│ │ Zoom       ░░░░░░░░░░░▓▓░░░░░░░░░▓▓▓░░░░░░░░░░░░░▓▓░░░░░░ │ │
│ │ Sound      ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒ │ │
│ │ Annots     ░░░░░░░▓▓░░░░░░░░░░░░▓▓▓▓░░░░░░░░░░░░░░░▓░░░░░ │ │
│ └─────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
Drawers: Sound library (slide from left); Export settings (slide from right or modal)
```

**Reference layouts:**
- **Final Cut Pro** — 3-pane, fixed tracks, magnetic timeline. Close to D-12/D-13.
- **DaVinci Resolve** — too many panels; avoid complexity.
- **Screen Studio** — 3-pane, effect presets on right, timeline bottom. **Primary reference.**

**Layer track patterns:** Each track = horizontal lane, clips = colored blocks with handles. Cursor/Zoom/Annotations tracks show "event markers" (diamonds/bars at keyframes), not clips per se. Video is the one continuous clip; Sound may have multiple clips.

**Timeline scrubbing UX:** Click on timeline → playhead jumps + preview seeks. Drag playhead → continuous scrub (throttle seek to 60fps). Shift-click = range select. Space = play/pause.

**Effect preset panel:** Right inspector, tabbed: Presets | Effects | Sound. Presets grid with thumbnail (static preview image from preset metadata).

**Sound library browser:** Left drawer. Category tabs (SFX / BGM / Attribution). Each item = row with waveform (`wavesurfer.js` static render), name, duration, drag-to-timeline. Play preview on click.

**Export modal flow:**
1. Format checkboxes (MP4 / WebM / GIF)
2. Resolution (720/1080/4K), FPS, Quality per format (or "Use defaults")
3. Output folder picker
4. "Export" button → modal closes + toast + job appears in render queue widget (top-bar dropdown)
5. Progress updates live; click job → details panel with cancel

**Accessibility (WCAG 2.1 AA):** Keyboard nav through tracks (Tab, arrow keys), aria-labels on all timeline clips with time + type, focus ring visible on clips, screen-reader announcements for playhead position.

**Plan-split implication:** Wave C, **two plans minimum**: (11) editor shell + timeline + preview player integration, (12) inspector + sound drawer + export panel. This is the largest UI surface in the project.

### §12 Performance Target Validation

**Target (EXPORT-06):** 1-minute 1080p60 recording → MP4 + WebM export in <30s on reference HW (M2 Pro, Ryzen 7 + NVENC).

**FFmpeg flags by platform:**
- macOS: `-c:v h264_videotoolbox -b:v 10M -allow_sw 0 -pix_fmt nv12`
- Windows NVIDIA: `-c:v h264_nvenc -preset p5 -rc vbr -cq 23`
- Windows Intel QSV: `-c:v h264_qsv -global_quality 23 -preset medium`
- Windows AMD AMF: `-c:v h264_amf -quality balanced`
- Fallback: `-c:v libopenh264 -b:v 4M` (slower, LGPL)

**Filter-graph optimization canon (from ARCHITECTURE.md + D-19):**
```
source decode → denoise (optional, off by default) → color passthrough 
  → crop/zoom (at source res — cheapest) → scale to output (single op) 
  → cursor overlay → ripple overlay → text/annotations overlay 
  → transitions (xfade across scenes) → HW encode
```

**Benchmark harness (D-31, EXPORT-06):**
- `scripts/benchmark/render-1min.sh` — fixed input, fixed preset, fixed output formats, wall-clock measured.
- CI job runs on macOS-14-arm64 + windows-latest (self-hosted with NVENC), asserts `< 30000ms`. Fail-fast build.
- Commit baseline; alerts on >10% regression.

**Must-benchmark-early risks:**
- WebGPU preview 1080p60 latency (Wave B gate)
- Smart batch reuse actually faster than separate encodes (measure both; keep winner)
- 4K encode CPU-only (libopenh264) fits budget? If not, surface "4K requires HW encoder" UX

**Plan-split implication:** Benchmark harness is plan 9 (Wave C) but STUB in Wave 0 of the phase with a placeholder assertion so it's measured continuously, not at end.

---

## Phase Split Risk Analysis

**Question:** Split Phase 2 into 2 phases, or keep as 1 with 8-12 plans?

**Keep as single phase with 3 waves + 10-12 plans.** Rationale:
1. **Shared AST (D-01, D-18)** — preview and final engines must ship together; splitting breaks the invariant.
2. **POST-08 snapshot tests** — require the full canonical order (zoom + cursor + background + text + transitions + audio). Can't snapshot half the graph.
3. **EXPORT-06 benchmark** — requires the full pipeline end-to-end. Benchmark on half-phase is meaningless.
4. **UI-05 post-production editor** — depends on every POST-0X feature being present to provide inspector controls.
5. **Risk concentration, not count** — 17 requirements but they cluster into 4 tech risk areas (AST, cursor/zoom math, WebGPU, render queue). Each area is 2-3 plans.

**Proposed wave structure:**

### Wave A (Foundation — parallelizable plans)
1. **Plan 1** — `crates/effects` typed AST + builder + canonical-order validator + insta fixtures (POST-01, POST-08 — infrastructure only)
2. **Plan 2** — cursor minimum-jerk + ripple math + auto-zoom planner (POST-02, POST-03) — pure crate, unit-testable
3. **Plan 3** — project.sqlite v2 migration + `render_jobs` + `effect_presets` + `effect_settings` + `sound_library_index` + `timeline_state` schemas (POST-09 infra, EXPORT-05 infra)
4. **Plan 4** — WebGPU feature detection + preview context bootstrap + WebGL2 fallback + VideoFrame lifecycle (UI-05 infra)

### Wave B (Integration — depends on Wave A)
5. **Plan 5** — FFmpeg xfade transitions + audio mixer + BGM ducking graph builders + goldens (POST-05, POST-06)
6. **Plan 6** — background compositor + text overlay + callouts + highlight rings (POST-04, POST-07)
7. **Plan 7** — cursor/ripple PNG sequence emit + FFmpeg overlay wiring (POST-03 final path)
8. **Plan 8** — render queue actor + FFmpeg sidecar pool + cancel/priority/resume (EXPORT-05, D-04)
9. **Plan 9** — multi-format export pipeline + smart batch reuse + benchmark harness (EXPORT-01..04, EXPORT-06)

### Wave C (UI + Polish — depends on Wave B)
10. **Plan 10** — Post-Production Editor shell: routes, layout, 5-track timeline component, snapping (UI-05 skeleton)
11. **Plan 11** — Preview player integration (WebGPU compositor + transport + scrub) + effect inspector panel + sound library drawer (UI-05 majority)
12. **Plan 12** — Export settings modal + render queue widget + undo/redo stack + `.scpreset` import/export (UI-05 complete, UI-11, POST-09 complete)

**Parallelization:** Wave A plans 1/2/3/4 run in parallel (no deps). Wave B plans 5/6/7 run in parallel after Wave A; 8/9 run in parallel after 5-7. Wave C plans 10/11/12 must run sequentially due to UI shared components.

**Alternative: 8 coarser plans** — collapse Wave A plans 2+3 into one, Wave B plans 5+6+7 into one, Wave C plans 11+12 into one. Viable if `granularity: coarse` (which it is in config.json). **Recommendation: 10-12 plans; coarse granularity tolerates merging but 4 Wave B plans on parallel tracks is worth keeping separate for reviewability.**

---

## Runtime State Inventory

Phase 2 is NOT a rename/refactor phase — it is greenfield feature work extending Phase 1. Runtime state inventory is minimal but documented for completeness:

| Category | Items | Action |
|----------|-------|--------|
| Stored data | Phase 1 created `project.sqlite` may have recordings; Phase 2 adds tables via `rusqlite_migration` v2. Existing steps/sessions consumed read-only. | Migration script + open-time prompt if version mismatch (Phase 1 D-28 already defined). |
| Live service config | None — StoryCapture is offline-first, no external services. | None. |
| OS-registered state | None new in Phase 2. | None. |
| Secrets/env vars | No new secrets (TTS API keys land in Phase 3 per Phase 1 D-29). | None. |
| Build artifacts | Bundled sound pack `assets/sound-library/` (~30MB, new) + cursor skins `assets/cursor-skins/` (new) + gradient presets `assets/gradient-presets/` (new). Tauri installer bundle will grow. | Update `tauri.conf.json` `bundle.resources`; update installer size docs; **update PROJECT.md performance-budget line if final size exceeds 50MB goal (D-21)**. |

---

## Environment Availability

| Dependency | Required By | Available (expected) | Fallback |
|------------|-------------|----------------------|----------|
| FFmpeg static sidecar | All render paths | Phase 1 D-22 — built | — |
| FFmpeg with libharfbuzz + libfribidi | RTL drawtext | Must verify in Phase 1 ffmpeg build recipe | English-only fallback (document; v2 improves) |
| FFmpeg with libvpx-vp9 | WebM export | Verify in Phase 1 recipe — add if missing | Drop WebM if unavailable (document) |
| FFmpeg with libopus | WebM audio | Verify in Phase 1 recipe | Vorbis fallback |
| OpenCL runtime | `xfade_opencl` preview | Platform-dependent | CPU xfade (D-24 accepts) |
| VideoToolbox (macOS) | HW encode MP4 | Phase 1 D-22 probe | libopenh264 |
| NVENC / QSV / AMF (Windows) | HW encode MP4 | Phase 1 D-22 probe | libopenh264 |
| WebGPU (webview) | 60fps preview (primary) | Chromium 113+ / WebView2 / WKWebView on macOS Tahoe 26+ | WebGL2 fallback (D-01) |
| WebCodecs `VideoDecoder` (webview) | Frame-accurate scrub (upgrade) | Chromium 94+, Safari 16.4+ | `<video>` currentTime seek (baseline) |
| `@webgpu/types`, `wavesurfer.js`, `react-hotkeys-hook`, `@tanstack/react-virtual` | Frontend | npm install | — |
| `ffmpeg-next` (optional) | In-process graph validation | cargo | Just use sidecar (no in-process) |
| `hound` | WAV handling (possibly unused) | cargo | Skip if unused |

**Missing dependencies with no fallback:** None identified — LGPL FFmpeg build is binding constraint; **verify in Wave 0 of this phase that the Phase 1 ffmpeg recipe includes libharfbuzz/fribidi/libvpx-vp9/libopus**. If not, extend recipe.

**Missing with fallback:** OpenCL (silent CPU fallback), WebGPU (WebGL2 fallback), hardware encoders (libopenh264).

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | WebView2 on Windows supports WebGPU in 2026 builds | §2, Pitfall #4 | Must ship WebGL2 as primary, not fallback; Wave A plan 4 scope grows. Mitigation: test in Wave 0. |
| A2 | WKWebView on macOS Tahoe 26 has WebGPU | §2 | Same as A1. Mitigation: test on macOS target version in CI. |
| A3 | Phase 1 FFmpeg build includes libvpx-vp9 + libopus + libharfbuzz + libfribidi | §9, §7 | WebM/RTL broken. Mitigation: verify Wave 0; add to recipe if missing. |
| A4 | libopenh264 available as LGPL fallback on both platforms | §9 | Hardware-encode-only restriction. Mitigation: Phase 1 D-24 already established this. |
| A5 | Bundled sound pack ~30MB is achievable with 10-15 SFX + 5-8 BGM | §6, D-21 | Installer bloat, may force "download on first use" UX. Mitigation: curate with strict per-file budget (<2MB/SFX, <5MB/BGM). |
| A6 | Critically-damped spring (omega≈6) produces "calm" zoom smoothing | §4 | Over/undershoot feel. Mitigation: expose tunable in "Calm" preset code; A/B test. |
| A7 | 1080p60 WebGPU composite <5ms on M2 | §2, §12 | Preview can't hit 60fps → drop to 30fps at 1080p (D-03 allows 30fps only at 4K). Mitigation: benchmark early. |
| A8 | Smart batch reuse via FFV1 tempfile is faster than independent encodes at 1080p | §9 | Disk I/O bottleneck. Mitigation: measure both; pick winner. |
| A9 | 50-step ring buffer undo uses <20MB of RAM with delta encoding | §10 | Memory pressure during long sessions. Mitigation: periodic full snapshot + compress deltas. |
| A10 | POST-08 canonical order renders identical to current Screen Studio-like output for our test fixtures | §1 | PSNR snapshot test may not exist; "correct" is subjective. Mitigation: capture a reference render as truth at Wave A+B junction. |
| A11 | Pixabay/Freesound/Mixkit bundling compatible with StoryCapture license (proprietary closed-source) | §6, D-21 | Legal — must resolve. Mitigation: legal review + per-file license audit before ship. |
| A12 | FFmpeg 7.1 `xfade_opencl` works with the static LGPL build | §5, D-24 | xfade_opencl requires `--enable-opencl` in FFmpeg build. Mitigation: verify Phase 1 recipe; accept CPU fallback if not. |

Every `[ASSUMED]` claim above requires either measurement (WebGPU perf, batch-reuse perf, spring tuning) or verification (FFmpeg build flags, licensing) — surface in Wave 0 of Phase 2 planning.

---

## Open Questions

1. **Do we need WebCodecs `VideoDecoder` for Phase 2 scrub, or is `<video>.currentTime` sufficient?**
   - What we know: `<video>` seeks to GOP boundary, accuracy ~100-500ms.
   - What's unclear: Does 500ms seek accuracy feel "scrubby" enough for timeline UX? (Screen Studio is frame-accurate.)
   - Recommendation: Start with `<video>`; if feedback says "snaps to keyframe, not smooth," upgrade. Defer decision to post-Wave B preview integration.

2. **Should the bundled sound pack ship as an installer asset (~30MB) or a first-run download?**
   - What we know: D-21 prefers bundled; installer budget already flagged.
   - What's unclear: Actual installer size after Phase 1 artifacts + Phase 2 assets (could be 80-120MB).
   - Recommendation: Measure after Phase 1 ships; if >120MB total, switch to first-run download (one-time ~30MB fetch, no repeat).

3. **OpenCL availability on Windows ARM / macOS ARM?**
   - What we know: macOS deprecated OpenCL (≥ macOS 10.14) but runtime still present. Windows ARM OpenCL support varies.
   - Recommendation: Feature-detect; silent CPU fallback per D-24. Don't make `xfade_opencl` required.

4. **Preset migration strategy — forward vs. backward compat?**
   - What we know: `.scpreset` has a `version` field.
   - What's unclear: Do we auto-upgrade v1→v2 silently, or ask user? Do older builds refuse newer presets (forward-incompat)?
   - Recommendation: Auto-upgrade with backup; older builds show "preset too new" error. Document migration policy in Wave A plan 1.

5. **4K preview target — accept 30fps (D-03 allows)?**
   - What we know: D-03: "4K preview cho phép drop xuống 30fps khi cần."
   - What's unclear: How often is 4K preview actually used? May be rare (authoring is usually 1080p).
   - Recommendation: Measure; if 4K preview is <5% of sessions, optimize for 1080p 60fps first.

---

## Sources

### Primary (HIGH confidence)
- Phase 1 `01-CONTEXT.md` — binding decisions D-22..D-39 [VERIFIED: read]
- `.planning/research/ARCHITECTURE.md` — canonical filter-graph order [VERIFIED: read]
- `.planning/research/PITFALLS.md` — Pitfalls #4 (cursor), #5 (auto-zoom), #6 (A/V drift), #2 (encoder fallback) [VERIFIED: read]
- `.planning/research/STACK.md` — pinned versions [VERIFIED: read]
- `.planning/REQUIREMENTS.md` — POST-01..09, EXPORT-01..06, UI-05, UI-11 [VERIFIED: read]
- [FFmpeg Filters Documentation (7.1)](https://ffmpeg.org/ffmpeg-filters.html) — xfade, drawtext, amix, sidechaincompress, palettegen [CITED]
- [FFmpeg 7.1 xfade filter](https://ayosec.github.io/ffmpeg-filters-docs/7.1/Filters/Video/xfade.html) [CITED]
- [WebGPU is now supported in major browsers — web.dev](https://web.dev/blog/webgpu-supported-major-browsers) [CITED]
- [MDN — WebGPU API](https://developer.mozilla.org/en-US/docs/Web/API/WebGPU_API) [CITED]
- [ffmpeg-next on docs.rs](https://docs.rs/ffmpeg-next) [CITED]

### Secondary (MEDIUM confidence)
- [OTTVerse — xfade filter guide](https://ottverse.com/crossfade-between-videos-ffmpeg-xfade-filter/) — chained-offset formula [CITED]
- [Flash & Hogan 1985 — Minimum-Jerk Model] — [ASSUMED, widely cited in motor-control literature, direct polynomial verified in implementations]
- [Can I use — WebGPU](https://caniuse.com/webgpu) [CITED]
- [Chrome for Developers — WebGPU overview](https://developer.chrome.com/docs/web-platform/webgpu/overview) [CITED]
- Pixabay / Freesound / Mixkit licensing — verify per-file at Wave 0 [ASSUMED compliant]

### Tertiary (LOW confidence — flag for validation)
- WebView2 on Windows exact WebGPU version availability in 2026 [ASSUMED — A1, A2]
- Smart batch reuse disk I/O performance vs. independent encodes [ASSUMED — A8, must benchmark]
- 1080p60 WebGPU composite time on reference HW [ASSUMED — A7, must benchmark]

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all libraries pinned, Phase 1 versions re-used; only `wavesurfer.js` / `ffmpeg-next` / `hound` new and well-known.
- Architecture patterns: HIGH — typed AST + dual emitter + render-queue-actor are standard for this domain; well-grounded in Phase 1 patterns.
- Auto-zoom & cursor math: MEDIUM-HIGH — algorithms well-known (min-jerk, crit-damped spring); parameter tuning (A6) is subjective + A/B-test territory.
- WebGPU preview perf: MEDIUM — depends on A7 (measure Wave 0).
- Audio mixing: HIGH — FFmpeg ecosystem solved.
- Export pipeline perf: MEDIUM — smart-batch-reuse (A8) unmeasured; HW encoder probe carried from Phase 1.
- Pitfalls: HIGH for FFmpeg, MEDIUM for WebGPU context loss semantics in Tauri webview.
- Plan split: HIGH — single phase, 10-12 plans in 3 waves is well-grounded.

**Research date:** 2026-04-14
**Valid until:** 2026-05-14 (4 weeks — WebGPU ecosystem moving; FFmpeg 7.x stable; watch for Tauri webview updates)

---

*Phase: 02-cinematic-post-production-export*
*Research completed: 2026-04-14*
