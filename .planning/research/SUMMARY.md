# Project Research Summary

**Project:** StoryCapture
**Domain:** Cross-platform desktop app — DSL-driven browser automation + native screen capture + cinematic post-production video pipeline, with Next.js web companion
**Researched:** 2026-04-14
**Confidence:** MEDIUM-HIGH

## Executive Summary

StoryCapture sits in a white-space intersection of four mature categories: scripted demo authoring (Demo Time VSCode), real browser automation (Playwright), polished screen recording (Screen Studio, Tella), and interactive demos (Arcade, Supademo). No competitor combines (a) a text-first DSL source of truth, (b) real-browser automation, and (c) Screen Studio-grade post-production in one desktop app. The committed stack — Tauri v2 + React 19 + Rust crates (pest, chromiumoxide, objc2/windows-rs, rusqlite) + FFmpeg sidecar + Next.js 15 companion — is the right 2026 canonical choice and validates cleanly against current best practices; the open questions are execution, not selection.

The research identifies a **structural advantage worth exploiting throughout the product**: because StoryCapture *authors* the clicks (via DSL → automation), every cinematic effect (auto-zoom, smooth cursor, click ripples, AI voiceover sync) becomes dramatically simpler than in a pixel-based tool. We know click coords, timings, and selector identities a priori — no CV inference needed. This should shape architecture decisions (pure-logic crates, scene-granular timeline, metadata-driven effects) and feature prioritization (defaults matter more than configurability).

The three biggest risks are all in Phase 1 and all must be prototyped early: (1) **FFmpeg sidecar notarization on macOS** (nested dylib signing is a known Tauri pain point; mitigate by building FFmpeg as a universal static binary), (2) **ScreenCaptureKit + Windows.Graphics.Capture integration** (TCC permission flows, multi-display, HDR, retina scaling, and IOSurface memory leaks are all traps that compound), and (3) **chromiumoxide maturity** (pre-1.0, lacks Playwright's reliability heuristics — design a `BrowserDriver` trait from day one with Playwright sidecar fallback wired, not aspirational). If any of these is punted past Phase 1, every later phase pays compound interest.

## Key Findings

### Recommended Stack

The committed PROJECT.md stack is validated with two caveats: **Stronghold is deprecated** (use `tauri-plugin-keyring` or `tauri-plugin-secure-storage` for OS-keychain API-key storage), and **Framer Motion** has been rebranded to **Motion** (`motion/react` package). Pin specific versions (Tauri 2.8.x, chromiumoxide 0.7.x exact, `screencapturekit` 1.70.x, `windows-capture` 1.5.x) — these libraries break between minor versions.

**Core technologies:**
- **Tauri v2 (2.8.x)** — desktop shell — startup/memory/bundle-size budgets unreachable by Electron
- **Rust crates: pest, chromiumoxide, screencapturekit (doom-fish), windows-capture (NiiightmareXD), rusqlite bundled** — platform-native capture + automation + parsing in one process
- **FFmpeg 7.1 static universal sidecar** — hardware-accelerated encode (VideoToolbox / NVENC / QSV) with deterministic bundled environment
- **React 19 + Vite 6 + Tailwind v4 + shadcn/ui + Base UI** — frontend; Zustand (UI state) + TanStack Query v5 (IPC cache)
- **CodeMirror 6** (`@uiw/react-codemirror`) — DSL editor; LSP server for diagnostics/hover
- **Next.js 15 App Router + tRPC 11 + Prisma 6 + NextAuth v5 + R2/S3** — web companion, typesafe end-to-end
- **Turborepo 2.5 + pnpm + Cargo workspace** — apps/desktop, apps/web, packages/*, crates/*
- **tracing + tauri-plugin-log** — structured logs (telemetry-off, local-only, opt-in log upload)
- **specta / tauri-specta** — typed IPC codegen from Rust → TS (critical for pipeline-heavy apps)
- **Biome** (not ESLint+Prettier) — single-tool, Rust-fast monorepo linting in 2026

Gaps the committed stack didn't name but needs: secret storage (keyring, NOT Stronghold), SQLite migrations (`rusqlite_migration`), typed IPC codegen (`specta`), hardware-encoder runtime feature detection, notarization automation scripts, E2E harness (`tauri-driver` for Windows; macOS E2E is unsupported — use AppleScript/XCUITest out-of-process).

Full detail: `.planning/research/STACK.md`.

### Expected Features

Competitive landscape pins Screen Studio as the polish benchmark, Arcade/Supademo as interactive-demo rivals (different category — don't chase), Tella as webcam-creator product (different audience), Scribe as docs/SOP (different output). StoryCapture's positioning: **"Demo Time for the full browser, rendered at Screen Studio quality, authored in DSL or by AI."**

**Must have (table stakes):** auto-zoom on clicks, smooth cursor interpolation, click ripples / highlight rings, rounded window + padded backgrounds, multi-format export (MP4 / WebM / GIF), trim/cut + preview-before-export, cursor controls, text overlays, scene transitions (xfade), BGM mixer, scene re-record, project persistence.

**Should have (differentiators):** Story DSL as diffable Git-reviewable source of truth, reproducible recordings, natural-language → DSL authoring with diff preview, smart selector engine with intent-aware ranked resolution, real browser automation, AI voiceover synced to DSL steps, offline-first, multi-viewport recording, web companion (upload + embed).

**Defer (v2+):** real-time collab (CRDT), native-app automation, headless CLI, plugin system, localization re-run, diff-aware re-recording.

**Anti-features:** full video NLE, webcam/PiP, mobile app recording, interactive click-through, live narration during capture, cloud rendering.

Full detail: `.planning/research/FEATURES.md`.

### Architecture Approach

A **thin Tauri host + pure-logic Rust crates** architecture: `apps/desktop/src-tauri` is the only place that imports `tauri` and serves only to wire commands/events/state. All business logic lives in pure library crates (`story-parser`, `automation`, `capture`, `effects`, `encoder`, `storage`) so every crate unit-tests with `cargo test` and is reusable by a future Phase 5 headless CLI with zero Tauri coupling.

**Major components:** `story-parser` (pest), `automation` (BrowserDriver trait with chromiumoxide + Playwright sidecar impls), `capture` (zero-copy SCK/WGC/xcap), `effects` (typed filter-graph AST), `encoder` (FFmpeg sidecar lifecycle + HW-encoder negotiation), `storage` (SQLite two-tier + project folders), Tauri host (commands + Channels + events, actor-style tokio mpsc — no `Arc<Mutex<BigState>>`), feature-sliced React frontend with typed IPC wrappers, Next.js 15 web companion authed over WebSocket.

**Canonical filter-graph order** (enforce in code, snapshot-test against reference PSNR): source decode → denoise → color/tone-map → crop/zoom/pan (source res) → scale to output (single op) → cursor overlay → text overlay → transitions → HW encode.

**Project layout:** `apps/{desktop,web}/` + `packages/{shared-types,story-dsl,ui,config}/` + `crates/{story-parser,automation,capture,effects,encoder,storage}/` + Cargo workspace + Turborepo + pnpm.

Full detail: `.planning/research/ARCHITECTURE.md`.

### Critical Pitfalls

1. **FFmpeg sidecar notarization (nested dylibs)** — build universal static FFmpeg; notarize in CI from day one.
2. **ScreenCaptureKit TCC permission flow** — stable signing identity; preflight probe + relaunch-after-grant helper.
3. **chromiumoxide maturity gaps** — `BrowserDriver` trait with both drivers wired; route risky verbs to Playwright sidecar.
4. **Native capture memory leaks / IOSurface retention** — zero-copy native surfaces; byte-bounded queues; RAII wrappers; CI 30-min memory test.
5. **Audio/video drift** — preserve capture PTS; single clock source; ffprobe alignment check in CI.
6. **Auto-zoom motion sickness** — dwell debounce, minimum shot length, max 2.5-3x zoom, low-pass filter, calm default preset.
7. **pest cryptic errors** — two-layer parser (lenient tokenize + semantic), Levenshtein suggestions, panic-mode recovery, LSP from v1.
8. **Turborepo + native Rust onboarding friction** — platform-gated deps, rust-toolchain pin, sccache documented.

Full detail (12 critical pitfalls + supporting tables): `.planning/research/PITFALLS.md`.

## Implications for Roadmap

**Suggested phases: 5**

### Phase 1: Foundation — DSL + Automation + Capture + Basic Encode
Every downstream feature depends on these four pillars. All three highest-risk pitfalls (FFmpeg notarization, SCK/WGC permissions, chromiumoxide maturity) live here — attempting them later is prohibitive.
**Delivers:** runnable desktop app that parses `.story` files, drives a real browser, captures screen natively on mac+win, pipes frames to bundled FFmpeg, produces playable MP4. Auto-updater + signing + notarization CI green from day one.
**Covers:** DSL parser, browser automation (BrowserDriver trait + Playwright fallback wired), native capture, FFmpeg sidecar pipeline, project persistence (SQLite), basic story editor UI (CodeMirror + diagnostics), recording HUD.

### Phase 2: Cinematic Post-Production
Table-stakes polish cluster. Exploits known click coords for simpler effects than pixel-based tools. Depends entirely on Phase 1's recording + FFmpeg pipeline.
**Delivers:** auto-zoom, smooth cursor (Bezier/minimum-jerk), click ripples, rounded window + backgrounds, scene transitions (xfade), text overlays, trim/cut, BGM mixer, preview renderer, multi-format export (MP4/WebM/GIF) with presets, post-production editor UI (timeline + layer tracks + preset panel).

### Phase 3: Intelligence Layer — AI Authoring + Voiceover
Makes the DSL accessible to non-developers; adds the voiceover polish users ask for immediately after seeing a finished video.
**Delivers:** natural-language → DSL chat with diff preview, AI voiceover (TTS) synced to DSL steps, LSP hover/autocomplete/diagnostics, smart selector engine hardening, dry-run mode (automation only, no render).

### Phase 4: Web Companion + Sharing
Category table stake but not gating for local-first value prop; can lag desktop v1.
**Delivers:** Next.js 15 app with OAuth (NextAuth v5), R2/S3 presigned multipart upload, shareable viewer page + embed, team workspaces, desktop↔web WebSocket sync, basic analytics (view count, watch-through), template marketplace scaffolding.

### Phase 5: Extensibility & Reach (Deferred)
Per PROJECT.md — only attempt after v1 product-market fit.
**Delivers:** headless CLI (trivial if pure-logic crate discipline held), native app automation (macOS AX / Windows UIA), diff-aware re-recording, plugin system, localization re-run, differential auto-updates.

### Phase Ordering Rationale

- **Dependencies drive order:** DSL → automation → capture → encode is a strict chain; post-production requires encoded frames; AI authoring requires stable DSL; web sharing requires local content.
- **Risk-first sequencing:** Phases 1-2 contain all 12 critical pitfalls. Shipping Phase 3 or 4 before Phases 1-2 are solid creates compounding debt.
- **Structural-advantage compounding:** Phase 1 automation emits click coords + step timings → Phase 2 post-production becomes easier (no CV inference), Phase 3 TTS sync becomes trivial (step boundaries known).
- **Out-of-scope protection:** anti-features preserved as competitive moat, not oversight.

### Research Flags

- **Phase 1 — high priority:** macOS universal static FFmpeg + CI notarization end-to-end; SCK `objc2` Swift-shim boundary (cursor exclusion / per-window audio); TCC relaunch-after-grant UX pattern; chromiumoxide spike on riskiest DSL verbs (shadow DOM, file upload, drag, wait-for-network-idle, iframe).
- **Phase 2 — medium:** cursor trajectory model (minimum-jerk vs. Catmull-Rom) with perceptual A/B; auto-zoom planner / low-pass filter; HDR tone-mapping (defer to bt709 in v1); FFmpeg typed-AST filter-graph builder patterns.
- **Phase 3 — medium:** LLM DSL-generation prompt + injection defense; TTS↔timeline alignment; CodeMirror 6 LSP integration.
- **Phase 4 (web companion):** canonical stack; only real spike is desktop↔web WebSocket auth and reconnect.
- **Phase 5 (deferred):** re-research at the time.

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | Validated against official docs + Q1 2026 versions; two stale assumptions corrected (Stronghold deprecated, Framer→Motion). Medium only on competing ScreenCaptureKit crates — pin exact versions. |
| Features | HIGH | Table stakes + competitor matrix cross-verified against live product pages. |
| Architecture | HIGH | Well-documented Tauri patterns; refinement of PROJECT.md layout adds `storage` and `encoder` crates. |
| Pitfalls | HIGH for Tauri/FFmpeg/macOS permissions; MEDIUM for chromiumoxide edge cases + HDR specifics. |

**Overall:** MEDIUM-HIGH. Stack and architecture on solid ground; hard work is execution discipline on known pitfalls.

### Gaps to Address

- **chromiumoxide real-world coverage** — resolve via Phase 1 spike; `BrowserDriver` trait with Playwright sidecar wired from day one.
- **macOS E2E testing** — `tauri-driver` unsupported. Windows E2E via WebdriverIO; macOS via AppleScript/XCUITest or skip UI-level E2E.
- **HDR delivery pipeline** — deferred in v1 (tone-map to SDR BT.709).
- **macOS permission UX polish** — Screen Recording + Accessibility + Sequoia 7-day re-prompt; budget Swift/objc2 helper in Phase 1.
- **Auth.js v5 stability** — pin exact version for Phase 4.
- **FFmpeg GPL vs. LGPL licensing** — recommend LGPL-only + VideoToolbox/NVENC/QSV HW encoders; resolve before first public beta.

## Sources

Official docs: Tauri v2 (blog, sidecar, macOS signing, IPC, updater, plugins, testing) + GitHub issues #8075/#11992; Stronghold deprecation; screencapturekit/windows-capture/xcap crates; chromiumoxide, pest, shadcn/ui, CodeMirror, TanStack Query v5; Next.js 15, tRPC, Prisma, Auth.js; Screen Studio, Tella, Arcade, Supademo, Scribe, Loom, Demo Time feature pages; Playwright videos; Apple TCC / ScreenCaptureKit; Microsoft Windows.Graphics.Capture; `.planning/PROJECT.md`.

Secondary: Aptabase Tauri logging/panic guides; Rust parser/ORM 2025-2026 comparisons; Turborepo 2026 practices; vendor comparison posts.

---
*Research completed: 2026-04-14*
*Ready for roadmap: yes*
