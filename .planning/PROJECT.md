# StoryCapture

## What This Is

StoryCapture is a cross-platform desktop application (Windows + macOS) that turns structured user stories into polished demo videos. Users write stories in a simple DSL describing UI actions (click, type, navigate, etc.); the app automates those actions against a real browser (and, eventually, native apps), records the screen, and applies cinematic post-production (auto-zoom, cursor animations, transitions, sound, backgrounds). A Next.js web companion hosts, shares, and analyzes the resulting recordings.

## Core Value

**Turn a written story into a polished, shareable demo video automatically — no recording, editing, or video-production skill required.**

## Requirements

### Validated

(None yet — ship to validate)

### Active

- [ ] Tauri v2 desktop shell (Windows + macOS) with React 19 + TypeScript frontend
- [ ] Story DSL parser (Rust, pest) supporting scene/meta blocks and core commands (navigate, click, type, wait, wait-for, assert, screenshot, scroll, hover, drag, select, upload, pause)
- [ ] Browser automation engine (chromiumoxide CDP, with Playwright sidecar as fallback) driving stories against real web apps
- [ ] Platform-native screen capture (ScreenCaptureKit on macOS, Windows.Graphics.Capture on Windows; XCap fallback)
- [ ] FFmpeg sidecar video pipeline with H.264/H.265 hardware-accelerated encoding (VideoToolbox / NVENC / QSV)
- [ ] Story editor UI (CodeMirror 6, DSL syntax highlighting, live browser preview, timeline view, selector autocomplete)
- [ ] Recording controls with live progress (start/stop/pause, step progress, cursor trail)
- [ ] Post-production pipeline: auto-zoom, cursor overlay with click ripples, backgrounds, FFmpeg xfade transitions, sound mixer, text overlays
- [ ] Post-production editor UI (timeline with layer tracks, preset panel, preview player, export settings)
- [ ] Multi-format export (MP4, WebM, GIF) with resolution/quality/FPS options and batch export
- [ ] Project file system (per-story folders with assets, exports; SQLite metadata index)
- [ ] Natural-language → DSL conversion via LLM (Claude/OpenAI), chat-style authoring with diff preview
- [ ] Smart selector engine with intent-aware resolution: explicit `selector` / `testid` / `aria` targets resolve strictly, while human-text targets use ranked actionable/accessibility heuristics with ambiguity detection and attempt logging
- [ ] AI voiceover (TTS) generation and voiceover↔timeline sync
- [ ] Next.js 15 web companion: OAuth auth, S3/R2 video upload, shareable pages with embed, team workspaces, template marketplace, analytics
- [ ] Desktop ↔ web WebSocket sync for recording status and project mirroring
- [ ] Tauri auto-updater with differential updates and signed/notarized macOS distribution
- [ ] Dark-first UI built on shadcn/ui + Base UI (base-vega), blending Runway / Linear / ElevenLabs DESIGN.md tokens
- [ ] WCAG 2.1 AA accessibility across all screens
- [ ] Performance targets: <2s cold start, <300MB idle / <800MB recording, <50MB installer (excl. FFmpeg), 1-min video renders in <30s on modern hardware
- [ ] Secure-by-default: no telemetry, local-only storage, OS-keychain API key storage, encrypted web uploads

### Out of Scope (for v1 milestone; some deferred to later milestones)

- Real-time multi-user collaborative editing (CRDT) — deferred to Phase 5
- Native app automation (macOS AX, Windows UIA) — deferred to Phase 5
- CI/CD headless CLI tool — deferred to Phase 5
- Diff-aware re-recording — deferred to Phase 5
- Plugin system for user-contributed effects — deferred to Phase 5
- Localization re-run engine — deferred to Phase 5
- Linux desktop build — not targeted (macOS + Windows only)
- Mac App Store distribution — excluded due to screen-recording restrictions (direct distribution + notarization instead)
- Mobile apps — web + desktop only

## Context

- **Monorepo**: Turborepo — apps/desktop (Tauri), apps/web (Next.js), packages/* (shared TS), crates/* (shared Rust: story-parser, capture, automation, effects).
- **Tech stack**: Tauri v2, React 19 + Vite, Tailwind v4, shadcn/ui + Base UI (NOT Radix), Zustand + TanStack Query, Framer Motion, Lucide icons. Rust: pest, chromiumoxide, objc2, windows-rs, rusqlite. Web: Next.js 15 App Router, Prisma + PostgreSQL, NextAuth, tRPC, S3/R2.
- **Design system**: DESIGN.md approach via getdesign.md — Runway (primary, cinematic), Linear (editor/dashboard minimalism), ElevenLabs (timeline/waveform accents). Dark-first, JetBrains/Geist Mono for DSL editor.
- **Key technical risks** (prototype early): (1) platform-native screen capture integration, (2) FFmpeg sidecar bundling + macOS notarization, (3) chromiumoxide maturity vs. Playwright-sidecar fallback, (4) macOS Screen Recording + Accessibility permission flows, (5) hardware-accelerated post-production performance.
- **Testing**: Vitest + RTL (frontend), cargo test (Rust), Playwright (E2E). GitHub Actions matrix: macOS arm64/x64 + Windows x64.
- **Distribution**: Direct distribution with notarization on macOS (not App Store); Tauri built-in updater.

## Constraints

- **Tech stack**: Tauri v2 (not Electron) — chosen for startup time, memory footprint, and bundle size targets.
- **Component library**: shadcn/ui + Base UI primitives, `base-vega` style — NOT Radix UI. Render-prop flexibility, single dep, better Select/Combobox support for timeline/editor compositions.
- **Platforms**: Windows + macOS desktop only for v1; Linux and mobile excluded.
- **Distribution**: Cannot ship via Mac App Store (screen-recording apps are restricted). Direct distribution + notarization required.
- **Performance**: <2s cold start, <300MB idle / <800MB recording, <50MB installer, 1-min video under 30s render.
- **Security/privacy**: Offline-first desktop; no telemetry by default; recordings stored locally; web uploads encrypted in transit + at rest; API keys in OS keychain.
- **Accessibility**: WCAG 2.1 AA baseline across all custom UI.

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Tauri v2 over Electron | Meets startup/memory/bundle-size budgets; Rust backend needed for native capture anyway | — Pending |
| shadcn/ui + Base UI (not Radix) | Render-prop flexibility, single dep, better Select-multi/Combobox — critical for timeline and effect panels | — Pending |
| chromiumoxide CDP with Playwright sidecar as fallback | Keep automation in-process in Rust; fall back to Playwright if chromiumoxide maturity blocks features | — Pending |
| FFmpeg as Tauri sidecar (bundled) | Hardware-accelerated encoding (VideoToolbox / NVENC / QSV), single source of truth for the post-pro pipeline | — Pending |
| Platform-native capture (ScreenCaptureKit / WGC) with XCap fallback | Quality and performance require native APIs; XCap covers edge cases | — Pending |
| DESIGN.md approach blending Runway + Linear + ElevenLabs | Domain match (Runway), editor precision (Linear), timeline/waveform aesthetic (ElevenLabs); all dark-first | — Pending |
| Turborepo monorepo with shared packages + crates | Share DSL types + UI across desktop and web; share Rust crates across capture/automation/effects | — Pending |
| Direct distribution (not Mac App Store) | Screen-recording apps restricted on MAS; notarized direct distribution is the path | — Pending |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd-complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-04-14 after initialization*
