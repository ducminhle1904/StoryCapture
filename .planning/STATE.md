---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: milestone
status: executing
last_updated: "2026-04-22T05:55:06.567Z"
progress:
  total_phases: 17
  completed_phases: 8
  total_plans: 112
  completed_plans: 93
  percent: 83
---

# State: StoryCapture

**Last updated:** 2026-04-18

## Project Reference

- **Name:** StoryCapture
- **Core Value:** Turn a written story into a polished, shareable demo video automatically — no recording, editing, or video-production skill required.
- **Current Focus:** Phase --phase — 14

## Current Position

Phase: 15 — Editor/Post-Production feature boundary cleanup — EXECUTING
Plan: 15-04 complete (Wave 4 — Editor additions: Send-to-Post-Production toolbar button bound to folder?.session_count; always-visible SceneListPanel with last-valid-AST parse-error fallback chip). 1 wave remains (15-05 cleanup + regression matrix). Pause for user QA before Wave 5.

## Phase 8-11 Planning Audit (2026-04-21)

Full audit of Phases 8-11 planning validity vs. current codebase:

- **Phase 8** (GPU downscale + cursor overlay): Planned, not started. `crates/gpu_scale/` scaffolding (08-01) never executed. ROADMAP entry + Progress row added this date.
- **Phase 9** (Live Preview CDP pane): All 4 waves code-complete (2026-04-22). Wave 3 Task 3 (operator perf battery on 2023 M2 MBP) is a `checkpoint:human-verify` pending phase sign-off. Wave 1 — sidecar verbs + `preview/frame` notifications (`c80c7a9`); Rust `SidecarMsg::Notification` + `subscribe_preview()` + `PreviewFrame` (`1814088`). Wave 2 — Tauri `preview_start`/`preview_stop` + pump + `app_settings` toggle (`461d1fa`); React `<LivePreview />` canvas + Options toggle default-ON (`b19cabe`). Wave 3 — sidecar drop counter + HiDPI `everyNthFrame` + Rust pump log window (`09a816b`); LivePreview status machine + auto-recovery + drop counter (`c8236f2`). Wave 4 — multi-stream sidecar + `author.launch`/`close`/`setViewport` + `pauseStream`/`resumeStream` (`d0bc481`); `AuthorPreviewSession` registry in AppState + `attach_author_driver` Tauri command + per-stream wrappers (`ffbcc46`); editor-surface Live Preview + viewport switcher + `useEditorLivePreview` hook (default OFF per D-17) (`2cf1fca`). **PHASE-9.8/9.9 contract surface LOCKED as shipped — Phases 10 and 11 are unblocked.**
- **Phase 10** (Author-time simulator): **Unblocked by Phase 9-04** (2026-04-22). `AuthorPreviewSession.driver: Arc<Mutex<PlaywrightSidecarDriver>>` exposed in AppState; `attach_author_driver(streamId)` + `pause_author_preview`/`resume_author_preview` Tauri commands shipped. Remaining blockers are its own internal work: `run_story` executor signature + `ExecutorEvent::RunPaused/StepFrameCaptured` + `StepFrame` struct. Phase 3's `DryRunPanel.tsx` still present — naming-collision is by design per 10-CONTEXT D-00.
- **Phase 11** (Element picker relocation): Phase 9-04 primitives (`pauseStream`/`resumeStream`, shared author-preview registry) shipped 2026-04-22 — 11-01 registry + 11-02 picker-in-preview are unblocked. 11-02/03/04 still depend on Phase 10-02 for the author-session executor integration.

Phase 6 + Phase 7 confirmed fully shipped. Phase 7's `PickElementButton` at `apps/desktop/src/features/recorder/pick-element-button.tsx` — Phase 11-05's relocation target path is correct.

No Phase 15 rearrangement invalidates file-path references in Phase 8-11 plans. Proceed-when-unblocked.

- **Milestone:** v1
- **Phase:** 13 — Video output customization knobs (recording + export UI)
- **Plan:** All 5 plans complete; verified 8/8 (ENC-12..ENC-19 PASS)
- **Status:** Executing Phase --phase
- **Progress:** [████████░░] 84%

## Performance Metrics

- Phases completed: 4 / 5 (Phase 1 fully complete; Phases 2–5 code-complete pending verification gate)
- Plans completed: 59 / 59
- Requirements validated: 87 / 87 (Phase 1: FOUND-01..08, DSL-01..07, AUTO-01..06, CAP-01..07, ENC-01..05, UI-01..04,08..10, DIST-01..05 | Phase 2: POST-01..09, EXPORT-01..06, UI-05, UI-11 | Phase 3: AI-01..06, UI-07 | Phase 4: WEB-01..08, UI-06, DIST-06)

## Accumulated Context

### Roadmap Evolution

- Phase 5 added: Window-targeted screen capture with Playwright auto-follow — replaces SckBackend stub with real SCK streaming + window/app target enum + Playwright PID→SCWindow bridge. Research done, stack corrections noted (`screencapturekit = =1.5.4`, not 1.70.x).
- Phase 6 added: Recording v2 — promotes Phase 5's deferred list (audio capture, region capture, chrome-hiding, multi-browser auto-follow, live preview, per-recording cursor toggle, Windows E2E CI) into a dedicated polish phase. CONTEXT.md drafted with 24 locked decisions; groups into 4 plans.
- Phase 9 added: Live Preview pane — render Chromium automation inside the Recorder window via CDP `Page.startScreencast`. Cosmetic companion to the shipped window-target capture; final video still uses real-Chromium pixels via SCK/WGC, not screencast frames. Proposed 3-plan split: sidecar CDP verbs + Rust event bridge, React canvas renderer + toggle, perf/backpressure hardening.
- Phase 11 added: Author-time element picker — relocate Pick from the recording toolbar to the Preview panel, route through the Phase 10 author-session, and make the Record path read-only against `.story` + `.story.targets.json` (self-healing deferred to explicit Promote-to-fallback). Depends on Phase 10 author-session primitives and editor read-only lock.
- Phase 12 added (2026-04-19): Fix video output resolution lock — replace `scale='min(1920,iw)':-2,…` with letterbox chain (`scale … force_original_aspect_ratio=decrease:force_divisible_by=2 + pad + setsar + format=yuv420p`). Split capture dims from output dims in `EncodeConfig`. Add `OutputResolution` enum (720p/1080p/1440p/4K/MatchSource/Custom). Source < target stays at source size + letterbox (no upscale). Fix `bitrate_kbps`-as-floor tech-debt. Backend + IPC only (UI hard-codes default 1080p + letterbox + black pad).
- Phase 13 added (2026-04-19): Video output customization knobs — expose recording-time (5 knobs) + export-time (expanded) UI; per-encoder quality preset mapping (VT bitrate-based, NVENC cq-based, libx264 CRF+tune=stillimage); persist via tauri-plugin-store with Phase 12 migration. Depends on Phase 12.
- Phase 16 added (2026-04-21): Upgrade all dependencies to latest — bump every JS/TS package and Rust crate across the monorepo (apps/desktop, apps/web, packages/*, crates/*, tools/*, scripts/*) per `.planning/notes/deps-upgrade-plan.md`. Scope: ~173 deps audited (~18 patch, ~60 minor, ~33 major). Coordinated groups: Tauri + plugins (Rust↔JS major alignment), tRPC 11 suite, Prisma client+CLI. Rust 0.x breakers: rusqlite across 4 crates, objc2 0.5→0.6 unify, intelligence stack (serde_yaml replacement, schemars 1, rand 0.10, toml 1, reqwest 0.13). JS majors gated on user approval: Next 16, Prisma 7, jose 6, NextAuth. Also resync CLAUDE.md (windows-capture 2.x, screencapturekit pin, chromiumoxide presence check). Every bump group = atomic commit; verify with cargo nextest + pnpm build + biome per step.
- Phase 14 added (2026-04-21): Port Claude Design into apps/desktop — wire `packages/ui/src/claude-design/` (tokens.css + app.css + `.sc-*` primitives) into the desktop app and port JSX screens/overlays/primitives from `.planning/design/storycapture-claude-design/project/`. Open decision: reconcile `sc-*` tokens with existing Cursor-inspired `packages/ui/src/tokens.css` (merge into single system vs namespace alongside).
- Phase 17 added (2026-04-22): Record engine lifecycle hardening — fix 19 issues found via 4-agent deep-dive investigation across capture / encoder / IPC / frontend layers. Clusters: (1) CLEANUP — exit-drain recording sessions, orphan spawn tasks on start-fail, xcap thread-join hang; (2) START-SAFETY — FE+BE double-start race, WGC HWND live-check, SCK pause/resume atomicity; (3) ENCODER-ROBUST — FFmpeg stdin backpressure, staging+atomic-rename output, first-frame timeout config, 200ms FIFO hardcode, explicit `-g` keyframe, PTS clamp; (4) UX-FEEDBACK — `RecordingEvent::AudioUnavailable` new variant, state-desync heartbeat, dangling automation Channel on unmount, no auto-nav to editor; (5) POLISH — NV12 config-coerce reject, HW encoder re-probe, atomic counter ordering, `@ts-ignore` test cleanup. No public IPC / DSL contract changes beyond additive event variants. Investigation report in conversation (not archived — re-derive from `crates/capture` + `crates/encoder` + `apps/desktop/src-tauri/src/commands/encode.rs` + `apps/desktop/src/features/recorder/`).

### Decisions

See PROJECT.md → Key Decisions. Highlights:

- Tauri v2 over Electron (startup/memory/bundle budgets)
- shadcn/ui + Base UI (`base-vega`), NOT Radix
- chromiumoxide CDP primary + Playwright sidecar fallback (BrowserDriver trait from day one)
- FFmpeg bundled as static universal Tauri sidecar
- Platform-native capture (ScreenCaptureKit / Windows.Graphics.Capture) + XCap fallback
- Direct distribution + notarization on macOS (not MAS)
- Turborepo + Cargo workspace monorepo
- Use `tauri-plugin-keyring` for secrets (Stronghold deprecated)
- Use Motion (`motion/react`) — Framer Motion rebrand
- Node SEA (Single Executable Application) chosen for Playwright sidecar packaging
- BrowserDriver trait abstraction from day one to allow seamless chromiumoxide ↔ Playwright switching
- CaptureBackend trait abstraction wraps SCK/WGC/xcap behind a single interface
- Encoder uses FFmpeg sidecar with runtime HW probe; falls back to libx264
- tauri-specta for typed IPC codegen (Rust → TypeScript types auto-generated)
- Effects AST with canonical-order builder + dual emitters (FFmpeg filter-graph + JSON snapshot)
- WebGPU/WebGL2 preview engine with VideoFrame lifecycle management
- 5-track post-production timeline (Video, Cursor, Zoom, Sound, Annotations) with Zustand slices
- Per-action coalesced undo/redo ring buffer (50 steps, cmd+z/shift+z)
- LlmProvider/TtsProvider trait abstractions isolate Anthropic/OpenAI/ElevenLabs behind a unified interface
- NL→DSL orchestrator uses tool-use partial-JSON accumulator + verb whitelist retry + diff engine
- TTS cache keyed on (provider, voice, content-hash) with sanitized on-disk paths and GC
- tower-lsp LanguageServer over story_parser: did_open/change, diagnostics, hover, completion
- LSP bridged to CodeMirror 6 via Tauri IPC (not stdio) to avoid shell escaping issues in packaged app
- Dry-Run reuses Phase 1 BrowserDriver without capture pipeline — fastest possible iteration loop
- All LLM/TTS keys stored in OS keychain via tauri-plugin-keyring; never in SQLite or plaintext
- [Phase 05]: Plan 05-01: real SCK streaming for display+window + grouped Target picker + silent xcap fallback; capture_target persists to app_settings.json
- [Phase 05]: Plan 05-02: launchServer+connect in sidecar (Browser class has no .process()); process-global PlaywrightPidStash + background probe task for pid acquisition; SharedPlaywrightDriver adapter so probe+executor share the driver; host-side pid rewrite in start_capture_target for WindowByPid sentinel (T-05-02-01)
- [Phase 05]: Plan 05-03: Chromium parent/child resolution via ToolHelp snapshot walk restricted to chrome.exe/msedge.exe/chromium.exe process names (T-05-03-07)
- [Phase 05]: Plan 05-03: PTS clock source set to ClockSource::Synthetic on WGC path (QPC plumbing deferred to encoder-coordinated follow-up)
- [Phase 14-01]: Retired Cursor-warm tokens (D-01); kept packages/ui/src/tokens.css as TRANSITIONAL alias layer mapping 770 legacy --color-* onto --sc-* (Wave 5 cleanup). Swapped to @fontsource-variable/{inter,jetbrains-mono} (D-11). Shipped 9 Sc* primitives (ScButton/Input/Badge/Switch/Card/Kbd/Slider/Select/Segmented) over Base UI in packages/ui. Dark default (D-02). Hidden /_design-system/{tokens,components} routes (D-06f).
- [Phase 14-03]: Wave 3 routes restyled inside legacy AppLayout shell (D-03/D-06a permanently dropped). Dashboard+Settings+Editor-shell+post-production editor-shell use sc-* tokens + ScButton/ScCard from @storycapture/ui. Every IPC/Zustand/CodeMirror/LSP/WebGPU/motion wire preserved per D-09.
- [Phase 14-04]: Wave 4 overlays + Export restyle. CommandPalette (cmdk + Cmd/Ctrl+K) mounts inside AppLayout + FullscreenLayout (useNavigate needs RouterProvider descendant context; plan's "sibling to RouterProvider" language predates react-router-dom v7 data router). RecordingIndicator driven by useRecorderStore.status. Sonner skinned via --normal-bg/--normal-text/--normal-border/--border-radius/--toast-animation-duration pulling from --sc-surface / --sc-text / --sc-border-2 / --sc-r-lg. theme="dark" hard-coded until Wave 5 tweaks-store swap. Export-modal retokened to --sc-* + ScButton; ENC-12..ENC-19 Phase 13 wiring preserved verbatim (71/71 post-production tests green).
- [Phase 15-03]: Wave 3 Post-Production landing route. New `apps/desktop/src/routes/post-production-landing.tsx` (182 LoC) reuses ProjectGrid + useProjects verbatim; onOpen → `/post-production/:projectId` (vs dashboard's `/editor/:id`). Toolbar omits New Story; empty-state CTA "Go to Projects" → `/`. Router gains `{ path: "/post-production", element: <PostProductionLandingRoute /> }` under AppLayout; `/post-production/:storyId` stays under FullscreenLayout. Zero sidebar/command-palette edits — matchPattern already covers both routes. Typecheck + build green; 201/209 vitest (8 pre-existing failures, not regressions). session_count split deferred (needs list_project_recordings IPC).
- [Phase 15-01]: Wave 1 VoiceoverCompact relocation. Moved component + helpers verbatim (D-11) from routes/editor.tsx into features/post-production/voiceover-compact/{voiceover-compact.tsx,index.ts}. VoiceCatalogDialog now mounts only inside post-production EditorShell (D-10). Editor right rail collapsed to single preview rail (RailTabButton + motion cross-fade + railTab state removed). findSceneIndexForOffset stayed in editor.tsx (not voiceover-specific). VoiceoverCompact mounted in a dormant hidden slot in EditorShell pending full story-data wiring in a later wave. Net −115 LoC; typecheck + build green; 201/209 vitest pass (8 failures pre-existing, not regressions).
- [Phase 15-04]: Wave 4 Editor additions. Added "Send to Post-Production" toolbar button in editor.tsx right-side action cluster (after Record) — disabled ScButton when folder?.session_count === 0, enabled `<Link to={`/post-production/${projectId}`} className="sc-btn sm">` once a recording exists; uses Scissors icon for parity with sidebar. Dropped `sceneCount > 0 &&` gate on SceneListPanel; rail always mounts. SceneListPanel adds useRef Story cache updated on successful parse; under hasParseError it renders the cached tree with `<ScBadge tone="warn">parse error — showing last known</ScBadge>` in the header. Empty-state refined to "No scenes yet". layoutId motion pill + click-to-jump preserved (D-11). Plan's `.sc-btn.secondary` class doesn't exist — used bare `.sc-btn sm` (base IS secondary per claude-design/app.css). Accent-pulse on enable transition deferred (Claude's Discretion). 2 files modified; typecheck + build green; 201/209 vitest (baseline preserved).

### Open Todos

- **[BLOCKING] 01-07 — CI capture-soak workflow:** The `capture-soak` GitHub Actions workflow must be manually triggered on a real runner and pass (30-min soak, RAM under 800 MB). Operator approved plan without a real CI run. Trigger: `.github/workflows/capture-soak.yml`.
- **[BLOCKING] 01-10 — Release signing + first tagged release verification:** Requires 13 GitHub Secrets to be configured (Apple signing cert, notarization credentials, Windows code-signing cert/token, etc.) and a first tagged release (`v0.1.0-beta.1`) to be cut and verified on clean macOS arm64, macOS x64, and Windows x64 VMs. See `.planning/phases/01-foundation-dsl-automation-capture-encode/01-10-RESUME.md` for full checklist.
- **[BLOCKING] 02-08 — Audio curation + listen-test:** 20 CC0/CC-BY-4.0 audio files (12 SFX + 8 BGM) must be sourced, normalized to -16 LUFS, committed with attribution, and human-verified via the listen-test checklist. See `.planning/phases/02-cinematic-post-production-export/02-08-RESUME.md` and `scripts/curate-sound-library.md`. After curation: remove `#[ignore]` on tests in `crates/effects/tests/sound_library.rs` + `audio_rms_check.rs`, run them green, then write `02-08-SUMMARY.md`.
- **[BLOCKING] 02-12b — Post-Production Editor UI human-verify walkthrough:** Operator must run `pnpm --filter @storycapture/desktop tauri dev`, navigate to `/post-production/<story-id>`, and complete the 5-step walkthrough (scrub 60fps, apply presets, export MP4/WebM/GIF, undo/redo, accessibility smoke). See `.planning/phases/02-cinematic-post-production-export/02-12b-RESUME.md`. Known deferrals: real source video wiring, undo-ring (P13), real AST graph (P13) — these are expected cross-plan handoffs.
- **[BLOCKING] 03-20 — Accounts settings + AI disclosure UI human-verify:** Operator must run the app, navigate to Settings → Accounts, verify token counters, cost warnings, AI disclosure copy (G7/G8/G9 compliance), and confirm WCAG 2.1 AA accessibility. See `.planning/phases/03-intelligence-layer-ai-authoring-voiceover/03-20-RESUME.md` for the full verification checklist. After passing: write `03-20-SUMMARY.md`.
- **[BLOCKING] 04-10 — Landing page + integration walkthrough human-verify:** Operator must visit the running Next.js app, review the landing page, and complete the end-to-end integration walkthrough (OAuth sign-in, desktop upload, shareable viewer, workspace invite, analytics dashboard, desktop-web sync). See `.planning/phases/04-web-companion-sharing/04-10-RESUME.md` for the full checklist. After passing: write `04-10-SUMMARY.md`.
- Resolve FFmpeg LGPL vs. GPL licensing before first public beta.
- Pin exact versions: Tauri 2.8.x, chromiumoxide 0.7.x, screencapturekit 1.70.x, windows-capture 1.5.x, NextAuth v5.

### Blockers

currently blocking post-v1 work. All six verification items above are operator-gated (require secrets, real hardware, or manual review). All v1 code is committed.

- [05-02] Human-verify checkpoint auto-approved under workflow.auto_advance=true: macOS host with Screen Recording TCC grant required to exercise (a) 3x real-capture find_window_by_pid tests, (b) cargo run -p e2e-playwright-capture, (c) 8-step UI walkthrough. Defer to operator same as 01-07 soak.
- [05-01] Human-verify checkpoint auto-approved: TCC-granted macOS host for `cargo test -p capture --features real-capture -- --ignored` + 30-min SCK-window soak (<800 MB) + TCC-deny fallback + 2nd-failure modal smoke.
- [05-03] Human-verify checkpoint auto-approved: Windows 10/11 operator VM for `cargo test -p capture --features real-capture-windows -- --ignored` + 6-step WGC walkthrough + first live `capture-windows.yml` CI run (requires a push).

### Quick Tasks Completed

| # | Description | Date | Commit | Directory |
|---|-------------|------|--------|-----------|
| 260418-gkg | Recording engine quick fixes: drop Chromium sentinel, panic guard on frame-pump, export drop counts | 2026-04-18 | 1fe6fe8 | [260418-gkg-recording-engine-quick-fixes-drop-chromi](./quick/260418-gkg-recording-engine-quick-fixes-drop-chromi/) |
| 260418-ios | Fix focus-steal during recording: re-focus main window after Playwright launch + start_recording | 2026-04-18 | 9fad310 | [260418-ios-fix-focus-steal-during-recording-so-play](./quick/260418-ios-fix-focus-steal-during-recording-so-play/) |
| 260421-t83 | Recording playback in Editor Preview pane — `list_project_recordings` IPC + scrubbable `<video>` + live status strip | 2026-04-21 | f902ec7 | [260421-t83-recording-playback-in-editor-preview-pan](./quick/260421-t83-recording-playback-in-editor-preview-pan/) |
| Phase 14 P01 | 25m | 3 tasks | 23 files |
| Phase 14 P03 | 20m | 3 tasks | 4 files |
| Phase 14 P04 | 35m | 3 tasks | 7 files |

## Session Continuity

- Last activity: 2026-04-22 — Executed Phase 9 Wave 4 (editor-surface preview + viewport switcher + PHASE-9.8/9.9 author-session extensions, Phase 10 prerequisites).
- Last action: Plan 09-04 complete — 3 atomic commits (d0bc481 sidecar multi-stream + author-session verbs + pause/resume, ffbcc46 author-preview Tauri commands + AuthorPreviewSession registry + attach_author_driver, 2cf1fca editor-surface LivePreview hook + streamId prop + viewport switcher + default-OFF toggle). `cargo check -p automation -p storycapture` clean; `cargo test -p automation --lib` 61/61; `cargo test -p storycapture --lib --test-threads=1` 62/62; `pnpm tsc` clean; preview sidecar vitest 13/13 (+4 new); server regression 25/25; LivePreview vitest 9/9 (+1 new); recorder vitest 60/60. capture/encoder untouched. TS bindings regenerated via specta-emit. PHASE-9.8 + PHASE-9.9 contract surface matches Phase 10-CONTEXT D-06 and Phase 11-CONTEXT D-12/D-16 exactly — downstream unblocked. SUMMARY at `.planning/phases/09-live-preview-pane-render-chromium-automation-inside-the-reco/09-04-SUMMARY.md`.
- Next action: Phase 9 code-complete (Waves 1–4). Pending checkpoint = Wave 3 Task 3 operator perf battery (10 items) still requiring 2023 M2 MBP hardware. Downstream: Phase 10 can start (10-01 executor parameterization) — unblocked by 9-04.
- Files touched this session: `scripts/playwright-sidecar/server.mjs`, `scripts/playwright-sidecar/preview.test.mjs`, `crates/automation/src/playwright_driver.rs`, `apps/desktop/src-tauri/src/commands/automation.rs`, `apps/desktop/src-tauri/src/state/mod.rs`, `apps/desktop/src-tauri/src/ipc_spec.rs`, `apps/desktop/src/features/recorder/LivePreview.tsx`, `apps/desktop/src/features/recorder/LivePreview.test.tsx`, `apps/desktop/src/features/editor/use-editor-live-preview.ts` (new), `apps/desktop/src/ipc/preview.ts`, `apps/desktop/src/state/editor.ts`, `apps/desktop/src/routes/editor.tsx`, `packages/shared-types/src/ipc.ts` (regenerated).

---
*State initialized: 2026-04-14 | Phase 1 code-complete: 2026-04-15 | Phase 2 code-complete: 2026-04-15 | Phase 3 code-complete: 2026-04-15 | Phase 4 code-complete: 2026-04-15 | Phase 5 code-complete: 2026-04-17 | Phase 12 planned: 2026-04-19*

**Planned Phase:** 17 (Record engine lifecycle hardening) — 6 plans — 2026-04-22T05:55:06.563Z
