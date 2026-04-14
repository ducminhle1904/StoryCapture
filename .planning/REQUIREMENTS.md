# Requirements: StoryCapture

**Defined:** 2026-04-14
**Core Value:** Turn a written story into a polished, shareable demo video automatically — no recording, editing, or video-production skill required.

## v1 Requirements

### Foundation (FOUND)

- [ ] **FOUND-01**: Turborepo + Cargo workspace scaffolded with `apps/desktop`, `apps/web`, `packages/{shared-types,story-dsl,ui,config}`, `crates/{story-parser,automation,capture,effects,encoder,storage}`
- [ ] **FOUND-02**: Tauri v2 desktop shell boots on macOS (arm64 + x64) and Windows x64 with React 19 + Vite + Tailwind v4 + shadcn/ui + Base UI (`base-vega`) initialized
- [ ] **FOUND-03**: Typed IPC codegen via `tauri-specta` (or `specta`) emits shared TypeScript types for all Tauri commands and events
- [ ] **FOUND-04**: Structured logging via `tracing` + `tauri-plugin-log` with local log files (no telemetry by default)
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
- [ ] **AUTO-03**: Smart selector engine with fallback chain: visible text → data-testid → aria-label → CSS selector, with attempt logging
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

**Coverage:**
- v1 requirements: 73 total
- Mapped to phases: 73
- Unmapped: 0 ✓

---
*Requirements defined: 2026-04-14*
*Last updated: 2026-04-14 after initial definition*
