---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: milestone
status: executing
last_updated: "2026-04-21T04:52:20.602Z"
progress:
  total_phases: 13
  completed_phases: 6
  total_plans: 97
  completed_plans: 79
  percent: 81
---

# State: StoryCapture

**Last updated:** 2026-04-18

## Project Reference

- **Name:** StoryCapture
- **Core Value:** Turn a written story into a polished, shareable demo video automatically — no recording, editing, or video-production skill required.
- **Current Focus:** Phase --phase — 14

## Current Position

Phase: 14 — Port Claude Design into apps/desktop — EXECUTING
Plan: 2 of 5 (14-01 complete — Wave 1 foundation)

- **Milestone:** v1
- **Phase:** 13 — Video output customization knobs (recording + export UI)
- **Plan:** All 5 plans complete; verified 8/8 (ENC-12..ENC-19 PASS)
- **Status:** Executing Phase --phase
- **Progress:** [████████░░] 81%

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
- Phase 14 added (2026-04-21): Port Claude Design into apps/desktop — wire `packages/ui/src/claude-design/` (tokens.css + app.css + `.sc-*` primitives) into the desktop app and port JSX screens/overlays/primitives from `.planning/design/storycapture-claude-design/project/`. Open decision: reconcile `sc-*` tokens with existing Cursor-inspired `packages/ui/src/tokens.css` (merge into single system vs namespace alongside).

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
| Phase 14 P01 | 25m | 3 tasks | 23 files |

## Session Continuity

- Last activity: 2026-04-21 — Executed Phase 14 Plan 01 (Wave 1 foundation): font swap, sc-* token wire-up with transitional alias, 9 Sc* primitives + tests, hidden /_design-system routes.
- Last action: Plan 14-01 complete — 3 atomic commits (6bdc9f4 tokens+fonts, f6c1881 primitives+20 tests, 635141e showcase routes). `pnpm --filter @storycapture/desktop build` + `pnpm --filter @storycapture/ui test` both green. SUMMARY at `.planning/phases/14-port-claude-design-into-apps-desktop/14-01-SUMMARY.md`.
- Next action: Wave 1 human QA on the /_design-system showcase routes, then `/gsd-execute-phase 14` Wave 2 (window chrome + side-nav shell).
- Files touched this session: `apps/desktop/{package.json,src/styles.css,src/lib/theme.ts,src/lib/fonts.ts,src/routes/index.tsx,src/routes/_design-system/*}`, `packages/ui/{package.json,tsconfig.json,vitest.config.ts,src/index.ts,src/lib/cn.ts,src/claude-design/{index.ts,primitives/**},src/tokens.css}`.

---
*State initialized: 2026-04-14 | Phase 1 code-complete: 2026-04-15 | Phase 2 code-complete: 2026-04-15 | Phase 3 code-complete: 2026-04-15 | Phase 4 code-complete: 2026-04-15 | Phase 5 code-complete: 2026-04-17 | Phase 12 planned: 2026-04-19*

**Planned Phase:** 14 (Port Claude Design into apps/desktop) — 5 plans — 2026-04-21T04:33:35.935Z
