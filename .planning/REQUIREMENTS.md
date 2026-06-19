# Requirements: StoryCapture

> Historical planning note: this artifact predates the Electron cleanup and may
> mention Tauri/Rust paths that no longer exist. For current source reality,
> read `AGENTS.md`, `docs/ARCHITECTURE.md`, `docs/DOMAIN.md`, and
> `.planning/STATE.md`.

**Defined:** 2026-04-14
**Core Value:** Turn a written story into a polished, shareable demo video automatically — no recording, editing, or video-production skill required.

## v1 Requirements

### Foundation (FOUND)

- [x] **FOUND-01
**: Turborepo + Cargo workspace scaffolded with `apps/desktop`, `apps/web`, `packages/{shared-types,story-dsl,ui,config}`, `crates/{story-parser,automation,capture,effects,encoder,storage}`
- [ ] **FOUND-02**: Tauri v2 desktop shell boots on macOS (arm64 + x64) and Windows x64 with React 19 + Vite + Tailwind v4 + shadcn/ui + Base UI (`base-vega`) initialized
- [ ] **FOUND-03**: Typed IPC codegen via `tauri-specta` (or `specta`) emits shared TypeScript types for all Tauri commands and events
- [x] **FOUND-04
**: Structured logging via `tracing` + `tauri-plugin-log` with local log files (no telemetry by default)
- [ ] **FOUND-05**: Error taxonomy established (`thiserror` in crates, `anyhow` at boundaries); panics captured and reported to UI
- [ ] **FOUND-06**: SQLite via `rusqlite` with `rusqlite_migration`; two-tier layout (`app.sqlite` global + per-project `project.sqlite`)
- [ ] **FOUND-07**: OS-keychain secret storage via `tauri-plugin-keyring` (NOT Stronghold) for LLM/TTS API keys
- [ ] **FOUND-08**: GitHub Actions CI matrix builds on macOS arm64, macOS x64, Windows x64 for every PR with caching

### Story DSL (DSL)

- [ ] **DSL-01**: pest grammar parses `story`, `meta`, and `scene` blocks with defined keys (app, viewport, theme, speed)
- [ ] **DSL-02**: Parser supports commands: `navigate`, `click`, `type`, `scroll`, `hover`, `drag`, `select`, `upload`
- [ ] **DSL-03**: Parser supports control commands: `wait <duration>`, `wait-for <text|selector>`, `assert <text|selector>`, `screenshot <name>`, `pause`
- [ ] **DSL-04**: Parser emits typed AST with span info on every node for precise diagnostics
- [ ] **DSL-05**: Two-layer parse (lenient tokenize + semantic check) produces human-readable errors with Levenshtein "did you mean" suggestions
- [ ] **DSL-06**: Panic-mode recovery allows multi-error reporting in a single parse pass
- [ ] **DSL-07**: Story files save/load from per-project folders; parser is callable from a non-Tauri context (pure crate, CLI-ready)

### Automation (AUTO)

- [ ] **AUTO-01**: `BrowserDriver` trait with `ChromiumoxideDriver` (primary) and `PlaywrightSidecarDriver` (fallback) implementations
- [ ] **AUTO-02**: Action executor maps each DSL verb to explicit auto-waiting (network idle, selector visible, animation settled) — does not rely on CDP defaults
- [ ] **AUTO-03**: Smart selector engine uses intent-aware resolution: explicit `selector` / `testid` / `aria` targets resolve strictly with no cross-type fallback, while human-text targets build ranked candidates from accessible name, visible text, and label associations, with attempt logging and ambiguity errors when no unique high-confidence match exists
- [ ] **AUTO-04**: Browser viewport, theme, and base URL driven by `meta` block settings
- [ ] **AUTO-05**: On step failure, executor reports failure point, attempted selectors, and screenshot for UI retry UX
- [ ] **AUTO-06**: Playwright sidecar is bundled and auto-selected for verbs chromiumoxide doesn't reliably support (file upload, wait-for-download, shadow-DOM click, OAuth popups)

### Screen Capture (CAP)

- [ ] **CAP-01**: macOS capture via ScreenCaptureKit (`screencapturekit` crate, pinned version) with stable signing identity
- [ ] **CAP-02**: Windows capture via Windows.Graphics.Capture (`windows-capture` crate, pinned version)
- [ ] **CAP-03**: XCap fallback path for edge cases (verified on both OSes)
- [ ] **CAP-04**: macOS Screen Recording TCC permission flow: preflight probe, guided prompt, relaunch-after-grant helper
- [ ] **CAP-05**: Capture pipeline is zero-copy with byte-bounded frame queue; RAII wrappers on native surfaces; 30-minute CI soak test asserts memory stays under 800MB
- [ ] **CAP-06**: Multi-display selection + retina-scaling correctness verified on both OSes
- [ ] **CAP-07**: Capture preserves PTS from the capture API; single clock source for audio+video

### Encoder (ENC)

- [ ] **ENC-01**: FFmpeg 7.x built as a universal static binary (no nested dylibs) and bundled as a Tauri sidecar
- [ ] **ENC-02**: Hardware-encoder runtime feature detection: VideoToolbox (macOS), NVENC + QSV (Windows); software fallback
- [ ] **ENC-03**: Frame pipeline: native frames → stdin pipe → FFmpeg → MP4 (H.264 baseline) export
- [ ] **ENC-04**: Build + notarization CI produces signed, notarized, auto-updater-compatible artifacts for macOS and signed artifacts for Windows
- [ ] **ENC-05**: `ffprobe`-based audio/video alignment check passes in CI (no drift > 100ms across 10-minute recording)
- [x] **ENC-06** *(Phase 12)*: Output video resolution matches the selected `OutputResolution` preset exactly (verified by `ffprobe`). Presets: 720p (1280×720), 1080p (1920×1080), 1440p (2560×1440), 4K (3840×2160), MatchSource, Custom(w,h).
- [x] **ENC-07** *(Phase 12)*: Aspect-ratio mismatch between capture source and output preset is resolved by a **letterbox** filter chain (`scale=W:H:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos` → `pad=W:H:(ow-iw)/2:(oh-ih)/2:color=<pad_color>` → `setsar=1` → `format=yuv420p`). Default pad color is black; pad color is a parameter on `EncodeConfig`.
- [x] **ENC-08** *(Phase 12)*: `EncodeConfig` separates `capture_width/height` (native source dims) from `output_width/height` (target preset dims); the FFmpeg argv builder consumes only `output_*` for `-s`, `-vf`, and bitrate scaling. Rawvideo stdin `-s` is always the capture dimensions.
- [x] **ENC-09** *(Phase 12)*: When capture source is smaller than the chosen `OutputResolution` on either axis, the encoder must NOT upscale — the image is kept at source size and letterboxed/pillarboxed inside the output frame.
- [x] **ENC-10** *(Phase 12)*: `bitrate_kbps` is used as the **target bitrate** (not a floor). Resolves tech-debt in `06-CLEANUP-BACKLOG.md:99`. Renames/refactors the current `max(pixel_based_kbps, self.bitrate_kbps).min(40_000)` formula so `self.bitrate_kbps` is authoritative and a separate `auto_bitrate` helper derives pixel-based suggestions when the caller opts in.
- [x] **ENC-11** *(Phase 12)*: Filter chain is built programmatically (not string-formatted) via a new `crates/encoder/src/filters.rs` module exposing `build_vf(output: &OutputSpec) -> String` that validates inputs and never emits un-escaped user strings into `-vf`.
- [ ] **ENC-12** *(Phase 13)*: Recording-time UI exposes 5 output knobs (Resolution / FPS / Fit mode / Pad color / Quality preset) bound 1:1 to Phase 12's OutputResolutionDto / FitModeDto / PadColorDto / QualityPresetDto / ScaleAlgoDto enums, rendered inside the Recording Setup panel of `recording-view.tsx` next to AudioDevicePicker / CursorToggle / ChromeHidingToggle.
- [ ] **ENC-13** *(Phase 13)*: Export modal exposes 8 export-only knobs (Container / Codec / Rate control / HW encoder / Preset / Keyframe / Downscale algo / Audio params) inside a single Base UI Accordion ("Tùy chọn nâng cao", collapsed by default) below the existing Basic surface; values flow into a new optional `encoder_options: EncoderOptionsDto` field on `ExportOutputDto`.
- [ ] **ENC-14** *(Phase 13)*: Preset model `Standard / High Quality / Quick / Custom` shared between Recording View and Export Modal via a single Zustand slice at `apps/desktop/src/state/output-prefs.ts`; overriding any individual knob automatically flips activePreset to `Custom`.
- [ ] **ENC-15** *(Phase 13)*: Output prefs persist via `tauri-plugin-store` under key `output-prefs.v1` (global) with silent-seed migration from Phase 12 hard-coded defaults on first launch (D-13-06: no modal, no toast); per-project override at `<project>/.storycapture/output.json` with precedence `project > global > seed`.
- [ ] **ENC-16** *(Phase 13)*: HW encoder picker shows `Auto` + probe-driven available encoders + `Software (libx264)`; unavailable encoders are hidden (no grey-out). Persisted-but-unavailable encoder shows soft warning + `(không khả dụng trên máy này)` suffix.
- [ ] **ENC-17** *(Phase 13)*: Live bitrate + file-size-per-minute estimate computed frontend-side from `(w*h*3/1000) * qMul[quality]` and rendered below the knob group (`~X.X Mbps • ~N MB/phút`).
- [ ] **ENC-18** *(Phase 13)*: Warning matrix — hard validation blocks Record/Export submit when Custom W/H is odd or outside `16..=7680 × 16..=4320`; soft inline warnings for `Lossless+output≥4K+HW encoder` and `output dims > capture dims`.
- [ ] **ENC-19** *(Phase 13)*: Persistent summary badge (`1080p • 30fps • Letterbox • Trung bình`) rendered next to the Record CTA; clicking scrolls/focuses the Video Output section.

### Post-Production (POST)

- [ ] **POST-01**: Typed filter-graph AST in `effects` crate (no string-concatenated filtergraphs)
- [ ] **POST-02**: Auto-zoom engine generates smooth pan/zoom keyframes from known click coords with cubic-bezier easing; dwell debounce, minimum shot length, max 2.5-3x zoom, low-pass filter; default "calm" preset
- [ ] **POST-03**: Cursor overlay renderer: custom cursor skins, click ripple animation, motion trails, minimum-jerk/Bezier interpolation between known waypoints
- [ ] **POST-04**: Background compositor: gradient/image backgrounds, rounded window frame, configurable drop shadow
- [ ] **POST-05**: Scene transitions via FFmpeg xfade (fade, dissolve, wipe) with optional GPU transitions
- [ ] **POST-06**: Sound mixer: per-step click sounds, transition whooshes, BGM track with volume-ducking around voiceover
- [ ] **POST-07**: Text overlay engine: step annotations, callout boxes, highlight rings via FFmpeg drawtext + overlay
- [ ] **POST-08**: Canonical filter-graph order enforced in code; snapshot test against reference PSNR
- [ ] **POST-09**: Effect presets system (save/load named configurations per project or globally)

### Export (EXPORT)

- [ ] **EXPORT-01**: Render final polished video using effect pipeline on top of raw recording
- [ ] **EXPORT-02**: Multi-format export: MP4, WebM, GIF
- [ ] **EXPORT-03**: Resolution presets: 720p, 1080p, 4K; configurable FPS and quality
- [ ] **EXPORT-04**: Batch export to multiple formats in one run
- [ ] **EXPORT-05**: Rendering runs in background with progress events; user can continue editing other stories
- [ ] **EXPORT-06**: 1-minute video renders in under 30 seconds on modern reference hardware (benchmark in CI)

### Desktop UI (UI)

- [ ] **UI-01**: Dashboard screen: grid/list of projects with last-export thumbnails, search/filter by name/date/tags, quick actions (New, Import, Recent)
- [ ] **UI-02**: Story Editor: CodeMirror 6 with custom DSL syntax highlighting, inline error markers, selector autocomplete from live DOM, resizable split panes
- [ ] **UI-03**: Story Editor: live browser preview panel with viewport switcher (desktop/tablet/mobile) and timeline panel showing scenes + steps
- [ ] **UI-04**: Recording View: recording indicator + timer, step progress bar, pause/resume/stop controls, live cursor trail visualization
- [ ] **UI-05**: Post-Production Editor: video timeline with scene markers and layer tracks (Video, Cursor, Zoom, Sound, Annotations), preview player with real-time effect rendering, effect preset panel, sound library browser with waveform previews, export settings panel
- [ ] **UI-06**: Settings screens: General, Automation, Effects, AI (API key config), Accounts, Keyboard shortcuts
- [ ] **UI-07**: Natural-Language Mode: chat-style authoring with DSL diff preview, per-step edit/approve, conversation history
- [ ] **UI-08**: Dark-first theme with optional light toggle; tokens blend Runway (primary) + Linear (editor/dashboard) + ElevenLabs (timeline/waveform) DESIGN.md references
- [ ] **UI-09**: JetBrains/Geist Mono for the DSL editor; Lucide icons; Motion (formerly Framer Motion) for micro-interactions
- [ ] **UI-10**: WCAG 2.1 AA across all custom UI (keyboard nav, focus management, screen-reader labels)
- [ ] **UI-11**: Undo/redo stack for story edits and post-production changes

### Intelligence (AI)

- [ ] **AI-01**: Natural-language → DSL conversion via LLM (Anthropic/OpenAI) with per-step diff preview and approve/edit flow
- [ ] **AI-02**: AI voiceover (TTS) generation via ElevenLabs or OpenAI TTS with auto-script from DSL steps
- [ ] **AI-03**: Voiceover ↔ timeline sync engine snaps TTS clips to DSL step boundaries
- [ ] **AI-04**: Dry-run mode executes automation without rendering for fast selector-debugging feedback
- [ ] **AI-05**: API keys stored in OS keychain via `tauri-plugin-keyring`; never persisted in plaintext or SQLite
- [ ] **AI-06**: CodeMirror LSP integration for hover, autocomplete, and diagnostics driven by the DSL grammar

### Web Companion (WEB)

- [ ] **WEB-01**: Next.js 15 App Router app with TypeScript, tRPC 11, Prisma 6 ORM, PostgreSQL
- [ ] **WEB-02**: NextAuth v5 with GitHub + Google OAuth providers, Prisma adapter
- [ ] **WEB-03**: Upload pipeline from desktop → S3/R2 via presigned multipart URLs (resumable)
- [ ] **WEB-04**: Shareable viewer page per video with embed code, chapter navigation from DSL scenes
- [ ] **WEB-05**: Team workspaces with role-based access (owner, editor, viewer) and shared asset libraries
- [ ] **WEB-06**: Story template marketplace: browse, fork, share (category taxonomy: SaaS onboarding, e-commerce, etc.)
- [ ] **WEB-07**: Viewer analytics: play count, watch duration, drop-off heatmap, geographic breakdown
- [ ] **WEB-08**: Desktop ↔ web WebSocket sync: recording status, project mirror, short-lived JWT auth with refresh

### Distribution & Ops (DIST)

- [ ] **DIST-01**: macOS distribution direct (not MAS): Developer ID signing + notarization + hardened runtime
- [ ] **DIST-02**: Windows distribution signed (Microsoft Trusted Signing or EV cert)
- [ ] **DIST-03**: Tauri built-in auto-updater with differential updates and signed update manifests
- [ ] **DIST-04**: Installer size < 50 MB (excluding FFmpeg sidecar); cold start < 2 s
- [ ] **DIST-05**: No telemetry by default; opt-in local crash/log collection only
- [ ] **DIST-06**: All web uploads encrypted in transit (HTTPS) and at rest (storage provider encryption)

### Phase 10 — Author-time Simulator (PHASE-10.x)

Added 2026-04-19 during /gsd-plan-phase 10. Internal identifier is "simulator"; user-visible term remains "dry-run / Preview to here". Phase 3's shipped `intelligence::dryrun` + `DryRunPanel.tsx` stay untouched (D-00).

- [ ] **PHASE-10.1**: `Executor::run_story` parameterized with `stop_after_ordinal: Option<u32>` — when `Some(n)`, executor emits `ExecutorEvent::RunPaused { ordinal: n }` after the nth step's `StepSucceeded` and returns without tearing down drivers or emitting `StoryEnded`. Recording path passes `None` — unchanged behavior.
- [ ] **PHASE-10.2**: Per-step `StepFrame { ordinal, screenshot_path, cursor_xy, matched_selector, matched_bbox: Option<BoundingBox>, duration_ms }` is captured inside the executor when `capture_frames=true`, written to `frame_dir`, and emitted via new `ExecutorEvent::StepFrameCaptured { ordinal, frame }`. `matched_bbox` is `None` for commands without a target (Navigate, Wait, Screenshot, WaitMs).
- [ ] **PHASE-10.3**: New Tauri commands `simulator_start`, `simulator_step_to`, `simulator_cancel`, `simulator_promote_fallback` live in `apps/desktop/src-tauri/src/commands/simulator.rs`. A session registry (`HashMap<SimulatorSessionId, ResumableSession>` behind `tokio::Mutex`) keeps the driver pair + last ordinal + story alive between `step_to` calls so re-invocation does NOT relaunch Chromium. Ordinal input is validated against total steps.
- [ ] **PHASE-10.4**: Simulator frame archive writes to `<project_folder>/.story.simulator/<run-uuid>/<ordinal>.png` (uuid v4). At `simulator_start` the code lists sibling run dirs, sorts by mtime descending, and unlinks all but the most recent 5 (retention policy).
- [ ] **PHASE-10.5**: `SimulatorTimeline.tsx` (React) consumes `simulatorStore` (Zustand) `frames: StepFrame[]` + `currentFrameOrdinal`. Scrubbing dispatches a CodeMirror `StateEffect` (`setActiveFrame`) that a `StateField<DecorationSet>` renders as a line-background + 2px accent-primary left stripe on the matching span.
- [ ] **PHASE-10.6**: Caret-context-menu item "Preview to here" + `Cmd-.` (macOS) / `Ctrl-.` (Windows) keyboard shortcut resolves caret line → ordinal via the parsed AST spans, then invokes `simulator_step_to(ordinal)`. Target: ≤10 s for a 20-step story on M2.
- [ ] **PHASE-10.7**: Simulator acquires exclusive lock on the 9-04 author session by calling `pause_author_preview(streamId)` (PHASE-9.9) before the executor runs, and `resume_author_preview(streamId)` on `RunPaused`, `StoryEnded`, `SimulatorCancelled`, or error. `simulator_start` fails with a typed error if `previewEnabled=false` — never silently spawns a new session.
- [ ] **PHASE-10.8**: Editor becomes `readOnly=true` and a banner ("Simulator running — edits paused · Step N / M") renders above the CodeMirror scroll area for the duration of an active run. Banner dismisses and editor re-enables on `RunPaused`, `StoryEnded`, or `SimulatorCancelled`. Scrubbing and line-highlight remain functional while `readOnly` is set.

### Phase 11 — Author-time Element Picker (PHASE-11.x)

Added 2026-04-19 during /gsd-plan-phase 11. Relocates the picker from the recording flow into the Preview panel (D-01..D-05) and turns the Record path into a strictly read-only consumer (D-06..D-08). All IDs trace to 11-CONTEXT.md D-01 … D-16 and 11-UI-SPEC.md locked copy.

- [ ] **PHASE-11.1**: A shared `AuthorDriverState` registry (`tokio::Mutex<AuthorDriverState>`) lives in `apps/desktop/src-tauri/src/author_driver.rs` with exactly five variants: `Idle`, `LivePreview { stream_id }`, `Picking { stream_id, resume_to }`, `SimulatorRunning { session }`, `SimulatorPaused { session }`. Both `commands/picker.rs` and `commands/simulator.rs` acquire the same lock. (D-16)
- [ ] **PHASE-11.2**: `PickerResumeGuard` provides RAII cleanup: Drop reverts the registry to the pre-pick state and best-effort calls `resume_author_preview`. Drop is shutdown-safe via `tokio::runtime::Handle::try_current().ok()` gate. (Pitfall 2)
- [ ] **PHASE-11.3**: The recording path (`commands/automation.rs launch_automation`) passes `self_heal=false` to the executor. Record runs never mutate `.story.targets.json`. (D-06)
- [ ] **PHASE-11.4**: A primary-miss during recording produces `AutomationError::PrimaryMissNoHeal { step_ordinal, step_id, verb }`. `try_promote_fallback` is unreachable from the record path. The error `Display` string matches the UI-SPEC-locked copy verbatim. (D-06)
- [ ] **PHASE-11.5**: The recorder HUD surfaces the D-06 error with the UI-SPEC-locked 2-line copy and an "Open in Simulator →" action that opens the Editor on the failed step (no auto-simulator start). A Sonner destructive toast shadows the HUD with the same copy + action. (D-06, UI-SPEC §5)
- [ ] **PHASE-11.6**: The sidecar `pickElement.start` accepts an optional `streamId` and routes to `state.previewPagesByStreamId.get(streamId)`. Unknown streamId throws with JSON-RPC code -32000; no fall-through to `state.page`. `state.authorBrowser` (Phase 7 snapshot browser) is NOT reused. (Pitfall 1, Pitfall 3)
- [x] **PHASE-11.7**: `picker_stamp_step_id` is provably byte-idempotent on re-pick of an already-stamped line: source bytes + mtime unchanged; `.story.targets.json` IS rewritten. The command returns a `was_freshly_stamped: bool` flag so callers can dispatch the correct UI copy. (D-04
, Pitfall 5)
- [ ] **PHASE-11.8**: Host-layer state machine enforces concurrency: `can_start_pick()` rejects when state is `SimulatorRunning` or `Picking`; `can_start_simulator()` rejects when state is `Picking`. `Picking` entered from `SimulatorPaused` carries `resume_to` and restores on exit. (D-13, D-14, D-15)
- [ ] **PHASE-11.9**: A new Tauri command `picker_start_author(stream_id, cursor_line)` orchestrates: acquire registry → transition to `Picking{resume_to}` → `replay_navigate_verbs` → `pause_author_preview` → sidecar pick → `resume_author_preview` (on ALL exit paths: success, user-cancel, navigation, unsupported-url, timeout, driver error, panic via guard). (D-12)
- [ ] **PHASE-11.10**: `replay_navigate_verbs` walks `story.scenes[*].commands[*]`; for every command with `meta().line <= cursor_line` and variant `Command::Navigate`, emits the URL via sidecar `author.navigateTo`. If list is empty, falls back to `story.meta.app`. Sidecar nav errors are best-effort (logged, not propagated). (D-10)
- [ ] **PHASE-11.11**: A new sidecar RPC `author.navigateTo(streamId, url)` performs `page.goto(url)` + `waitForLoadState('networkidle', { timeout: 10_000 })` against the streamId-keyed author page. Times out silently to unblock picker start. (Pitfall 4)
- [x] **PHASE-11.12**: A `PreviewPickerButton` component (`apps/desktop/src/features/editor/PreviewPickerButton.tsx`) is mounted inside `preview-panel.tsx` toolbar, left of the viewport/quality controls, with five visual states (Idle/LivePreview default, Picking active, Starting spinner, Disabled-SimulatorRunning, Active-from-SimulatorPaused). Tooltip + toast + banner copy strings appear verbatim per UI-SPEC §Copywriting. (D-01
, D-02, UI-SPEC)
- [x] **PHASE-11.13**: `Cmd-Shift-P` / `Ctrl-Shift-P` triggers the pick action via a CodeMirror 6 keymap extension in `codemirror-setup.ts` (NOT `document.addEventListener`). Behavior: editor focused + not `SimulatorRunning` → trigger pick; focused during `SimulatorRunning` → no-op (optional banner shake); focused during `Picking` → cancel. (D-01
, UI-SPEC §6)
- [ ] **PHASE-11.14**: The Phase 7 recorder-side picker is deleted: `pick-element-button.tsx`, `pick-element-button.test.tsx`, and the import + mount sites in `recording-view.tsx`. A new `11-SMOKE.md` operator runbook supersedes the record-path sections of `07-03b-SMOKE.md` and `07-04c-SMOKE.md`. (D-05)

## v2 Requirements (deferred, tracked)

### Advanced & Scale

- **ADV-01**: Diff-aware re-recording — detect UI changes and re-record only affected scenes
- **ADV-02**: Headless CLI tool for CI pipelines — runs stories and emits video artifacts
- **ADV-03**: Multi-viewport recording — same story at multiple viewport sizes composited into one video
- **ADV-04**: Native app automation — macOS Accessibility API + Windows UI Automation
- **ADV-05**: Plugin system for user-contributed effects, transitions, cursor skins
- **ADV-06**: Localization engine — re-run stories with different locale/language inputs
- **ADV-07**: Real-time multi-user collaborative story editing (CRDT-based)
- **ADV-08**: HDR delivery pipeline (HEVC Main10 via VideoToolbox)

## Out of Scope

| Feature | Reason |
|---------|--------|
| Linux desktop build | Not in v1 target platforms |
| Mac App Store distribution | Screen-recording apps restricted; direct distribution + notarization only |
| Mobile apps (iOS/Android) | Desktop + web only; mobile recording substituted by responsive-browser viewport |
| Webcam / PiP recording | Undermines reproducibility; conflicts with core value prop (story-first) |
| Full video NLE (non-linear editor) | Out of scope — ship clean MP4, users finish in Premiere/Final Cut if needed |
| Interactive click-through export | Different category (Arcade/Supademo); stay video-first |
| Live narration during capture | Breaks re-run reproducibility; use TTS voiceover instead |
| Cloud rendering | Hardware-accelerated local encode meets perf targets; preserves offline-first privacy |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| FOUND-01..08 | Phase 1 | Pending |
| DSL-01..07 | Phase 1 | Pending |
| AUTO-01..06 | Phase 1 | Pending |
| CAP-01..07 | Phase 1 | Pending |
| ENC-01..05 | Phase 1 | Pending |
| ENC-06..11 | Phase 12 | Planned |
| UI-01..04 (editor/recorder subset) | Phase 1 | Pending |
| UI-08, UI-09, UI-10 | Phase 1 | Pending |
| DIST-01..05 | Phase 1 | Pending |
| POST-01..09 | Phase 2 | Pending |
| EXPORT-01..06 | Phase 2 | Pending |
| UI-05, UI-11 | Phase 2 | Pending |
| AI-01..06 | Phase 3 | Pending |
| UI-07 | Phase 3 | Pending |
| WEB-01..08 | Phase 4 | Pending |
| UI-06 (Accounts subset) | Phase 4 | Pending |
| DIST-06 | Phase 4 | Pending |
| PHASE-10.1..10.2 | Phase 10 (10-01) | Pending |
| PHASE-10.3..10.4, 10.7 | Phase 10 (10-02) | Pending |
| PHASE-10.5..10.6, 10.8 | Phase 10 (10-03) | Pending |
| PHASE-11.1, 11.2, 11.7, 11.8 | Phase 11 (11-01) | Pending |
| PHASE-11.3..11.5 | Phase 11 (11-02) | Pending |
| PHASE-11.6, 11.9..11.11 | Phase 11 (11-03) | Pending |
| PHASE-11.12..11.14 | Phase 11 (11-04) | Pending |

**Coverage:**
- v1 requirements: 87 total
- Mapped to phases: 87
- Unmapped: 0 ✓

---
*Requirements defined: 2026-04-14*
*Last updated: 2026-04-19 — added PHASE-11.1 … PHASE-11.14 for /gsd-plan-phase 11.*
