<!-- GSD:project-start source:PROJECT.md -->
## Project

**StoryCapture**

StoryCapture is a cross-platform desktop application (Windows + macOS) that turns structured user stories into polished demo videos. Users write stories in a simple DSL describing UI actions (click, type, navigate, etc.); the app automates those actions against a real browser (and, eventually, native apps), records the screen, and applies cinematic post-production (auto-zoom, cursor animations, transitions, sound, backgrounds). A Next.js web companion hosts, shares, and analyzes the resulting recordings.

**Core Value:** **Turn a written story into a polished, shareable demo video automatically — no recording, editing, or video-production skill required.**

### Constraints

- **Tech stack**: Tauri v2 (not Electron) — chosen for startup time, memory footprint, and bundle size targets.
- **Component library**: shadcn/ui + Base UI primitives, `base-vega` style — NOT Radix UI. Render-prop flexibility, single dep, better Select/Combobox support for timeline/editor compositions.
- **Platforms**: Windows + macOS desktop only for v1; Linux and mobile excluded.
- **Distribution**: Cannot ship via Mac App Store (screen-recording apps are restricted). Direct distribution + notarization required.
- **Performance**: <2s cold start, <300MB idle / <800MB recording, <50MB installer, 1-min video under 30s render.
- **Security/privacy**: Offline-first desktop; no telemetry by default; recordings stored locally; web uploads encrypted in transit + at rest; API keys in OS keychain.
- **Accessibility**: WCAG 2.1 AA baseline across all custom UI.
<!-- GSD:project-end -->

<!-- GSD:stack-start source:research/STACK.md -->
## Technology Stack

## Validation Summary (Committed Stack)
| Committed Choice | Verdict | Confidence | Notes |
|---|---|---|---|
| Tauri v2 (over Electron) | ✅ Validated | HIGH | Stable since Oct 2024; mature ecosystem in 2026. Meets startup/memory/bundle budgets. |
| React 19 + Vite | ✅ Validated | HIGH | Current stable. Vite 6+ recommended. |
| Tailwind v4 | ✅ Validated | HIGH | Stable; shadcn/ui fully supports v4. CSS-first config (`@theme`) is the new default. |
| shadcn/ui + Base UI (`base-vega` style) | ✅ Validated | MEDIUM | shadcn now officially supports Base UI as an alternative to Radix. "Vega (New York)" is the canonical shadcn look; confirm the `base-vega` registry entry is current. |
| Zustand v5 + TanStack Query v5 | ✅ Validated | HIGH | Canonical 2025/2026 split: Zustand=client UI state, TanStack Query=server state. TanStack Query v5 has native React 19 Suspense support. |
| Framer Motion + Lucide | ✅ Validated | HIGH | Note: Framer Motion rebranded to **Motion** (`motion`) in 2024; use `motion/react` package. |
| chromiumoxide (primary) + Playwright sidecar (fallback) | ⚠️ Keep-with-caveats | MEDIUM | chromiumoxide is production-ready but pre-1.0 (latest 0.7.x); lacks anti-bot/stealth tooling. Fallback strategy is sound — prototype early (see PITFALLS). |
| FFmpeg Tauri sidecar | ⚠️ Keep-with-caveats | MEDIUM | Sidecar binaries work, but **macOS notarization of FFmpeg's nested dylibs is a known pain point** (Tauri issue #8075, #11992). Requires universal builds + explicit re-signing of inner dylibs. |
| ScreenCaptureKit via objc2 | ⚠️ Keep-with-caveats | MEDIUM | Multiple competing crates exist. Recommend **`screencapturekit` (doom-fish)** as higher-level safe API, using `objc2-screen-capture-kit` directly only where needed. |
| Windows.Graphics.Capture via windows-rs | ✅ Validated | HIGH | Prefer the **`windows-capture` crate** (NiiightmareXD) which wraps `windows-rs` with a sane async API; drop to raw `windows-rs` only for capabilities the wrapper lacks. |
| XCap fallback | ✅ Validated | MEDIUM | `xcap` 0.8.x, actively maintained; screenshots solid, video recording still WIP — reasonable fallback only. |
| pest DSL parser | ✅ Validated | HIGH | Good choice for DSL with a grammar file. Consider chumsky later if IDE-quality error recovery becomes a priority. |
| rusqlite | ✅ Validated | HIGH | Idiomatic for Tauri: sync is fine on desktop, `bundled` feature gives zero-system-dep builds. Pair with `rusqlite_migration` or `refinery`. |
| Next.js 15 App Router + Prisma + PostgreSQL + tRPC + NextAuth + R2/S3 | ✅ Validated | HIGH | Canonical 2026 typesafe stack. Use NextAuth v5 (Auth.js) with Prisma adapter. |
| Turborepo (apps/desktop, apps/web, packages/*, crates/*) | ✅ Validated | HIGH | Turborepo 2.x has first-class Rust/Go task support; shared TS packages + Cargo workspace coexist cleanly. |
## Recommended Stack (Prescriptive Versions)
### Desktop Core — Rust
| Crate | Version | Purpose | Why |
|---|---|---|---|
| `tauri` | 2.8.x | App shell, IPC, windowing | Stable v2 line; sidecar + updater support |
| `tauri-build` | 2.x | Build-time codegen | Required |
| `tauri-plugin-log` | 2.8.x | Structured logs to stdout + file | Official; integrates with `log` crate |
| `tauri-plugin-store` | 2.4.x | Persistent JSON key/value for non-secret prefs | Official |
| `tauri-plugin-updater` | 2.10.x | Signed auto-update with diff patches | Official |
| `tauri-plugin-keyring` (community, HuakunShen) **or** `tauri-plugin-secure-storage` (ThatzOkay) | latest | OS keychain for API keys (OpenAI/Anthropic, R2 tokens) | **Stronghold is deprecated for v3** — do not use |
| `tauri-plugin-dialog` | 2.x | Native file/folder pickers | Official |
| `tauri-plugin-fs` | 2.x | Scoped filesystem access | Official |
| `tauri-plugin-shell` | 2.x | Sidecar launching (FFmpeg, Playwright fallback) | Official |
| `tauri-plugin-opener` | 2.x | Open URLs/files in system default | Official |
| `tauri-plugin-process` | 2.x | Restart/exit APIs | Official, needed for updater |
| `tauri-plugin-single-instance` | 2.x | Prevent multiple desktop processes | Official |
| `tauri-plugin-window-state` | 2.x | Persist window position/size | Official |
| `tauri-plugin-os` | 2.x | Platform/arch detection | Official |
### Desktop — Rust Domain Crates
| Crate | Version | Purpose | Why |
|---|---|---|---|
| `tokio` | 1.40+ | Async runtime | Required by chromiumoxide + sqlx-style async |
| `pest`, `pest_derive` | 2.7.x | DSL grammar + parser | Committed; good DX |
| `chromiumoxide` | 0.7.x | CDP browser automation | Primary path; prototype coverage early |
| `rusqlite` (feature = `bundled`) | 0.33.x | Embedded SQLite | Zero system deps; sync is fine for desktop |
| `rusqlite_migration` | 1.3.x | Versioned schema migrations for rusqlite | Simple, stable |
| `serde`, `serde_json` | 1.x | IPC serialization | Required by Tauri |
| `thiserror` | 2.x | Structured error enums for commands/libs | Standard |
| `anyhow` | 1.x | Top-level error handling in main + handlers | Standard pair with thiserror |
| `tracing`, `tracing-subscriber` | 0.1 / 0.3 | Spans + structured logs (recording pipelines) | Preferred over `log` for async/span-heavy code; bridge into `tauri-plugin-log` via `tracing-log` |
| `uuid` (feature = `v4`, `v7`) | 1.x | Recording IDs, project IDs | Standard |
| `time` or `chrono` | 0.3 / 0.4 | Timestamps for recordings | Prefer `time` |
| `dirs` / `directories` | 5.x | Cross-platform project/data dirs | Standard |
| `notify` | 6.x | File watcher for project folder | Only if reload-on-change needed |
| `which` | 7.x | Locate bundled FFmpeg at runtime | Defensive sidecar resolution |
| `image` | 0.25.x | Frame buffer manipulation, cursor overlay compositing | De facto standard |
| `tempfile` | 3.x | Staging intermediate frame directories | Standard |
| `parking_lot` | 0.12.x | Faster Mutex/RwLock than std | Standard in perf-sensitive paths |
| `rayon` | 1.x | Parallelize frame processing (cursor overlay, zoom math) | Standard |
### Desktop — Platform-Native Capture
| Crate | Version | Purpose | Why |
|---|---|---|---|
| `screencapturekit` (doom-fish) | 1.70.x | Safe ergonomic ScreenCaptureKit wrapper | **Recommended over raw objc2** — handles streaming, audio, window/display filtering |
| `objc2`, `objc2-foundation`, `objc2-core-media`, `objc2-screen-capture-kit` | current | Drop-down when `screencapturekit` crate lacks a capability | Use surgically |
| `windows-capture` (NiiightmareXD) | 1.5.x | High-level Windows.Graphics.Capture wrapper | **Recommended over raw `windows` crate** — async API, D3D11 frame acquisition, cursor toggle |
| `windows` (windows-rs) | 0.58+ | Escape hatch for WGC features not in the wrapper | Only as needed |
| `xcap` | 0.8.x | Cross-platform fallback for screenshot/edge-case capture | As documented fallback |
### Desktop — Browser Automation
| Crate | Version | Purpose | Why |
|---|---|---|---|
| `chromiumoxide` | 0.7.x | Primary CDP automation | In-process, Rust-native |
| `url` | 2.x | URL handling for navigate commands | Standard |
| Playwright (Node sidecar, JS driver) | 1.48+ | Fallback for sites/flows chromiumoxide can't handle | Shipped as bundled Node + `playwright-core` sidecar only if needed |
### Desktop — FFmpeg Sidecar
- **Binary:** FFmpeg 7.1 (LTS-ish stable line as of 2026), built per-arch (x86_64-apple-darwin, aarch64-apple-darwin, x86_64-pc-windows-msvc), shipped as `src-tauri/binaries/ffmpeg-<triple>`.
- **Hardware encoders:** `h264_videotoolbox`/`hevc_videotoolbox` (macOS), `h264_nvenc`/`hevc_nvenc` (Windows NVIDIA), `h264_qsv`/`hevc_qsv` (Windows Intel), `h264_amf` (Windows AMD). Feature-detect at runtime; fall back to libx264.
- **Bundling:** Prefer **statically-linked FFmpeg** to sidestep nested-dylib notarization issues (see PITFALLS). If you must use shared dylibs, every `.dylib` inside the bundle must be signed and listed in `bundle.macOS.frameworks`.
### Frontend — Desktop (React 19)
| Package | Version | Purpose |
|---|---|---|
| `react`, `react-dom` | 19.x | UI runtime |
| `vite` | 6.x | Dev server + build |
| `@vitejs/plugin-react` | 4.x | React Fast Refresh |
| `typescript` | 5.7+ | Types |
| `tailwindcss` | 4.x | Styling (CSS-first `@theme`) |
| `@tailwindcss/vite` | 4.x | Vite plugin for Tailwind v4 |
| `tailwind-merge`, `clsx` | latest | Class composition helpers |
| `tailwindcss-animate` or Tailwind v4 native utilities | latest | Animation utilities |
| shadcn/ui CLI (`shadcn`) | latest | Component scaffolding (Base UI + Vega style) |
| `@base-ui-components/react` | 1.x | Base UI primitives |
| `motion` (Framer Motion successor) | 12.x | Animations (`import { motion } from 'motion/react'`) |
| `lucide-react` | 0.460+ | Icons |
| `zustand` | 5.x | Client UI state |
| `@tanstack/react-query` | 5.x | Server/IPC cached state (wrap Tauri `invoke` in query functions) |
| `@tanstack/react-query-devtools` | 5.x | Dev UX |
| `react-hook-form` + `zod` + `@hookform/resolvers` | latest | Form/validation (export settings, project metadata) |
| `@codemirror/*` + `@uiw/react-codemirror` | 6.x / 4.25.x | DSL editor with syntax highlighting + autocomplete |
| `@codemirror/autocomplete`, `@codemirror/language`, `@codemirror/lint`, `@lezer/highlight` | 6.x | DSL-specific language support |
| `react-router-dom` | 7.x (data router) or TanStack Router 1.x | Desktop routing |
| `sonner` | 1.x | Toasts (shadcn idiom) |
| `cmdk` | 1.x | Command palette |
| `@tauri-apps/api` | 2.x | IPC bindings |
| `@tauri-apps/plugin-*` | 2.x | JS sides of the Tauri plugins above |
### Web Companion (Next.js 15)
| Package | Version | Purpose |
|---|---|---|
| `next` | 15.x (App Router) | Framework |
| `react`, `react-dom` | 19.x | Match desktop |
| `typescript` | 5.7+ | Types |
| `tailwindcss` | 4.x | Styling (shared tokens package) |
| `@trpc/server`, `@trpc/client`, `@trpc/react-query`, `@trpc/next` | 11.x | Typed RPC |
| `zod` | 3.x | tRPC input validation |
| `@prisma/client`, `prisma` | 6.x | ORM + migrations |
| `next-auth` (Auth.js) | 5.x (beta stable in 2026) | OAuth (Google/GitHub) |
| `@auth/prisma-adapter` | latest | User/session persistence |
| `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner` | 3.x | R2/S3 uploads via presigned URLs |
| `@tanstack/react-query` | 5.x | Must match desktop major |
| `ws` + `@trpc/server/adapters/ws` **or** `y-websocket`-style worker | latest | Desktop↔web WebSocket sync endpoint |
| `jose` | 5.x | JWT verification for desktop session tokens |
| `pino` + `pino-pretty` | 9.x / 11.x | Server logs |
### Monorepo & Tooling
| Tool | Version | Purpose |
|---|---|---|
| Turborepo | 2.5+ | Task orchestration, remote cache |
| pnpm | 9.x | Workspace package manager |
| Cargo workspaces (crates/*) | — | Shared Rust crates (story-parser, capture, automation, effects) |
| Biome or ESLint + Prettier | latest | Lint/format JS/TS (**Biome** recommended 2026: one tool, Rust-fast) |
| `rustfmt`, `clippy` | pinned via `rust-toolchain.toml` | Rust lint/format |
| `cargo-edit`, `cargo-nextest`, `cargo-deny` | latest | Rust DX/CI |
| `changesets` | latest | Versioning shared packages |
| `tsx` or `bun` | latest | Run TS scripts |
### Testing
| Tool | Version | Purpose |
|---|---|---|
| Vitest | 2.x | Unit tests for React + TS packages |
| `@testing-library/react` + `@testing-library/user-event` | latest | Component tests |
| `@tauri-apps/api/mocks` (`mockIPC`) | 2.x | Stub Tauri commands in Vitest |
| Playwright | 1.48+ | Next.js web E2E + *also* the sidecar fallback binary |
| WebdriverIO + `tauri-driver` | latest | Tauri desktop E2E (works on Windows + Linux; **macOS tauri-driver is not supported** — gate macOS E2E accordingly) |
| `cargo test` + `cargo-nextest` | latest | Rust unit/integration |
| `insta` | 1.x | Snapshot tests for DSL parser output |
| `proptest` or `quickcheck` | latest | Property tests for DSL + selector engine |
| `criterion` | 0.5 | Benchmarks for frame pipeline |
### CI/CD
| Tool | Purpose |
|---|---|
| GitHub Actions matrix (macos-14 arm64, macos-13 x64, windows-latest x64) | Multi-platform build + sign + notarize |
| `tauri-apps/tauri-action` | Official bundler action |
| `apple-actions/import-codesign-certs` + notarytool | macOS signing + notarization |
| Azure Trusted Signing **or** SignPath / EV cert | Windows code signing (2026: Microsoft Trusted Signing is the cheap default) |
| Turborepo Remote Cache (Vercel or self-hosted) | Build cache |
| `cargo-deny` in CI | License + advisory scan |
### Observability (Telemetry-Off by Default)
| Concern | Approach |
|---|---|
| Structured logs | `tracing` → `tauri-plugin-log` to app data dir, rotated daily, **opt-in** upload button ("Send logs to support") |
| Panic capture | `std::panic::set_hook` → write panic + backtrace to log file, show "restart & report" dialog (Aptabase pattern, no network) |
| Crash reporter | **Sentry opt-in only**, or roll your own log-zip-upload. Do NOT use default-enabled crash reporting. |
| Metrics | Local Prometheus-style counters exposed via a hidden debug window; no network export |
| Web companion | `pino` structured logs, OpenTelemetry optional, no product analytics by default |
## Gaps the Committed Stack Does Not Cover
## What NOT to Use
| Avoid | Why | Use Instead |
|---|---|---|
| **Tauri Stronghold plugin** | Officially deprecated; removed in v3 | `tauri-plugin-keyring` / `tauri-plugin-secure-storage` |
| **Electron** | 3-5× memory, 100MB+ installer, Node sandboxing quirks; blows PROJECT.md perf budgets | Tauri v2 (committed) |
| **Radix UI** | Fine library, but shadcn+Base UI gives better render-prop flexibility per PROJECT.md decision | Base UI (committed) |
| **Stronghold-bundled secret storage** | See above | OS keychain |
| **ESLint + Prettier + multiple configs** | Slow, fragmented in 2026 monorepos | Biome |
| **SeaORM / Diesel for the desktop SQLite cache** | Overkill for local metadata; async/DSL overhead not worth it | `rusqlite` (committed) |
| **`log` crate alone** (no `tracing`) | Hard to correlate spans across async recording pipelines | `tracing` with `tauri-plugin-log` bridge |
| **Raw `objc` (v1) bindings** | Unmaintained; unsafe ergonomics | `objc2` family (committed) |
| **MediaRecorder / getDisplayMedia from the webview** | Quality, FPS, and cursor fidelity insufficient for cinematic output | Native capture (committed) |
| **`headless_chrome` crate** | Less maintained than chromiumoxide | `chromiumoxide` (committed) |
| **Mac App Store distribution** | Screen recording + sandbox incompatible | Direct distribution + notarization (committed) |
| **Playwright E2E against Tauri on Linux** | WebKitGTK ≠ Chromium; Playwright can't drive it | WebdriverIO + tauri-driver (Windows); skip macOS |
| **Default-enabled Sentry / PostHog** | Violates "no telemetry" constraint | Local logs + opt-in upload |
## Risk Flags (per Quality Gate)
### chromiumoxide maturity — MEDIUM risk
- Still pre-1.0 (0.7.x). API shifts happen between minor versions. No built-in stealth/anti-bot. Some CDP domains (e.g., Fetch request interception, Accessibility tree) are thinner than the JS Puppeteer/Playwright counterparts.
- **Mitigation:** Prototype the 5 riskiest DSL verbs (click with shadow DOM, file upload, drag, wait-for-network-idle, iframe nav) in Phase 0. Keep the Playwright Node sidecar wired from day one so the fallback path is never aspirational.
### FFmpeg sidecar notarization — HIGH risk
- Tauri v2 bundler signs the top-level sidecar, **but does not recursively sign `.dylib` files inside Frameworks** (tauri issue #8075). Apple notarization rejects unsigned inner binaries.
- **Mitigation:** (1) Build FFmpeg **statically** for macOS so there are no inner dylibs — preferred. (2) If dynamic, add a post-bundle step that walks the `.app` and signs every Mach-O with `codesign --force --timestamp --options runtime --sign "$CERT"`. Run notarytool in CI on every PR that touches the bundle.
### ScreenCaptureKit bindings — MEDIUM risk
- Three competing crates (`screencapturekit`, `objc2-screen-capture-kit`, `screen-capture-kit`) with overlapping but non-identical coverage. API breakage possible.
- **Mitigation:** Pin `screencapturekit = "=1.70.x"` exactly. Wrap all SCK usage behind a thin internal trait in `crates/capture` so swapping the backing crate is a one-file change. Budget a small Swift shim if a specific capability (e.g., cursor-exclusion, per-window audio) is missing from all three crates.
### Additional flags
- **macOS permission UX:** Screen Recording + Accessibility permissions require app restart on first grant. Non-obvious; plan an onboarding flow.
- **Hardware encoder variance:** NVENC on consumer laptops caps concurrent sessions; QSV support varies by CPU gen. Feature-detect; fall back to libx264.
- **Auth.js v5 stability:** has been in beta/RC for an unusually long time; pin an exact version and don't auto-update.
## Version Compatibility Notes
| Pair | Note |
|---|---|
| Tailwind v4 + shadcn/ui | Requires shadcn registry items tagged for v4 (`base-vega` must be v4 variant). |
| React 19 + `@uiw/react-codemirror` 4.25+ | Confirmed OK in releases through March 2026. |
| Zustand 5 + React 19 | Drop of deprecated default-export semantics; update imports if coming from v4. |
| TanStack Query 5 + React 19 Suspense | `useSuspenseQuery` is the preferred surface for IPC calls that gate UI. |
| Tauri 2.8 + plugins 2.x | Plugin major must match Tauri major; check minors at update time. |
| chromiumoxide + tokio 1.40+ | Required; avoid tokio 1.38/1.39 due to Send bounds regressions. |
| Prisma 6 + Next.js 15 App Router | Use the Prisma Next.js guide; generate client to `./generated` and import from there to avoid RSC bundling bloat. |
| Auth.js v5 + Prisma 6 | Use `@auth/prisma-adapter` matching v5. |
## Sources
- Tauri v2 stable release — https://v2.tauri.app/blog/tauri-20/
- Tauri v2 sidecar docs — https://v2.tauri.app/develop/sidecar/
- Tauri macOS signing — https://v2.tauri.app/distribute/sign/macos/
- Tauri nested dylib signing bug — https://github.com/tauri-apps/tauri/issues/8075
- Tauri externalBin notarization issue — https://github.com/tauri-apps/tauri/issues/11992
- Tauri plugin log — https://crates.io/crates/tauri-plugin-log (v2.8.x)
- Tauri plugin store — https://crates.io/crates/tauri-plugin-store (v2.4.x)
- Tauri plugin updater — https://crates.io/crates/tauri-plugin-updater (v2.10.x)
- Stronghold deprecation note — https://v2.tauri.app/plugin/stronghold/
- Tauri keyring plugin (community) — https://github.com/HuakunShen/tauri-plugin-keyring
- Tauri secure-storage plugin — https://github.com/thatzokay/tauri-plugin-secure-storage
- Tauri state + IPC concepts — https://v2.tauri.app/concept/inter-process-communication/
- chromiumoxide on docs.rs — https://docs.rs/chromiumoxide
- chromiumoxide comparison (DEV, 2025) — https://dev.to/vhub_systems_ed5641f65d59/puppeteer-in-rust-chromiumoxide-and-headlesschrome-vs-the-python-alternative-4ji0
- `screencapturekit` (doom-fish) — https://github.com/doom-fish/screencapturekit-rs
- `objc2-screen-capture-kit` — https://docs.rs/objc2-screen-capture-kit
- `windows-capture` — https://github.com/NiiightmareXD/windows-capture
- Windows.Graphics.Capture (windows-rs) — https://microsoft.github.io/windows-docs-rs/doc/windows/Graphics/Capture/index.html
- xcap — https://github.com/nashaofu/xcap
- pest — https://pest.rs/
- Rust parser comparison (2025) — https://rustprojectprimer.com/ecosystem/parsing.html
- Rust ORMs 2026 comparison — https://aarambhdevhub.medium.com/rust-orms-in-2026-diesel-vs-sqlx-vs-seaorm-vs-rusqlite-706d0fe912f3
- Tauri + SQLite guide — https://dezoito.github.io/2025/01/01/embedding-sqlite-in-a-tauri-application.html
- shadcn/ui Tailwind v4 + React 19 — https://ui.shadcn.com/docs/tailwind-v4 / https://ui.shadcn.com/docs/react-19
- `@uiw/react-codemirror` — https://github.com/uiwjs/react-codemirror
- TanStack Query v5 — https://tanstack.com/blog/announcing-tanstack-query-v5
- tRPC + Prisma + Next.js 15 guide (2026) — https://noqta.tn/en/tutorials/trpc-prisma-nextjs-production-api-2026
- Auth.js + Prisma + Next.js — https://www.prisma.io/docs/guides/authjs-nextjs
- Turborepo 2026 monorepo practices — https://medium.com/@mernstackdevbykevin/monorepos-with-typescript-93c9233f6df8
- Tauri WebDriver testing — https://v2.tauri.app/develop/tests/webdriver/
- Aptabase panic-handling guide — https://aptabase.com/blog/catching-panics-on-tauri-apps
- Aptabase Tauri logging guide — https://aptabase.com/blog/complete-guide-tauri-log
- Tauri v2 production shipping walkthrough — https://dev.to/0xmassi/shipping-a-production-macos-app-with-tauri-20-code-signing-notarization-and-homebrew-mc3
<!-- GSD:stack-end -->

<!-- GSD:conventions-start source:CONVENTIONS.md -->
## Conventions

Conventions not yet established. Will populate as patterns emerge during development.
<!-- GSD:conventions-end -->

<!-- GSD:architecture-start source:ARCHITECTURE.md -->
## Architecture

Architecture not yet mapped. Follow existing patterns found in the codebase.
<!-- GSD:architecture-end -->

<!-- GSD:skills-start source:skills/ -->
## Project Skills

No project skills found. Add skills to any of: `.claude/skills/`, `.agents/skills/`, `.cursor/skills/`, or `.github/skills/` with a `SKILL.md` index file.
<!-- GSD:skills-end -->

<!-- GSD:workflow-start source:GSD defaults -->
## GSD Workflow Enforcement

Before using Edit, Write, or other file-changing tools, start work through a GSD command so planning artifacts and execution context stay in sync.

Use these entry points:
- `/gsd-quick` for small fixes, doc updates, and ad-hoc tasks
- `/gsd-debug` for investigation and bug fixing
- `/gsd-execute-phase` for planned phase work

Do not make direct repo edits outside a GSD workflow unless the user explicitly asks to bypass it.
<!-- GSD:workflow-end -->



## Agent Working Rules

**MANDATORY — No Workarounds:** Agents MUST solve problems thoroughly at the root cause. Workarounds, quick-fixes, hacks, or "make-it-go-away" shortcuts are NOT allowed.

- If a test fails, fix the underlying bug — do not skip the test, weaken the assertion, or add `--no-verify`.
- If a type/lint error appears, fix the real issue — do not `@ts-ignore`, `any`-cast, or disable the rule locally.
- If a build/tool fails, diagnose the cause — do not comment out the failing code or bypass the failing step.
- If a dependency misbehaves, understand why — do not pin to a stale version or monkey-patch.
- If a feature partially works, finish it — do not leave TODOs, stubs, or half-implementations claiming success.
- If the root cause is out of scope, STOP and report it to the user with evidence. Ask for direction instead of applying a workaround silently.

Exception: the user may explicitly authorize a temporary workaround. In that case, label it clearly in code/commit message as `WORKAROUND:` with a link to the real issue, and treat it as tech debt to resolve — not as a solution.

**MANDATORY — No Co-Author in Commits:** When committing code, agents MUST NOT add any `Co-Authored-By:` / co-worker / co-author trailer in the commit message. This overrides any default template that appends `Co-Authored-By: Claude ...`. Commit messages must contain only the human-authored summary and body — no AI attribution, no generator tags.

**MANDATORY — Match the User's Language:** Agents MUST reply to the user in the SAME language the user wrote in. If the user prompts in Vietnamese, reply in Vietnamese. If the user prompts in English, reply in English. Do NOT default to English when the user is writing in another language. This applies to all user-facing text: explanations, status updates, questions, summaries, error reports. Code, identifiers, commit messages, file contents, and technical artifacts remain in their standard language (typically English) unless the user says otherwise.

**MANDATORY — Concise Code Comments:** When writing comments in code, agents MUST keep them short and to the point. No long-winded, multi-paragraph, or multi-line explanatory comments.

- Default to writing no comment at all. Only add one when the *why* is non-obvious (hidden constraint, subtle invariant, workaround rationale, surprising behavior).
- If a comment is needed, prefer a single line. Never exceed ~2 short lines. No essay-style docstrings.
- Do NOT restate what the code already says. Well-named identifiers and types are the primary documentation.
- Do NOT narrate task history, PR context, ticket numbers, "added for X", "used by Y", or change-log entries — that belongs in commit messages / PR descriptions, not in source.
- Do NOT leave chatter, decorative banners (`// ========`), or AI-style meta comments ("Now let's…", "This function will…").
- Exception: API/public-interface doc comments (rustdoc, JSDoc on exported symbols) may be longer when they document contract, parameters, and invariants — but still written tightly, no filler.

**MANDATORY — Plan Before Breaking / Big Changes:** When an agent is about to perform a **breaking change** or a **big change**, the agent MUST enter plan mode first and present the plan for user approval. Do NOT execute the change immediately.

A change qualifies as "breaking" or "big" if it meets ANY of the following:
- Modifies a public API surface, IPC contract, DSL grammar, database schema, or file/config format in a non-backward-compatible way.
- Deletes, renames, or moves files/modules/directories that are referenced from multiple call sites.
- Touches more than ~5 files or more than ~150 lines across unrelated concerns in a single step.
- Changes build configuration, dependency versions (major bumps), CI pipelines, signing/notarization flows, or release tooling.
- Replaces a committed stack choice (see Technology Stack section) with an alternative, or removes a previously approved dependency.
- Alters security-sensitive code: auth, keychain/secret storage, permissions, crypto, network boundaries.
- Refactors that change architectural boundaries (module splits/merges, ownership of state, data flow direction).
- Any change the agent itself is uncertain about or suspects may have non-obvious downstream effects.

Required protocol:
1. STOP before editing. Enter plan mode (use `ExitPlanMode` / plan-presentation flow, or the active GSD planning command such as `/gsd-plan-phase`, `/gsd-discuss-phase`, or `/gsd-spec-phase`).
2. Present: scope, files/modules affected, rationale, risks, rollback strategy, and test/verification plan.
3. Wait for explicit user approval before executing. Do not start edits during planning.
4. If mid-task the scope expands into a breaking/big change, STOP immediately, re-enter plan mode, and seek re-approval — do not silently widen the change.

Exception: the user may explicitly say "skip plan mode" or "just do it" for a specific change. That authorization applies only to that single change, not to future ones.



<!-- GSD:profile-start -->
## Developer Profile

> Profile not yet configured. Run `/gsd-profile-user` to generate your developer profile.
> This section is managed by `generate-claude-profile` -- do not edit manually.
<!-- GSD:profile-end -->
