# Roadmap: StoryCapture

**Created:** 2026-04-14
**Granularity:** coarse
**Core Value:** Turn a written story into a polished, shareable demo video automatically — no recording, editing, or video-production skill required.

## Overview

Four v1 phases derived from requirement dependencies and research guidance. Phase 5 (Extensibility & Reach) is deferred to v2 and tracked under v2 Requirements in REQUIREMENTS.md — it is not part of the active v1 roadmap.

The ordering is dependency-forced: DSL → Automation → Capture → Encode is a strict chain; post-production depends on encoded frames; AI authoring depends on a stable DSL; web sharing depends on local content. All three highest-risk pitfalls (FFmpeg notarization, native-capture permission flows, chromiumoxide maturity) are pulled into Phase 1 so later phases do not pay compound interest.

## Phases

- [x] **Phase 1: Foundation — DSL, Automation, Capture, Encode** - End-to-end pipeline from `.story` file to signed, playable MP4 on macOS and Windows (code-complete; 2 operator-gated verification steps pending)
- [x] **Phase 2: Cinematic Post-Production & Export** - Screen Studio-grade polish layer (auto-zoom, cursor, transitions, sound, overlays) with multi-format export and post-pro editor UI (code-complete; 2 operator-gated verification steps pending)
- [x] **Phase 3: Intelligence Layer — AI Authoring & Voiceover** - Natural-language → DSL chat, AI TTS synced to steps, LSP-powered editor assistance (code-complete; 1 operator-gated verification step pending)
- [x] **Phase 4: Web Companion & Sharing** - Next.js 15 companion with OAuth, upload, shareable embed, workspaces, analytics, and desktop↔web sync (code-complete; 1 operator-gated verification step pending)
- [x] **Phase 12: Fix video output resolution lock — letterbox filter chain** - Backend + IPC only. Output video matches user-selected resolution exactly via `scale + pad + setsar` letterbox chain. Splits capture dims from output dims in `EncodeConfig`. Fixes `bitrate_kbps`-as-floor tech-debt. (completed 2026-04-20)
- [x] **Phase 13: Video output customization knobs — recording + export UI** - UI exposure of resolution/FPS/fit-mode/pad-color/quality at recording time and container/codec/rate-control/HW-encoder/preset/keyframe/downscale/audio at export time. Per-encoder quality preset mapping. Depends on Phase 12. (completed 2026-04-20)

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
**Plans**: 11 plans
- [x] 01-01-PLAN.md — Monorepo scaffold (Turborepo + pnpm + Cargo workspace) + PR-build CI matrix
- [x] 01-02-PLAN.md — Wave-0 release gate: universal static FFmpeg + E2E macOS notarize smoke
- [x] 01-03-PLAN.md — Tauri v2 host (Rust-only): plugins, typed IPC (tauri-specta), error/logging/panic/keyring
- [x] 01-03b-PLAN.md — React 19/Vite 6/Tailwind v4/shadcn+Base UI frontend + typed IPC wrapper + panic modal (UI-09)
- [x] 01-04-PLAN.md — Story DSL parser crate (pest + two-layer + Levenshtein + panic-mode) + TS AST mirror
- [x] 01-05-PLAN.md — Storage crate (two-tier rusqlite + rusqlite_migration + portable project folders)
- [x] 01-06-PLAN.md — BrowserDriver trait + chromiumoxide + Playwright sidecar (Node SEA) + smart selector + auto-wait
- [x] 01-07-PLAN.md — Capture crate (SCK/WGC/xcap + byte-bounded queue + TCC UX + 30-min soak) ⚠ CI soak pending operator trigger
- [x] 01-08-PLAN.md — Encoder crate (FFmpeg sidecar lifecycle + HW probe + frame pump + ffprobe A/V drift CI)
- [x] 01-09-PLAN.md — Desktop UI (Dashboard + Story Editor + Recording View + blended theme + WCAG 2.1 AA)
- [x] 01-10-PLAN.md — Release CI (tag-triggered sign/notarize/publish) + Windows signing + auto-updater + installer-size budget + release soak ⚠ 13 GitHub Secrets + first tagged release pending
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
**Plans**: 14 plans
- [x] 02-01-PLAN.md — Effects AST + canonical-order builder + dual emitters + POST-08 snapshots
- [x] 02-02-PLAN.md — Math primitives (minimum-jerk, spring, Perlin, low-pass, easing)
- [x] 02-03-PLAN.md — project.sqlite v2 migrations + preset storage + .scpreset I/O + 5 bundled presets
- [x] 02-04-PLAN.md — WebGPU/WebGL2 preview engine bootstrap + VideoFrame lifecycle + stub shaders
- [x] 02-05-PLAN.md — Auto-zoom planner (Dynamic/Calm/Subtle presets) + zoompan emitter
- [x] 02-06-PLAN.md — Cursor overlay engine (min-jerk + ripple + 5 bundled skins + PNG sequence)
- [x] 02-07-PLAN.md — Background compositor (10 gradient presets + rounded frame + shadow) + xfade transitions + OpenCL probe
- [x] 02-08-PLAN.md — Sound mixer (click SFX + BGM ducking + curated 20-file sound pack + attribution) ⚠ 20 CC0 audio files need manual curation + human listen-test (see `02-08-RESUME.md` + `scripts/curate-sound-library.md`)
- [x] 02-09-PLAN.md — Text overlay engine (drawtext + callouts + highlight rings + 5 bundled fonts)
- [x] 02-10-PLAN.md — Render queue actor + FFmpeg sidecar pool + smart-batch fan-out + EXPORT-06 CI benchmarks (PR speed-factor + release wall-clock)
- [x] 02-11-PLAN.md — Export pipeline (MP4/WebM/GIF × 720/1080/4K × FPS × quality) + batch + POST-08 two-phase PSNR regression
- [x] 02-12a-PLAN.md — Post-Production Editor state + IPC (Zustand slices + Tauri commands + IPC wrappers + undo bridge)
- [x] 02-12b-PLAN.md — Post-Production Editor React UI (5-track timeline + preview player + inspector + sound drawer + export modal + queue widget + formal human-verify) ⚠ human-verify walkthrough pending (see `02-12b-RESUME.md`)
- [x] 02-13-PLAN.md — Per-action coalesced undo/redo (50-step ring buffer, cmd+z/shift+z)
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
**Plans**: 21 plans
- [x] 03-01-PLAN.md — Intelligence crate skeleton + LlmProvider/TtsProvider traits + secret redaction (G1)
- [x] 03-02-PLAN.md — SQLite V5 migration: nl_conversations + tts_cache_index + llm/tts_clip_metrics + session_rollup view
- [x] 03-03-PLAN.md — Keychain (tauri-plugin-keyring) commands for 4 providers + no-leak test
- [x] 03-04-PLAN.md — AnthropicProvider streaming with prompt caching + tool-use partial-JSON accumulator
- [x] 03-05-PLAN.md — OpenAiProvider fallback with Chat Completions streaming + response_format:json_schema
- [x] 03-06-PLAN.md — NL→DSL orchestrator: schemas + prompt templates + verb whitelist retry + diff engine + goldens
- [x] 03-07-PLAN.md — NL Tauri IPC (nl_chat_send + 5 more) + token metrics persistence + cancel registry
- [x] 03-08-PLAN.md — ElevenLabsProvider streaming + 6 curated voice presets + voice catalog fetch
- [x] 03-09-PLAN.md — OpenAiTtsProvider fallback (/v1/audio/speech) + 6 built-in voices
- [x] 03-10-PLAN.md — Auto-script generator: per-step NarrationDraft from DSL via LLM tool-use
- [x] 03-11-PLAN.md — TTS cache (hash + sanitized path) + 4 Tauri commands + metrics + GC
- [x] 03-12-PLAN.md — Voiceover↔timeline sync (TTS ground truth) + BGM duck events (Phase 2 D-22)
- [x] 03-13-PLAN.md — tower-lsp LanguageServer over story_parser: did_open/change, diagnostics, hover, completion
- [x] 03-14-PLAN.md — LSP Tauri IPC bridge (NOT stdio) + CodeMirror 6 extension
- [x] 03-15-PLAN.md — Selector heuristic linter (6 rules) + 30-fixture corpus meeting E11 thresholds
- [x] 03-16-PLAN.md — Dry-Run orchestrator + Tauri commands (reuses Phase 1 BrowserDriver)
- [x] 03-17-PLAN.md — NL chat panel UI (ChatPanel + DiffCard + streaming/error states) per UI-SPEC
- [x] 03-18-PLAN.md — Dry-Run panel + selector fallback popover + editor gutter integration
- [x] 03-19-PLAN.md — Voice catalog + script editor + TTS clip inspector UI
- [x] 03-20-PLAN.md — Accounts settings + token counter + cost warning + AI disclosure (G7/G8/G9) + human-verify ⚠ human-verify walkthrough pending (see `03-20-RESUME.md`)
- [x] 03-21-PLAN.md — Golden dataset (25 prompts) + eval harness + offline PR CI + nightly live-LLM CI

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
**Plans**: 10 plans
Plans:
- [x] 04-01-PLAN.md — Next.js 15 scaffold + Prisma schema (12 models) + tRPC 11 setup + Tailwind v4
- [x] 04-02-PLAN.md — NextAuth v5 (GitHub + Google OAuth) + Prisma adapter + desktop token exchange + auth-gated dashboard
- [x] 04-03-PLAN.md — Desktop Settings > Accounts panel + OAuth flow + keychain token storage
- [x] 04-04-PLAN.md — Upload pipeline: R2 multipart presigned URLs + desktop upload commands + progress UI
- [x] 04-05-PLAN.md — Shareable viewer page + iframe embed + oEmbed endpoint + privacy toggle + slug editor
- [x] 04-06-PLAN.md — Team workspaces with RBAC (owner/editor/viewer) + invite flow + workspace UI
- [x] 04-07-PLAN.md — Template marketplace: curated seed data (12 templates, 9 categories) + fork + category grid
- [x] 04-08-PLAN.md — Analytics pipeline: event ingestion + GeoIP + session tracking + dashboard (play/duration/dropoff/geo)
- [x] 04-09-PLAN.md — Desktop-web sync: SSE subscriptions + metadata push + recording status + offline queue
- [x] 04-10-PLAN.md — Final integration + dashboard navigation + landing page + human-verify checkpoint ⚠ human-verify walkthrough pending (see `04-10-RESUME.md`)
**UI hint**: yes

## Progress

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Foundation — DSL, Automation, Capture, Encode | 11/11 | Code-complete (2 verification steps pending) | 2026-04-15 |
| 2. Cinematic Post-Production & Export | 14/14 | Code-complete (2 verification steps pending) | 2026-04-15 |
| 3. Intelligence Layer — AI Authoring & Voiceover | 21/21 | Code-complete (1 verification step pending) | 2026-04-15 |
| 4. Web Companion & Sharing | 10/10 | Code-complete (1 verification step pending) | 2026-04-15 |
| 5. Window-targeted capture + Playwright auto-follow | 3/3 | Shipped | 2026-04-17 |
| 6. Recording v2 — audio, region, chrome-hiding | 3/4 | Shipped (06-03 live-preview deferred to Phase 9) | 2026-04-17 |
| 7. Semantic DSL verbs + element picker | 7/7 | Shipped | 2026-04-19 |
| 8. Recording engine polish — GPU downscale + live cursor overlay | 0/5 | **Planned, not started** | — |
| 9. Live Preview pane (CDP-driven) | 0/4 | **Planned, not started** — prereq for Phase 10 | — |
| 10. Author-time simulator | 0/3 | **Blocked on Phase 9-04 extensions (PHASE-9.8/9.9)** | — |
| 11. Author-time element picker relocation | 0/4 | **Blocked on Phase 10-01/02** (11-01 can run in parallel with 10-01) | — |
| 12. Fix video output resolution | 4/4 | Shipped | 2026-04-19 |
| 13. Video output customization knobs | shipped | Shipped | 2026-04-19 |
| 14. Port Claude Design into apps/desktop | 4/4 (waves 1, 3-5; Wave 2 dropped) | **In progress** — Waves 1/3/4 shipped, polish ongoing, Wave 5 a11y checkpoint pending | — |
| 15. Editor/Post-Production feature boundary cleanup | 4/5 | **In progress** — Waves 1-4 shipped, Wave 5 a11y checkpoint pending | — |

## Coverage

- v1 requirements: 73
- Mapped to phases: 73
- Orphaned: 0
- Duplicates: 0

v2 items (ADV-01..08) tracked in REQUIREMENTS.md under v2 Requirements; out of scope for this roadmap.

### Phase 5: Window-targeted screen capture with Playwright auto-follow

**Goal:** Replace full-screen xcap capture with window-aware capture (macOS SCK + Windows WGC) + Playwright auto-follow so StoryCapture records only the demo browser, never its own UI.
**Requirements**: PHASE-5.1, PHASE-5.2, PHASE-5.3, PHASE-5.4
**Depends on:** Phase 4
**Plans:** 3 plans

Plans:
- [x] 05-01-PLAN.md — macOS SCK streaming + window/display picker UI + xcap fallback + 2nd-failure modal + sticky target persistence
- [x] 05-02-PLAN.md — Playwright auto-follow: browserProcess sidecar verb + pid→SCWindow bridge + UI auto-enable + E2E smoke binary
- [x] 05-03-PLAN.md — Windows WGC parity (windows-capture 2.0.0) + list_windows + pid→HWND + CI build gate

### Phase 6: Recording v2 — audio, region capture, chrome-hiding, multi-browser auto-follow, live preview

**Goal:** Polish the recording pipeline to production-grade quality by shipping Phase 5's deferred features — opt-in microphone audio, per-display region capture, Chromium chrome-hiding via `--app`, multi-browser auto-follow (Edge/Brave/Chrome channels), static 2s-refresh live preview thumbnail, per-recording cursor toggle, and Windows real-capture E2E CI infrastructure.
**Requirements**: PHASE-6.1, PHASE-6.2, PHASE-6.3, PHASE-6.4
**Depends on:** Phase 5
**Plans:** 4 plans

Plans:
- [x] 06-01-PLAN.md — Mic audio capture (cpal + ringbuf + named pipe + FFmpeg dual-input mux) + device picker + mid-record failure UX
- [x] 06-02-PLAN.md — Region capture (SCK source_rect + Windows CPU crop) + Chromium `--app` chrome-hiding + non-sticky cursor toggle
- [ ] 06-03-PLAN.md — Multi-browser title-hint map (Edge/Brave/Chrome channels) + 2s live preview thumbnail (SCScreenshotManager / single-frame WGC)
- [x] 06-04-PLAN.md — Windows real-capture E2E: workflow_dispatch-only workflow on self-hosted graphical runner + operator runbook fallback

### Phase 7: Semantic DSL verbs + element picker (Tier 1 + Tier 2)

**Goal:** Make the StoryCapture DSL authorable by non-developers. Tier 1 promotes accessibility-first locators (`click button "Save"`, `fill field "Email" with "..."`) into first-class DSL syntax that compiles to Playwright `getByRole`/`getByLabel`/`getByText`. Tier 2 adds a "Pick element" button that drives an in-browser overlay picker to emit the best Tier 1 DSL line at the editor cursor, with an MVP (primary locator) shipping first and a robustness plan (ranked fallback persistence + self-healing) landing after.
**Requirements**: PHASE-7.1, PHASE-7.2, PHASE-7.3, PHASE-7.4, PHASE-7.5
**Depends on:** Phase 5
**Plans:** 7 plans

Plans:
- [x] 07-01-PLAN.md — Grammar + AST: role-qualified `target_role`, `target_field`, `target_text_kw` rules; `SelectorOrText::{Role,Label,TextExact}` variants; `AriaRole` enum; `cmd_fill` sugar desugaring to `Type`; did-you-mean role suggestions; backwards compat tests
- [x] 07-02-PLAN.md — SmartSelector + sidecar + driver marshalling: `SelectorStrategy::{Role,Label,TextExact}` short-circuits; sidecar `locate()` / `targetToLocator()` branches; `playwright_driver::target_to_json()` coverage for the three new variants; E2E fixture tests
- [x] 07-03a-PLAN.md — Tier 2 MVP sidecar: overlay IIFE bundle (esbuild) + SEA embed + ranked generator (testid → role+name → label → text → css) + `pickElement.start/cancel/isActive` handlers + addInitScript injection + URL allowlist + framenavigated auto-cancel + real-Chromium vitest for all 5 ranks; wire contract `result.emitted`
- [x] 07-03b-PLAN.md — Tier 2 MVP desktop: Rust `PickElementResponse::Picked { emitted: String, ... }` + driver wrappers + Tauri `picker_*` commands + TS IPC + `editorController` singleton (atomic single-undo insertion) + `PickElementButton` + aria-live banner + desktop vitest proving end-to-end wire-contract flow (PHASE-7.4 final gate)
- [x] 07-04a-PLAN.md — Tier 2 robustness notifications: `JsonRpcResponse.id: Option<u64>` + broadcast channel + `subscribe_notifications()` + sidecar `writeNotification` + `pickElement.hoverPreview` + overlay rAF-throttled emit + Tauri event bridge + React preview chip
- [x] 07-04b-PLAN.md — Tier 2 robustness parser: additive pest `step_id_comment` rule (Tier 1 regression-guarded) + `LineMeta.step_id: Option<Uuid>` + warn-on-invalid-UUID + minimal `story_parser::formatter::format_story` + 3 parse-format-parse fixpoint tests + insta snapshot
- [x] 07-04c-PLAN.md — Tier 2 robustness self-healing: `targets_store.rs` with atomic tmp+rename + executor fallback promotion hook + `picker_stamp_step_id` Tauri command (stamps UUIDv7 on first pick via formatter, seeds targets.json) + integration test (primary-miss → fallback-promoted → targets rewritten, source untouched) + PHASE-7.5 final gate
- [x] 07-05-PLAN.md — Author-time selector validator + hover-preview: DOM+screenshot snapshot cache per navigated URL; CodeMirror gutter chip (GREEN unique / YELLOW fuzzy / RED miss) driven by the same ranked locator engine as the picker (reverse direction); hover a DSL step → Preview panel shows the cached screenshot with the matched element boxed; "Promote to fallback" action writes into `.story.targets.json` — shares the 07-04c self-healing schema

### Phase 8: Recording engine polish — GPU downscale + live cursor overlay

**Goal:** Two recording-engine polish items that unblock 4K→1080p downscaled captures and visually-consistent cursor rendering across platforms. GPU-side downscale path avoids CPU-bound FFmpeg software scale on high-resolution sources; live cursor overlay composites a synthetic cursor sprite on the captured frames when the native OS cursor is hidden (e.g. Chromium `--app` chrome-hide mode from Phase 6).

**Depends on:** Phase 6 (CaptureConfig + include_cursor shipped ✓)
**Plans:** 5 plans (CONTEXT.md locked)

**Status:** Planned, not started. Blocking state: `crates/gpu_scale/` scaffolding (08-01 wave 1) never executed. No executor has picked this up yet.

Plans:
- [ ] 08-01 — `crates/gpu_scale/` scaffold (trait + error + platform stubs) + `EncodeConfig.upstream_scale_applied` field + `RecordingEvent::GpuScaleFailed` variant
- [ ] 08-02 — macOS GPU scaler impl (Metal / VideoToolbox)
- [ ] 08-03 — Windows GPU scaler impl (D3D11)
- [ ] 08-04 — Live cursor overlay crate + composite pipeline
- [ ] 08-05 — Recording UI toggles + integration tests

---

### Phase 9: Live Preview pane — render Chromium automation inside the Recorder window via CDP Page.startScreencast

**Goal:** Render the Playwright-driven Chromium visually inside the StoryCapture Recorder window while it automates, eliminating the need for the user to watch an external browser window. Preview is cosmetic — the final recording still uses real-Chromium pixels via SCK/WGC window capture (NOT screencast frames). Backed by Chrome DevTools Protocol `Page.startScreencast` (base64 JPEG frames @ ≤25 fps), bridged through the existing playwright-sidecar into a Tauri event stream consumed by a React canvas renderer.

**Depends on:** Phase 5 (window-target capture — shipped), quick task 260418-ios (focus-steal fix — shipped)

**In scope:**
- Sidecar CDP verbs `startPreviewStream` / `stopPreviewStream` wrapping `Page.startScreencast` + `Page.screencastFrameAck`
- Rust → React bridge via Tauri event `preview://frame`
- `<LivePreview />` canvas component in RecordingView left zone
- Options toggle "Live preview" (default ON)
- Backpressure + drop-under-load; preview failure must NOT affect capture
- Graceful fallback when CDP unavailable (non-Chromium backends)

**Out of scope:**
- Using screencast frames for the final video (quality regression)
- Input forwarding from the preview canvas back into Chromium
- Cursor-overlay compositing on the preview (CursorTrail stays on final video)
- Preview for non-Playwright capture targets (display / generic window)

**Acceptance criteria:**
- Recording with a Playwright target renders automation live in-app at ≥15 fps
- Toggling "Live preview" off does not disturb recording behavior
- Occluded / offscreen / background Chromium still streams (PID-bound, not window-bound)
- Final video bitrate, frame count, and encoder selection unchanged vs. pre-phase
- All Phase 5 capture tests remain green
- CPU cost of preview ≤15% on a 2023 M2 MBP; frame rate degrades gracefully under load

**Requirements:** TBD
**Plans:** 0 plans

Plans (proposed split; finalized in /gsd-plan-phase 9):
- [ ] 09-01 — Sidecar CDP screencast verbs + Rust event bridge
- [ ] 09-02 — React `<LivePreview />` canvas renderer + Options toggle
- [ ] 09-03 — Perf / backpressure hardening + fallback UX
- [ ] 09-04 — Editor-surface Live Preview + viewport switcher: reuse `LivePreview.tsx` inside the Editor page; multi-stream sidecar (`streamId` param on `startPreviewStream`); ephemeral author-time Playwright session separate from recording; viewport switcher drives `page.setViewportSize()` via new `setViewport` RPC; default-off toggle to preserve cold-start budget. **Also (PHASE-9.8 / PHASE-9.9 — Phase 10 prerequisites):** expose the author-session `Page` handle to Rust (`attach_author_driver(streamId)`) so Phase 10 can drive verbs against it; add `pauseStream` / `resumeStream` sidecar RPCs + Tauri commands for exclusive-lock concurrency

### Phase 10: Author-time simulator — step-preview + dry-run walkthrough

**Goal:** Give the Editor page an "execute without recording" mode so authors can validate a DSL before committing to a recording. Two user-visible features share one infrastructure layer: (a) "Preview to here" — run DSL from scene start up to the caret line, then pause and show the resulting page state in the Preview panel; (b) "Dry run" — replay the full DSL with per-step screenshots + matched-element bboxes + cursor trajectories into a scrubable timeline. DSL lines link bidirectionally to timeline frames.

**Depends on:** Phase 7 (locator engine + `.story.targets.json`), Phase 9 (ephemeral Playwright session + CDP screencast pipeline), Phase 9-04 (Editor-surface Live Preview)

**Naming note:** User-visible term stays "dry-run" / "Preview to here". **Internal identifiers use "simulator"** (SimulatorTimeline.tsx, simulatorStore.ts, simulator_* commands, SimulatorEvent, .story.simulator/) to avoid collision with Phase 3's shipped DryRunPanel + intelligence::dryrun + dryrun_start/_cancel commands, which stay in place for the duration of Phase 10.

**In scope:**
- `Executor::run_story` parameterized: threads `stop_after_ordinal: Option<u32>`, `capture_frames: bool`, `frame_dir: Option<PathBuf>`, `self_heal: bool`. Recording path unchanged.
- New executor events: `ExecutorEvent::RunPaused { ordinal }` + `ExecutorEvent::StepFrameCaptured { ordinal, frame }`
- Per-step frame capture: `StepFrame { ordinal, screenshot_path, cursor_xy, matched_selector, matched_bbox: Option<Bbox>, duration_ms }`
- New `BrowserDriver::element_state` trait method wrapping sidecar `elementState` (NoopDriver returns `None`)
- Simulator Tauri commands `simulator_start / _step_to / _cancel / _promote_fallback` running against the 09-04 author session via new `attach_author_driver(streamId)` (PHASE-9.8)
- Exclusive-lock concurrency with Live Preview via `pause_author_preview` / `resume_author_preview` (PHASE-9.9)
- `.story.simulator/<run-uuid>/` frame archive (retention: 5 most recent runs)
- `SimulatorTimeline.tsx` + `simulatorStore.ts` (Zustand) + `ipc/simulator.ts`
- CodeMirror line decoration synced via `currentFrameOrdinal` (StateField + StateEffect)
- "Preview to here" caret-context-menu action + Cmd-. keyboard shortcut
- Editor `readOnly = true` + "Simulator running — edits paused" banner during active runs (scrubbing stays functional)
- Explicit "Promote to fallback" button on fuzzy-matched frames (self-healing is OFF by default during simulator runs)

**Out of scope:**
- Producing a final video during a simulator run (Record button still the only path)
- Running against the live recording session
- Persistent simulator archives beyond the 5-most-recent retention
- Snapshot-only (no-network) mode (future phase)
- Deleting Phase 3's `intelligence::dryrun::*` + `DryRunPanel.tsx` (scheduled as a follow-up phase once simulator stabilizes)

**Acceptance criteria:**
- Caret on step N + "Preview to here" → author session is at the page state step N-1 would leave it in (≤10 s for a 20-step story on M2)
- A simulator run replays a 20-step story, producing 20 `StepFrame` entries; scrub timeline → editor line highlighted + Preview panel shows the frame
- Simulator runs are read-only against `.story.targets.json` by default; `simulator_promote_fallback` is the only path that mutates it (Phase 7-04c protocol invoked on explicit promotion)
- Phase 9-04 Live Preview pauses via `pauseStream` and resumes via `resumeStream` cleanly when the simulator takes exclusive lock on the author session
- Editor is `readOnly` + banner visible for the duration of an active simulator run; scrubbing + line-highlight stay functional
- Simulator session is never shared between simulator and a concurrent recording; recording path untouched
- Adding `ExecutorEvent::RunPaused` + `::StepFrameCaptured` does not break existing exhaustive TS switches in `hud.tsx` / `recording-view.tsx` (default branches added)

**Requirements:** PHASE-10.1 — PHASE-10.8 (allocated during /gsd-plan-phase 10)
**Plans:** 3 plans

Plans (to be produced by /gsd-plan-phase 10):
- [ ] 10-01 — Executor parameterization + `StepFrame` capture + `ExecutorEvent::RunPaused` / `::StepFrameCaptured` + `BrowserDriver::element_state` + TS switch defaults
- [ ] 10-02 — Simulator Tauri commands (`simulator_*`) + session registry + `.story.simulator/` storage with retention + `SimulatorEvent` streaming channel + coordination with 09-04 pause/resume
- [ ] 10-03 — Editor UI: `SimulatorTimeline.tsx` + `simulatorStore.ts` + "Preview to here" action + Cmd-. shortcut + CodeMirror `StateField` line decoration + editor-lock banner + promote-to-fallback button

### Phase 11: Author-time element picker — relocate Pick to Preview panel, route through author-session, record path becomes read-only

**Goal:** The element picker lives in the Preview panel (not the recording toolbar), routes clicks through the Phase 9-04 author-session with a shared AuthorDriverState FSM that coordinates with the Phase 10 simulator, and the recording path becomes a strictly read-only consumer of .story + .story.targets.json — self-healing is deferred to Simulator + Promote-to-fallback only.
**Requirements**: PHASE-11.1, PHASE-11.2, PHASE-11.3, PHASE-11.4, PHASE-11.5, PHASE-11.6, PHASE-11.7, PHASE-11.8, PHASE-11.9, PHASE-11.10, PHASE-11.11, PHASE-11.12, PHASE-11.13, PHASE-11.14
**Depends on:** Phase 9-04 (author-session + pauseStream/resumeStream), Phase 10 (simulator registry + self_heal param + editor read-only lock)
**Plans:** 4 plans

Plans:
- [ ] 11-01-PLAN.md — AuthorDriverRegistry 5-state FSM + PickerResumeGuard (RAII) + Pitfall 5 regression guard for picker_stamp_step_id (D-04 / D-13..D-16)
- [ ] 11-02-PLAN.md — Record path self_heal=false + AutomationError::PrimaryMissNoHeal + HUD Open-in-Simulator action (D-06 / D-07)
- [ ] 11-03-PLAN.md — Sidecar pickElement.start streamId routing + author.navigateTo warm-up + picker_start_author Tauri command with navigate-replay + pause/resume brackets (D-08 / D-10 / D-12)
- [ ] 11-04-PLAN.md — PreviewPickerButton + authorDriverStore + Cmd-Shift-P keymap + delete recorder-side picker + 11-SMOKE.md (D-01 / D-02 / D-05 / D-09)

### Phase 12: Fix video output resolution lock — letterbox filter chain

**Goal:** Output video resolution matches the user-selected preset exactly (e.g., 1920×1080 → produces 1920×1080, never 1920×1130). Replace the current `scale='min(1920,iw)':-2,…` filter with a letterbox chain (`scale … force_original_aspect_ratio=decrease:force_divisible_by=2 + pad + setsar + format=yuv420p`). Separate capture dimensions from output dimensions in `EncodeConfig`. Introduce `OutputResolution` enum (720p / 1080p / 1440p / 4K / MatchSource / Custom). If source < target, keep source at native size and letterbox (no upscale). Also resolve the `bitrate_kbps`-as-floor tech-debt (06-CLEANUP-BACKLOG.md:99). **Backend + IPC only — no UI changes in this phase** (hard-coded default 1080p + letterbox + black pad). UI knobs ship in Phase 13.
**Requirements**: ENC-06, ENC-07, ENC-08, ENC-09, ENC-10, ENC-11
**Depends on:** Phase 1 (encoder crate) — independent of Phases 5–11
**Plans:** 5/5 plans complete

Plans:
- [x] 12-01-PLAN.md — filters module (FilterSpec + build_vf letterbox/fillcrop/stretch emitters + enums + snapshot tests)
- [x] 12-02-PLAN.md — quality resolver (per-encoder QualityPreset→FFmpeg argv mapping per D-12-04)
- [x] 12-03-PLAN.md — EncodeConfig refactor: split capture/output dims, delegate -vf + RC, fix bitrate-floor tech-debt
- [x] 12-04-PLAN.md — IPC DTOs (OutputResolution/FitMode/PadColor/QualityPreset/ScaleAlgo) + StartRecordingArgs optional fields + regen TS bindings
- [x] 12-05-PLAN.md — real-ffmpeg integration tests: resolution lock via ffprobe + pad color pixel sampling

### Phase 13: Video output customization knobs — recording + export UI

**Goal:** Expose video output parameters to users. Recording-time: Resolution / FPS / Fit mode / Pad color / Quality preset (5 knobs). Export-time: expand the existing Export modal with Container / Codec / Rate control / HW encoder / Preset / Keyframe / Downscale algo / Audio params. Per-encoder quality mapping (VideoToolbox bitrate-based, NVENC cq-based, libx264 CRF-based with `tune=stillimage`). Persist via `tauri-plugin-store` with migration from the Phase 12 hard-coded defaults.
**Requirements**: ENC-12, ENC-13, ENC-14, ENC-15, ENC-16, ENC-17, ENC-18, ENC-19
**Depends on:** Phase 12 (backend letterbox chain + OutputResolution enum must exist first)
**Plans:** 5 plans

Plans:
- [x] 13-01-PLAN.md — Backend ExportOutputDto extension: EncoderOptionsDto + 6 sub-DTOs + tauri-specta regen (ENC-13)
- [x] 13-02-PLAN.md — Infrastructure: tauri-plugin-store wiring + capabilities + 6 shadcn Base UI primitives + 2 bespoke wrappers (ENC-15)
- [x] 13-03-PLAN.md — Shared output-prefs Zustand store + persistence/migrator + per-project IO + IPC wrapper extensions + CONVENTIONS.md exception update (ENC-14, ENC-15)
- [x] 13-04-PLAN.md — Recording UI: VideoOutputSection (5 controls) + bitrate preview + warnings + summary badge + recording-view.tsx integration (ENC-12, ENC-17, ENC-18, ENC-19)
- [x] 13-05-PLAN.md — Export Modal Advanced disclosure: AdvancedOutputOptions (8 knobs, conditional decision table) + export-modal.tsx integration (ENC-13, ENC-16)


### Phase 14: Port Claude Design into apps/desktop

**Goal:** Visual re-skin of apps/desktop using the Claude Design handoff bundle. Every mocked route (Dashboard, Editor, Post-production, Settings, Export) renders in the new dark-first sc-* design with custom Tauri chrome (decorations:false), on both macOS + Windows, while preserving every IPC call, Zustand slice, hotkey, motion transition, CodeMirror/LSP, WebGPU preview, and Phase 13 output-prefs wiring. Both dark + light themes pass WCAG 2.1 AA.
**Requirements**: D-01, D-02, D-03, D-04, D-05a, D-05b, D-05c, D-05d, D-05e, D-06a, D-06b, D-06c, D-06d, D-06e, D-06f, D-07, D-08, D-09, D-10, D-11
**Depends on:** Phase 13
**Plans:** 5 plans

Plans:
- [ ] 14-01-PLAN.md — Wave 1 Foundation: retire tokens.css + swap fonts to Inter/JetBrains Mono variable + 9 Sc* primitives + hidden /_design-system showcase
- [ ] 14-02-PLAN.md — Wave 2 Chrome: tauri.conf decorations:false + platform boot probe + ScTitleBar/ScSideNav/ScShell port of chrome.jsx + Windows resize QA
- [ ] 14-03-PLAN.md — Wave 3 Screens: port Dashboard + Editor shell + Post-Production editor-shell + Settings routes (behavior preserved)
- [x] 14-04-PLAN.md — Wave 4 Overlays+Export: CommandPalette (cmdk+Base UI) + RecordingIndicator + Sonner CSS-var skin + export-modal restyle (Phase 13 wiring intact)
- [ ] 14-05-PLAN.md — Wave 5 Tweaks+Polish: tweaks-store via plugin-store + TweaksPanel (dev-only Cmd/Ctrl+Shift+.) + Settings Appearance + recorder cosmetic + vitest-axe WCAG AA under jsdom

### Phase 15: Editor/Post-Production feature boundary cleanup

**Goal:** Realign Editor ("does it work?") and Post-Production ("does it feel right?") route concerns. Relocate `VoiceoverCompact` into Post-Production, introduce a shared `PreviewSurface` (mode="recording" | "composited"), add a `/post-production` landing route with empty-state, add an explicit "Send to Post-Production" toolbar button in Editor, and make the derived scene list always visible with a parse-error fallback. Preserve Phase 13 export wiring and Phase 14 sc-* chrome verbatim.
**Requirements**: D-01..D-13 (Phase 15 decision IDs; no new REQ-IDs — all v1 requirements already mapped to earlier phases)
**Depends on:** Phase 14
**Plans:** 5 plans

Plans:
- [x] 15-01-PLAN.md — Wave 1: Relocate VoiceoverCompact from routes/editor.tsx into features/post-production/voiceover-compact/; mount from EditorShell; collapse Editor right-rail to single preview (D-10, D-11) — complete 2026-04-21
- [x] 15-02-PLAN.md — Wave 2: Shared PreviewSurface component (mode prop); composited delegates to existing PreviewPlayer (WebGPU lifecycle intact); Editor rail consumes recording mode as empty-state (D-04, D-11) — complete 2026-04-21
- [x] 15-03-PLAN.md — Wave 3: New /post-production landing route under AppLayout — reuses ProjectGrid + useProjects; empty-state CTA; sidebar already wired (D-03, D-06) — complete 2026-04-21
- [x] 15-04-PLAN.md — Wave 4: Editor toolbar "Send to Post-Production" button (disabled until session_count>0) + always-visible SceneListPanel with parse-error fallback chip (D-02, D-07, D-08) — complete 2026-04-21
- [ ] 15-05-PLAN.md — Wave 5: Regression matrix + operator a11y spot-check + 15-SUMMARY + docs/ARCHITECTURE.md sync + STATE/ROADMAP updates (D-11, D-12, D-13)

### Phase 16: Upgrade all dependencies to latest — bump every JS/TS package and Rust crate across monorepo per .planning/notes/deps-upgrade-plan.md

**Goal:** Every JS/TS package and Rust crate across the monorepo upgraded to its latest allowed version per .planning/notes/deps-upgrade-plan.md, with each of the 5 execution phases (A safe → B Tauri/Vitest → C Rust 0.x breaking → D JS majors → E gated framework majors) landing as atomic commits that pass cargo check + cargo nextest + turbo run typecheck + turbo run build, and CLAUDE.md + docs/ARCHITECTURE.md synced to final pins.
**Requirements**: TBD (dep-upgrade phase — no REQ-IDs; success defined by PRD per-commit gate)
**Depends on:** Phase 15
**Plans:** 5 plans

Plans:
- [ ] 16-01-PLAN.md — Phase A: Safe patch/minor-only Rust workspace + per-workspace npm bumps (A1 + A2)
- [ ] 16-02-PLAN.md — Phase B: Tauri group lockstep (Rust tauri* + JS @tauri-apps/*) + Playwright sidecar Vitest 2→4 (B3 + B4)
- [ ] 16-03-PLAN.md — Phase C: Coordinated 0.x breaking bumps (objc2, rusqlite, reqwest, sha2, scraper, nix, tower/schemars/rand/toml/ts-rs, serde_yaml replacement) (C5–C12)
- [ ] 16-04-PLAN.md — Phase D: JS major bumps (tailwind-merge, sonner/cmdk/react-*, zod, jose, pino, resend, vite, typescript, biome) (D13–D21)
- [ ] 16-05-PLAN.md — Phase E: Gated framework majors (next-auth, Next 15→16, Prisma 6→7, windows 0.58→0.62, tauri-specta RC, docs sync) (E22–E28)

---
*Roadmap created: 2026-04-14*
*Phase 7 added: 2026-04-17*
*Phase 9 added: 2026-04-18*
*Phase 10 added: 2026-04-18*
*Phase 10 context locked (discuss-phase): 2026-04-19*
*Phase 10 plans materialized: 2026-04-19*
*Phase 12 added: 2026-04-19*
*Phase 13 added: 2026-04-19*
*Phase 15 plans materialized: 2026-04-21*
