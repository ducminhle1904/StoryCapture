# Phase 2: Cinematic Post-Production & Export - Context

**Gathered:** 2026-04-14
**Status:** Ready for planning
**Mode:** discuss (interactive, Vietnamese)

<domain>
## Phase Boundary

Biến raw recording (Phase 1 output: MP4 + click coords + step timings + project SQLite) thành video chất lượng "Screen Studio" qua một Post-Production Editor có timeline scrub real-time, hệ thống presets, và export đa định dạng.

**In scope:** typed filter-graph AST trong `crates/effects`; auto-zoom engine; cursor overlay engine (minimum-jerk + ripple); background compositor (gradient/image + rounded frame); xfade transitions; sound mixer (bundled SFX + BGM + auto-duck); text overlay engine; preset system (per-project + global, JSON export); multi-format export (MP4/WebM/GIF × 720/1080/4K); batch export with smart frame reuse; background render queue (multi-job, cancel/priority); preview renderer (WebGPU with WebGL2 fallback) chạy trong webview; per-action coalesced undo/redo; Post-Production Editor UI (UI-05) + 5-track timeline.

**Out of scope (later phases):**
- AI voiceover (Phase 3) — chỉ chuẩn bị BGM auto-duck slot
- LSP / NL chat (Phase 3)
- Web upload, cloud preset sync, branded presets level org (Phase 4)
- Custom cursor skin upload, per-step cursor override (deferred)
- Per-step text/font customization beyond bundled set (deferred)
- HDR pipeline, multi-viewport export (v2)

</domain>

<decisions>
## Implementation Decisions

### Rendering Architecture
- **D-01:** **Two-engine renderer.** Preview chạy trong webview bằng **WebGPU (primary) với WebGL2 fallback** cho 60fps interactive scrub. Final export đi qua FFmpeg sidecar (Phase 1's static universal binary). Effects crate giữ một **typed AST chung** mà cả hai engines consume — không string-concat filtergraphs.
- **D-02:** **Final render pipeline:** Rust pre-computes parametric overlay data (cursor minimum-jerk trajectory, ripple keyframes, zoom keyframes, background mask) → emit thành PNG sequences hoặc filter-graph parameters → FFmpeg composite + encode với HW encoder probe từ Phase 1 (D-22..D-24). KHÔNG implement custom Rust+wgpu final renderer trong Phase 2 (deferred — nếu cần sau).
- **D-03:** **Scrub target = 60fps interactive** ở 1080p preview. 4K preview cho phép drop xuống 30fps khi cần. Final encode luôn full-fidelity capture-native resolution.
- **D-04:** **Background render queue.** Multi-job persistent queue trong project.sqlite (job_id, story_id, format, status, progress, started_at, ...). FFmpeg sidecar pool tối đa N=2 concurrent (cấu hình theo HW probe). Hỗ trợ cancel + priority. Build trên actor pattern Phase 1 D-06. Progress events qua Tauri Channel<T>.

### Auto-Zoom
- **D-05:** **Default preset = "Dynamic"** (max zoom 3x, dwell 500ms, min shot 1.2s, max 10 zoom changes/min). Match cảm giác Screen Studio cho marketing/sales demos. Ship thêm "Calm" và "Subtle (pan-only)" làm presets phụ — user switch trong settings hoặc per-recording.
- **D-06:** **Algorithm:** Look-ahead scheduling — chạy cả recording qua planner offline để gen keyframe list (time, center, scale), apply low-pass filter (critically-damped spring) trước khi render. Tách scale và pan curves: pan trước, scale in sau, hold; KHÔNG combine simultaneously (Pitfall #5).
- **D-07:** Click coords + step timings consume từ project.sqlite (Phase 1 capture). Không re-detect bằng CV.

### Cursor Engine
- **D-08:** **Motion model = minimum-jerk trajectory** (Flash et al. 1985, 5th-order polynomial qua waypoints). Sample tại render fps (60fps), pre-compute toàn bộ path trước khi pipe vào FFmpeg overlay. Sub-pixel Perlin jitter ~1px amplitude để tránh "robot-straight".
- **D-09:** **Bundled cursor skins (Phase 2 ship):** mac default, win default, dark variant, light variant, "big arrow" presentation mode (4-5 skins). User control size scaling và color tint. **Custom skin upload và per-step override deferred** sang phase sau.
- **D-10:** **Click ripple = anticipate 60ms trước click event + radial expand 300ms.** Một default style (radial gradient ring). Sub-style và configurable timing deferred.
- **D-11:** Cursor position ground truth: dùng click coords từ DSL execution (chính xác sub-pixel); cho mouse motion giữa clicks, interpolate bằng minimum-jerk qua action waypoints.

### Timeline Editor UX (UI-05)
- **D-12:** **5 fixed tracks:** Video / Cursor / Zoom / Sound / Annotations. Khớp Success Criteria #2 chính xác. User KHÔNG add/remove track (giữ đơn giản cho non-editor users).
- **D-13:** **Snapping:** magnetic snap default ON, snap targets = playhead + scene boundary + neighbor clip edges. Hold **Alt** để tạm disable snap. **KHÔNG ripple-edit** trong Phase 2.
- **D-14:** Layout panels (UI-05 spec): Timeline (bottom, ~30% height), Preview player (top-left, 60%), Effect/Inspector panel (top-right, 25%), Sound library browser drawer (slide từ trái khi mở), Export settings panel (modal hoặc right drawer). Panel sizes persist qua Zustand UI store.

### Undo/Redo (UI-11)
- **D-15:** **Per-action coalesced** undo. Một drag = 1 undo step. Text edit coalesce theo 500ms idle timeout. Match Figma/Sketch behavior. KHÔNG per-keystroke, KHÔNG snapshot-based.
- **D-16:** **Storage = in-memory ring buffer 50 steps**, reset khi reload project. Không persist undo journal trong SQLite (deferred). Saved versions không phải scope Phase 2.
- **D-17:** Undo coverage: timeline ops (move/trim/delete clip), effect setting changes, preset apply/revert, text overlay edits, background/framing changes. KHÔNG cover .story DSL edits (CodeMirror tự quản lý undo riêng).

### Effects, Presets & Sound
- **D-18:** **Filter-graph AST = typed Rust enum tree** trong `crates/effects`. Mỗi node có serde Serialize/Deserialize, snapshot test golden filter-graphs (POST-08 PSNR snapshot test), version field cho preset migration.
- **D-19:** **Canonical filter-graph order** (POST-08): zoom/pan → background composite → cursor overlay → ripple overlay → text/annotations overlay → transitions (xfade across scenes) → audio mix. Enforced trong code (builder pattern), không trông cậy vào string ordering.
- **D-20:** **Presets scope:** Per-project (project.sqlite) + global (app.sqlite). Export/import qua `.scpreset` JSON file để share thủ công. **Cloud sync deferred sang Phase 4.** Bundled defaults: ~5 preset cinematic style (Linear, Runway, Tella, Loom, Plain).
- **D-21:** **Sound library = bundled ~30MB pack** ship trong installer (CC0/CC-BY từ Pixabay/Freesound, attribution file kèm theo): 10-15 SFX (click variants, transition whoosh, hover) + 5-8 BGM tracks (lo-fi, corporate, upbeat, ambient). Installer budget: tổng FFmpeg + sound + UI vẫn chấp nhận lớn hơn 50MB sau cùng — cập nhật con số trong PROJECT.md sau khi đo thực tế.
- **D-22:** **BGM auto-duck:** -12dB khi có voiceover (chuẩn bị slot Phase 3 TTS); manual duck control trong Sound inspector. Click SFX có "off / subtle / pronounced" preset.
- **D-23:** **Background compositor:** 8-12 curated gradient presets (palette inspired by Runway/Linear/ElevenLabs để khớp DESIGN.md từ Phase 1) + user image upload (PNG/JPG, validate dimensions, persist trong project folder), rounded frame configurable (radius / drop shadow blur+offset / padding). **Logo/font/brand-kit deferred sang Phase 4.**

### Scene Transitions
- **D-24:** Default transitions ship: fade, dissolve, wipe-left, wipe-right (FFmpeg `xfade`). GPU transitions (`xfade_opencl`) feature-detect tại startup; nếu available, auto-enable cho preview (faster scrub) và optional cho final render. Per-scene transition override trong timeline inspector.
- **D-25:** Default transition = none giữa scenes; user opt-in per scene boundary. Tránh "everything fades" feel của Loom/Tella.

### Text Overlay
- **D-26:** Engine: FFmpeg `drawtext` cho final, Canvas2D/WebGPU text cho preview. Font set bundled: Geist Sans, JetBrains Mono (consistent với Phase 1 D-34) + 2-3 display fonts cho callout (TBD trong UI plan). Limited animation in/out: fade, slide-up, scale-in (3 presets).
- **D-27:** Step annotations auto-derive từ DSL step metadata (label/comment) khi user click "auto-annotate" — không bắt buộc, default off để tránh visual noise.

### Storage & State
- **D-28:** **Effect AST + timeline state lưu trong project.sqlite** (re-use Phase 1 D-27). Migration table mới: `timeline_state`, `effect_presets`, `effect_settings`, `render_jobs`, `sound_library_index`. `rusqlite_migration` đảm bảo backward compat.
- **D-29:** Snapshot test fixtures cho POST-08 (canonical filter-graph order) cùng `crates/effects/tests/fixtures/`.

### Performance & Pipeline
- **D-30:** **Smart batch reuse:** render composite frames một lần thành intermediate stream, fan-out đồng thời vào N FFmpeg encoder processes (mỗi format = 1 sub-process). Inter-process pipe; nếu bottleneck → cache lossless intermediate (FFV1) tạm trong tempfile, encode song song. EXPORT-04 + EXPORT-06 phụ thuộc decision này.
- **D-31:** Benchmark CI job (EXPORT-06): 1-min standardized recording → batch encode MP4+WebM → giữ <30s trên reference HW (M2 Pro / Ryzen 7 + NVENC). Fail build nếu vượt.

### Frontend State
- **D-32:** Timeline state, undo stack, panel layout, current selection → **Zustand** (UI ephemeral). Render job list, preset list, sound library index → **TanStack Query** caching IPC commands. Match pattern Phase 1 D-39.
- **D-33:** Preview player component owns WebGPU/WebGL2 context lifecycle; effect AST changes → diff → patch GPU resources incrementally (avoid full re-upload mỗi frame).

### Claude's Discretion
- Exact xfade duration defaults, easing curves cho text overlay — planner chọn sensible defaults.
- Color palette gradients chính xác — UI plan chốt với designer review.
- FFmpeg sidecar pool size cụ thể (start với 2, configurable).
- Specific sound files trong bundled pack — chọn dựa trên license + curate sau.
- Sub-pixel jitter amplitude exact value (0.5-1.5px range).
- Inspector panel UI layout chi tiết — UI-spec phase quyết định.
- Snapping threshold pixel distance — UX iterate.

### Folded Todos

None — không có pending todos liên quan Phase 2.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Project-Level
- `.planning/PROJECT.md` — vision, perf budgets, design tokens
- `.planning/REQUIREMENTS.md` — POST-01..09, EXPORT-01..06, UI-05, UI-11
- `.planning/ROADMAP.md` — Phase 2 goal + 5 success criteria
- `.planning/research/SUMMARY.md` — overall guidance
- `.planning/research/STACK.md` — pinned versions, compatibility notes
- `.planning/research/ARCHITECTURE.md` — crate boundaries, IPC patterns
- `.planning/research/FEATURES.md` — competitive landscape (Screen Studio/Tella/Loom benchmarks)
- `.planning/research/PITFALLS.md` — Pitfalls #4 (cursor interpolation), #5 (auto-zoom motion sickness), #2 (FFmpeg encoder fallback)
- `.planning/phases/01-foundation-dsl-automation-capture-encode/01-CONTEXT.md` — Phase 1 decisions still binding (D-22 FFmpeg static, D-23 sidecar lifecycle, D-27 SQLite, D-32..D-39 frontend stack)
- `.planning/phases/01-foundation-dsl-automation-capture-encode/01-RESEARCH.md` — research notes Phase 1
- `.planning/config.json` — workflow settings

### External (authoritative docs)
- FFmpeg filter docs — `zoompan`, `overlay`, `drawtext`, `xfade`, `xfade_opencl`, `palettegen` (GIF), `amix`, `sidechaincompress` (BGM ducking)
- FFmpeg HW encoder docs — VideoToolbox / NVENC / QSV usage flags
- WebGPU spec — `https://www.w3.org/TR/webgpu/`
- `wgpu-rs` book (nếu sau này cần native renderer reference)
- Flash, Hogan 1985 — minimum-jerk trajectory paper (cursor model)
- Screen Studio reference videos — visual benchmarks cho "polish quality"
- Pixabay / Freesound CC0 license terms — bundled sound pack compliance
- `motion/react` docs — preview player animation timing

### Local (to add as encountered)
- `crates/effects/grammar/` (or AST schema) — typed filter-graph AST definitions
- `crates/effects/tests/fixtures/` — canonical PSNR snapshot fixtures (POST-08)
- `apps/desktop/src/components/timeline/` — timeline + preview player components
- `assets/sound-library/` — bundled SFX + BGM + attribution.json
- `assets/cursor-skins/` — bundled cursor skin SVG/PNG set
- `assets/gradient-presets/` — curated background gradient presets
- `scripts/benchmark/render-1min.sh` — EXPORT-06 CI benchmark fixture

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets (planned từ Phase 1)
- `crates/effects` — skeleton crate đã được thiết lập trong Phase 1 với typed AST shape; Phase 2 fills out nodes + builders
- `crates/encoder` — FFmpeg sidecar lifecycle (D-23 Phase 1) — re-use cho final render và batch fan-out
- `crates/storage` (rusqlite + rusqlite_migration) — add new tables qua migration
- `apps/desktop/src/ipc/` — typed IPC bindings (`tauri-specta`) — extend với render/preset/timeline commands
- `packages/shared-types/` — codegen target cho effect AST mirror (Rust → TS qua `ts-rs`/`specta`)
- Phase 1 actor pattern (tokio mpsc) — base cho render queue actor
- Tauri Channel<T> — re-use cho high-frequency progress events

### Established Patterns (từ Phase 1)
- IPC trichotomy: command / event / channel — render progress = Channel
- thiserror per crate, anyhow at boundary
- Zustand UI / TanStack Query IPC cache
- shadcn/ui + Base UI (`base-vega`)
- motion/react cho UI animations (NOT video animation)
- CodeMirror 6 cho text editor surfaces

### Integration Points
- `apps/desktop/src-tauri/src/main.rs` — register render/preset/timeline commands
- `crates/effects` ↔ `crates/encoder` — Phase 2 connects AST → filter-graph string + frame pre-compute
- `project.sqlite` schema migration v2 — new tables (timeline_state, render_jobs, effect_presets, ...)
- Phase 1 Recording View → Phase 2 Post-Production Editor: navigation route mới + handoff via project.sqlite
- Phase 1 click coords/step timings → Phase 2 auto-zoom planner input

</code_context>

<specifics>
## Specific Ideas

- **Two-engine renderer là bet kiến trúc lớn nhất Phase 2.** Preview WebGPU + final FFmpeg đòi hỏi 2 codepaths nhưng đó là cách Screen Studio/DaVinci đạt 60fps scrub. Đầu tư đúng lần này, Phase 3-4 dùng lại miễn phí.
- **"Dynamic" auto-zoom default chứ không "Calm".** User pick này — ưu tiên cảm giác polished cho marketing demos. Đảm bảo "Calm" và "Subtle" presets dễ truy cập (settings + per-recording toggle).
- **Cursor minimum-jerk + ripple anticipate 60ms = signature visual.** Đây là phần khán giả nhận biết "human vs automated". Ngân sách thời gian polish khâu này — không skimp.
- **Smart batch frame reuse là chìa khóa EXPORT-06 (<30s/min).** Render composite một lần, fan-out N encoder processes. Đo benchmark sớm, không cuối Phase 2.
- **Background render queue persist trong SQLite** quan trọng vì user có thể đóng app khi đang render dài. Resume on relaunch là UX expected.
- **In-memory undo 50 steps OK cho Phase 2** — đừng over-engineer persistent undo journal. Reload project = clean slate, match Figma.
- **Bundled sound pack (~30MB) tăng installer size vượt 50MB budget Phase 1.** Cần update PROJECT.md performance budget hoặc tách pack thành on-first-use download. Quyết định lúc plan dựa số đo thực tế.
- **POST-08 PSNR snapshot test = guard rail chống regression filter-graph.** Critical vì optimizations sau này có thể đổi node order vô tình.
- **GPU xfade (`xfade_opencl`) là nice-to-have**, không block Phase 2 nếu OpenCL flaky trên 1 platform. Fallback CPU xfade chấp nhận được.
- **Web/cloud preset sync, branded org presets, custom cursor upload** xếp sang Phase 4 — không bị cám dỗ pull về Phase 2.

</specifics>

<deferred>
## Deferred Ideas

Surfaced trong discussion nhưng thuộc phase khác:

- **AI voiceover synced to DSL steps** → Phase 3 (BGM auto-duck slot đã chuẩn bị)
- **LSP cho DSL editor** → Phase 3
- **Natural-language → DSL chat** → Phase 3
- **Cloud preset sync** → Phase 4
- **Branded org-level presets (logo + brand kit)** → Phase 4
- **Web upload + shareable embed + analytics** → Phase 4
- **Custom cursor skin upload + per-step cursor override** → deferred (after Phase 2, possibly v2)
- **Persistent undo journal / named version snapshots** → deferred (post-v1 if user demand)
- **Per-step text/font full customization beyond bundled set** → deferred
- **Multi-viewport/responsive batch export** → v2 differentiator
- **HDR pipeline** → v2
- **Native Rust+wgpu final renderer** → deferred (FFmpeg pipeline đủ cho v1)
- **DAW-style flexible track management** → out of scope (anti-feature theo FEATURES.md)
- **Real-time collaborative timeline editing** → v2/Phase 5 (CRDT scope)

### Reviewed Todos (not folded)

None — không có todos được review.

</deferred>

---

*Phase: 02-cinematic-post-production-export*
*Context gathered: 2026-04-14 (interactive, Vietnamese)*
