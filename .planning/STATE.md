---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: milestone
status: executing
last_updated: "2026-04-17T09:57:42.769Z"
progress:
  total_phases: 6
  completed_phases: 1
  total_plans: 59
  completed_plans: 55
  percent: 93
---

# State: StoryCapture

**Last updated:** 2026-04-15

## Project Reference

- **Name:** StoryCapture
- **Core Value:** Turn a written story into a polished, shareable demo video automatically — no recording, editing, or video-production skill required.
- **Current Focus:** Phase 05 — window-targeted-screen-capture-with-playwright-auto-follow

## Current Position

Phase: 05 (window-targeted-screen-capture-with-playwright-auto-follow) — EXECUTING
Plan: 2 of 3

- **Milestone:** v1
- **Phase:** 5 — Window-targeted screen capture with Playwright auto-follow
- **Plan:** 1 of 3 complete (05-01 code-committed; human-verify checkpoint auto-approved under workflow.auto_advance=true)
- **Status:** Executing Phase 05
- **Progress:** [█████████░] 92%

## Performance Metrics

- Phases completed: 3 / 4 (Phase 1 fully complete; Phase 2 code-complete pending verification gate; Phase 3 code-complete pending verification gate; Phase 4 code-complete pending verification gate)
- Plans completed: 56 / 56
- Requirements validated: 87 / 87 (Phase 1: FOUND-01..08, DSL-01..07, AUTO-01..06, CAP-01..07, ENC-01..05, UI-01..04,08..10, DIST-01..05 | Phase 2: POST-01..09, EXPORT-01..06, UI-05, UI-11 | Phase 3: AI-01..06, UI-07 | Phase 4: WEB-01..08, UI-06, DIST-06)

## Accumulated Context

### Roadmap Evolution

- Phase 5 added: Window-targeted screen capture with Playwright auto-follow — replaces SckBackend stub with real SCK streaming + window/app target enum + Playwright PID→SCWindow bridge. Research done, stack corrections noted (`screencapturekit = =1.5.4`, not 1.70.x).
- Phase 6 added: Recording v2 — promotes Phase 5's deferred list (audio capture, region capture, chrome-hiding, multi-browser auto-follow, live preview, per-recording cursor toggle, Windows E2E CI) into a dedicated polish phase. CONTEXT.md drafted with 24 locked decisions; groups into 4 plans.

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

## Session Continuity

- Last action: Phase 4 — all 10 plans executed and committed (code-complete). STATE.md + ROADMAP.md updated to reflect Phase 4 completion. 04-10 paused at human-verify checkpoint.
- Next action: Complete operator-gated verification items (01-07 soak, 01-10 release cut, 02-08 audio curation, 02-12b UI walkthrough, 03-20 AI disclosure review, 04-10 landing page + integration walkthrough).
- Files touched this session: `.planning/STATE.md`, `.planning/ROADMAP.md`.

---
*State initialized: 2026-04-14 | Phase 1 code-complete: 2026-04-15 | Phase 2 code-complete: 2026-04-15 | Phase 3 code-complete: 2026-04-15 | Phase 4 code-complete: 2026-04-15*
