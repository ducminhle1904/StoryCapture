# Roadmap: StoryCapture

**Created:** 2026-04-14
**Granularity:** coarse
**Core Value:** Turn a written story into a polished, shareable demo video automatically — no recording, editing, or video-production skill required.

## Overview

Four v1 phases derived from requirement dependencies and research guidance. Phase 5 (Extensibility & Reach) is deferred to v2 and tracked under v2 Requirements in REQUIREMENTS.md — it is not part of the active v1 roadmap.

The ordering is dependency-forced: DSL → Automation → Capture → Encode is a strict chain; post-production depends on encoded frames; AI authoring depends on a stable DSL; web sharing depends on local content. All three highest-risk pitfalls (FFmpeg notarization, native-capture permission flows, chromiumoxide maturity) are pulled into Phase 1 so later phases do not pay compound interest.

## Phases

- [ ] **Phase 1: Foundation — DSL, Automation, Capture, Encode** - End-to-end pipeline from `.story` file to signed, playable MP4 on macOS and Windows
- [ ] **Phase 2: Cinematic Post-Production & Export** - Screen Studio-grade polish layer (auto-zoom, cursor, transitions, sound, overlays) with multi-format export and post-pro editor UI
- [ ] **Phase 3: Intelligence Layer — AI Authoring & Voiceover** - Natural-language → DSL chat, AI TTS synced to steps, LSP-powered editor assistance
- [ ] **Phase 4: Web Companion & Sharing** - Next.js 15 companion with OAuth, upload, shareable embed, workspaces, analytics, and desktop↔web sync

## Phase Details

### Phase 1: Foundation — DSL, Automation, Capture, Encode
**Goal**: A developer can write a `.story` file, run it in StoryCapture, and get a signed, playable MP4 recorded via native screen capture on macOS or Windows.
**Depends on**: Nothing (first phase)
**Requirements**: FOUND-01, FOUND-02, FOUND-03, FOUND-04, FOUND-05, FOUND-06, FOUND-07, FOUND-08, DSL-01, DSL-02, DSL-03, DSL-04, DSL-05, DSL-06, DSL-07, AUTO-01, AUTO-02, AUTO-03, AUTO-04, AUTO-05, AUTO-06, CAP-01, CAP-02, CAP-03, CAP-04, CAP-05, CAP-06, CAP-07, ENC-01, ENC-02, ENC-03, ENC-04, ENC-05, UI-01, UI-02, UI-03, UI-04, UI-08, UI-09, UI-10, DIST-01, DIST-02, DIST-03, DIST-04, DIST-05
**Success Criteria** (what must be TRUE):
  1. User can open the desktop app (cold start under 2 s), see the Dashboard, create a project, and edit a `.story` file in the CodeMirror editor with live DSL syntax highlighting, selector autocomplete, and inline diagnostics.
  2. User can press Record and watch StoryCapture drive a real browser through every supported DSL verb (navigate, click, type, scroll, hover, drag, select, upload, wait, wait-for, assert, screenshot, pause) while seeing live step progress, cursor trail, and recording HUD.
  3. When recording completes, the app produces a playable MP4 (H.264) encoded through the bundled FFmpeg sidecar using hardware acceleration (VideoToolbox / NVENC / QSV) with audio/video drift under 100 ms.
  4. Signed, notarized installers (macOS Developer ID + hardened runtime; Windows signed) under 50 MB (excluding FFmpeg) are produced by GitHub Actions on every PR for macOS arm64, macOS x64, and Windows x64, with auto-updater wired and telemetry off by default.
  5. On macOS, Screen Recording TCC permission is handled via preflight probe, guided prompt, and relaunch-after-grant; on both OSes, multi-display and retina scaling are correct and a 30-minute capture soak stays under 800 MB RAM.
**Plans**: TBD
**UI hint**: yes

### Phase 2: Cinematic Post-Production & Export
**Goal**: Users can turn a raw recording into a Screen Studio-grade polished video with auto-zoom, smooth cursor, transitions, sound, and overlays, then export to multiple formats from a dedicated editor.
**Depends on**: Phase 1
**Requirements**: POST-01, POST-02, POST-03, POST-04, POST-05, POST-06, POST-07, POST-08, POST-09, EXPORT-01, EXPORT-02, EXPORT-03, EXPORT-04, EXPORT-05, EXPORT-06, UI-05, UI-11
**Success Criteria** (what must be TRUE):
  1. After any Phase 1 recording, the user sees a polished preview in the Post-Production Editor with auto-zoom pan/zoom keyframes, smooth cursor with click ripples, rounded-window framing on a background, scene transitions, and optional text overlays and BGM — all driven by the click coords and step timings captured in Phase 1.
  2. User can open a timeline with layer tracks (Video, Cursor, Zoom, Sound, Annotations), scrub the preview player with real-time effect rendering, adjust per-effect settings, and save/load named effect presets per project or globally.
  3. User can export the polished video to MP4, WebM, or GIF at 720p / 1080p / 4K with configurable FPS and quality, including a batch export that renders multiple formats in one run.
  4. A 1-minute polished video renders in under 30 seconds on reference hardware (verified by a CI benchmark), runs in the background with live progress events, and does not block editing of other stories.
  5. Every edit to a story or post-production setting is reversible through a multi-step undo/redo stack.
**Plans**: TBD
**UI hint**: yes

### Phase 3: Intelligence Layer — AI Authoring & Voiceover
**Goal**: Non-developers can author stories in natural language and add AI voiceovers synced to DSL steps, while DSL authors get LSP-powered editor assistance and a fast dry-run loop.
**Depends on**: Phase 2
**Requirements**: AI-01, AI-02, AI-03, AI-04, AI-05, AI-06, UI-07
**Success Criteria** (what must be TRUE):
  1. In Natural-Language Mode, user can describe a demo in plain English and get a DSL proposal with a per-step diff preview that can be edited, approved, or rejected, with conversation history preserved per project.
  2. User can generate an AI voiceover (ElevenLabs or OpenAI TTS) from an auto-script derived from DSL steps, preview it in the post-production timeline, and see TTS clips snap to DSL step boundaries.
  3. In the DSL editor, hover, autocomplete, and diagnostics are driven by a live LSP connected to the pest grammar, and the smart selector engine surfaces fallback attempts and retries in the UI.
  4. User can run a Dry-Run that executes browser automation end-to-end without capture or render, producing selector-debugging feedback in seconds instead of a full recording cycle.
  5. All LLM and TTS API keys are stored in the OS keychain via `tauri-plugin-keyring` and never appear in plaintext on disk or in SQLite.
**Plans**: TBD
**UI hint**: yes

### Phase 4: Web Companion & Sharing
**Goal**: Users can sign in to a Next.js companion, upload polished videos from desktop, share them via embeddable viewer pages, collaborate in team workspaces, and watch analytics — with recording status mirrored live from desktop.
**Depends on**: Phase 3
**Requirements**: WEB-01, WEB-02, WEB-03, WEB-04, WEB-05, WEB-06, WEB-07, WEB-08, UI-06, DIST-06
**Success Criteria** (what must be TRUE):
  1. User can sign in to the web app with GitHub or Google OAuth (NextAuth v5), land on a dashboard of their videos, and open a shareable viewer page per video with an embed code and DSL-derived chapter navigation.
  2. From the desktop app's Settings → Accounts, user can connect a web account and upload a polished export to S3/R2 via resumable presigned multipart URLs, encrypted in transit and at rest.
  3. User can create a team workspace, invite members with owner/editor/viewer roles, share an asset library, and browse/fork entries in a template marketplace organized by category.
  4. While recording on desktop, a connected web dashboard shows live recording status and project mirror via an authenticated WebSocket channel with short-lived JWT auth and reconnect.
  5. Each video's viewer page shows play count, watch duration, drop-off heatmap, and geographic breakdown for the owner or workspace editors.
**Plans**: TBD
**UI hint**: yes

## Progress

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Foundation — DSL, Automation, Capture, Encode | 0/0 | Not started | - |
| 2. Cinematic Post-Production & Export | 0/0 | Not started | - |
| 3. Intelligence Layer — AI Authoring & Voiceover | 0/0 | Not started | - |
| 4. Web Companion & Sharing | 0/0 | Not started | - |

## Coverage

- v1 requirements: 73
- Mapped to phases: 73
- Orphaned: 0
- Duplicates: 0

v2 items (ADV-01..08) tracked in REQUIREMENTS.md under v2 Requirements; out of scope for this roadmap.

---
*Roadmap created: 2026-04-14*
