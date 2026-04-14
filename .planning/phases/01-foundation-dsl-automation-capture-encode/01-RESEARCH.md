# Phase 1: Foundation — DSL, Automation, Capture, Encode — Research

**Researched:** 2026-04-14
**Domain:** Tauri v2 desktop (mac+win): DSL parser (pest) → browser automation (chromiumoxide + Playwright sidecar) → native capture (SCK/WGC) → FFmpeg static-universal sidecar → signed/notarized MP4 from day 1
**Confidence:** MEDIUM-HIGH (project-level research is authoritative; phase-specific risks carry MEDIUM confidence where they depend on unpublished/version-specific crate internals — flagged below)

---

## Project Constraints (from CLAUDE.md)

- **GSD workflow enforcement:** all file edits flow through a GSD command (planner honors this — Phase 1 plans are the legitimate entry point).
- **Stack verdict (from STACK.md):** Tauri v2, React 19 + Vite 6, Tailwind v4, shadcn/ui + Base UI (`base-vega`), **Motion** (not Framer Motion), Zustand v5 + TanStack Query v5, chromiumoxide + Playwright sidecar, FFmpeg sidecar, `screencapturekit` (doom-fish) + `windows-capture` (NiiightmareXD), rusqlite bundled, pest.
- **Do-not-use list from STACK.md:** Stronghold, Electron, Radix UI, ESLint+Prettier combo, SeaORM/Diesel, `log` alone, raw objc v1, MediaRecorder, `headless_chrome`, MAS distribution, Playwright E2E against Tauri, default-on telemetry.
- **Perf budgets (PROJECT.md):** <2s cold start, <300MB idle / <800MB recording, <50MB installer (ex. FFmpeg), 1-min video renders in <30s.
- **Offline-first; no telemetry; OS keychain for secrets; WCAG 2.1 AA.**

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Monorepo & Build**
- D-01: Turborepo 2.5 + pnpm + Cargo workspace with layout from research/ARCHITECTURE.md: `apps/{desktop,web}`, `packages/{shared-types,story-dsl,ui,config}`, `crates/{story-parser,automation,capture,effects,encoder,storage}`. `apps/web` scaffolded but empty (Phase 4).
- D-02: Linting/formatting via **Biome** single tool (not ESLint + Prettier). Rust uses `rustfmt` + `clippy`.
- D-03: `rust-toolchain.toml` pinned; platform-gated native deps in `Cargo.toml`.
- D-04: sccache with S3/local shared cache documented in CONTRIBUTING.md.

**Typed IPC**
- D-05: Typed IPC codegen via **`tauri-specta`** (not `taurpc`). Emit TS bindings to `packages/shared-types/src/ipc.ts`.
- D-06: `#[tauri::command]` request/response + `emit`/`listen` broadcast + Tauri v2 `Channel<T>` streams. No `Arc<Mutex<BigState>>` — tokio mpsc actors.

**DSL Parser**
- D-07: **pest**. AST types in `crates/story-parser` with `Span` on every node. Pure crate — CLI-ready.
- D-08: Two-layer parse (lenient tokenize + semantic check), Levenshtein "did you mean".
- D-09: Panic-mode recovery on statement boundaries (multi-error reporting).
- D-10: DSL mirror types in `packages/story-dsl` generated from Rust AST via `ts-rs` or `specta`.

**Browser Automation**
- D-11: `BrowserDriver` trait with `ChromiumoxideDriver` + `PlaywrightSidecarDriver` **from day one**.
- D-12: Explicit auto-waiting — every verb has pre-condition predicate.
- D-13: Smart selector fallback chain: visible text → `data-testid` → `aria-label` → CSS.
- D-14: Route known-weak chromiumoxide verbs (`upload`, `wait-for-download`, shadow-DOM click, OAuth popups) to Playwright via capability flags.
- D-15: Playwright sidecar **bundled** (Node + Playwright packaged).

**Screen Capture**
- D-16: macOS: `screencapturekit` crate (doom-fish fork), exact version pin. Stable signing identity for dev.
- D-17: Windows: `windows-capture` crate (NiiightmareXD).
- D-18: `xcap` documented fallback.
- D-19: Zero-copy pipeline; **byte-bounded** queue (cap ~256 MB); RAII wrappers; dropped-frame counter.
- D-20: TCC UX: `CGPreflightScreenCaptureAccess()` → guided modal → relaunch-after-grant helper (Sequoia 7-day).
- D-21: Single clock source: `CMTime` (mac) / `QueryPerformanceCounter` (win). Preserve capture PTS.

**Encoder / FFmpeg**
- D-22: FFmpeg **7.x universal static binary**, LGPL only — VT/NVENC/QSV. Recipe in `scripts/build-ffmpeg/`.
- D-23: Tauri **externalBin** sidecar; stdin/stdout pipes; lifecycle owned by `crates/encoder`.
- D-24: Runtime HW-encoder feature detection; fall back to `libx264` (verify LGPL) → `mpeg4` → error.
- D-25: Phase 1 output MP4 / H.264 only (capture-native resolution).
- D-26: `ffprobe` A/V alignment CI job on synthetic 10-minute recording — drift >100ms fails.

**Storage**
- D-27: Two-tier SQLite via `rusqlite` (bundled) + `rusqlite_migration`: global `app.sqlite` + per-project `project.sqlite`.
- D-28: Project folder is the portable unit.
- D-29: Secrets via `tauri-plugin-keyring` (NOT Stronghold). Scaffolded in Phase 1.

**Logging / Errors**
- D-30: `tracing` + `tauri-plugin-log`. No telemetry by default.
- D-31: `thiserror` in crates; `anyhow` at Tauri boundary. Panic handler to UI + log.

**Desktop UI (Phase 1 scope)**
- D-32: shadcn/ui + **Base UI** (`base-vega`) via `npx shadcn create`. Verify Tailwind v4 compatibility.
- D-33: Dark-first theme blending Runway + Linear + ElevenLabs tokens (`npx getdesign@latest add ...`).
- D-34: Geist Sans UI, **JetBrains Mono** for DSL editor. Lucide icons.
- D-35: **`motion/react`** (not framer-motion).
- D-36: Phase 1 UI: Dashboard (UI-01), Story Editor w/ CodeMirror + preview + timeline (UI-02/03), Recording View w/ HUD + cursor trail (UI-04).
- D-37: CodeMirror 6 via `@uiw/react-codemirror`; custom DSL language pack; diagnostics over IPC (**no LSP** in Phase 1).
- D-38: Selector autocomplete — Story Editor requests live DOM from browser session via Tauri command.
- D-39: Zustand (UI state) + TanStack Query v5 (IPC cache).

**Distribution & CI**
- D-40: GitHub Actions matrix: macOS arm64, macOS x64, Windows x64 — every PR. sccache + `actions/cache`. Sign+notarize only on tagged releases.
- D-41: macOS: Developer ID App + hardened runtime + Screen Recording + Accessibility entitlements. `notarytool` in CI. Staple before archive.
- D-42: Windows signing: Microsoft Trusted Signing preferred or EV via Azure Key Vault. Unsigned Windows PR builds OK.
- D-43: Tauri built-in auto-updater, **full-package** updates (differential = Phase 5).
- D-44: Installer size budget: <50 MB (ex. FFmpeg). Baseline: single installer including FFmpeg, accept ~130 MB total.

**Testing**
- D-45: `cargo test` per crate; integration tests for each domain crate; 30-min capture soak in CI; `ffprobe` encoder check.
- D-46: Vitest + RTL + `mockIPC` frontend.
- D-47: WebdriverIO + `tauri-driver` **Windows only**. macOS E2E manual in Phase 1.

### Claude's Discretion
- Exact tokio runtime configuration (worker-thread count, blocking-task pool size).
- Internal actor channel sizes beyond the byte-bounded frame queue.
- Specific Lucide icons per UI action.
- Exact DSL grammar whitespace/comment tolerance details.
- Tauri plugin list beyond the named ones (`tauri-plugin-log`, `tauri-plugin-keyring`, `tauri-plugin-fs`, `tauri-plugin-dialog`, `tauri-plugin-updater`, `tauri-plugin-window-state`).

### Deferred Ideas (OUT OF SCOPE)
- Post-production effects (auto-zoom, ripples, backgrounds, transitions, overlays, mixer, presets, timeline editor) → Phase 2
- Multi-format export (WebM, GIF, resolution/FPS presets, batch) → Phase 2
- Undo/redo in post-pro → Phase 2
- Natural-language → DSL chat, LSP for DSL, AI voiceover, selector hardening, dry-run → Phase 3
- LLM/TTS API key UI → Phase 3
- Web companion → Phase 4
- Headless CLI, native-app automation, diff-aware re-recording, plugin system, differential updates, HDR, localization → Phase 5
- Opt-in telemetry → Phase 5
- macOS E2E harness (XCUITest/AppleScript) → deferred
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| FOUND-01 | Turborepo + Cargo workspace scaffolded | §Standard Stack, §Area 10 (monorepo layout) |
| FOUND-02 | Tauri v2 desktop boots mac+win with React 19 + Vite + Tailwind v4 + shadcn/ui + Base UI | §Standard Stack, §Area 6 (tauri-specta bootstrap) |
| FOUND-03 | Typed IPC via `tauri-specta` → TS bindings | §Area 6 |
| FOUND-04 | `tracing` + `tauri-plugin-log` | §Standard Stack (logging gap); STACK.md§Observability |
| FOUND-05 | Error taxonomy (`thiserror` in crates, `anyhow` at boundary); panic→UI | §Area 9 (actor pattern), STACK.md |
| FOUND-06 | rusqlite + rusqlite_migration, two-tier layout | §Standard Stack; ARCHITECTURE.md§Storage Layout |
| FOUND-07 | `tauri-plugin-keyring` scaffolded | §Standard Stack |
| FOUND-08 | GH Actions matrix mac arm64 / mac x64 / win x64 | §Area 8 |
| DSL-01..04 | pest grammar, commands, typed AST w/ spans | §Area 5 |
| DSL-05 | Two-layer parse + Levenshtein "did you mean" | §Area 5 |
| DSL-06 | Panic-mode recovery | §Area 5 |
| DSL-07 | Pure crate, CLI-ready | §Area 5, ARCHITECTURE.md |
| AUTO-01 | `BrowserDriver` trait w/ chromiumoxide + Playwright sidecar impls | §Area 4 |
| AUTO-02 | Explicit auto-waiting per verb | §Area 4 |
| AUTO-03 | Smart selector fallback chain | §Area 4 |
| AUTO-04 | viewport/theme/baseURL from `meta` block | §Area 4 |
| AUTO-05 | Failure reporting: point, selectors, screenshot | §Area 4 |
| AUTO-06 | Playwright sidecar bundled + auto-route for weak verbs | §Area 4, §Area 10 |
| CAP-01 | macOS SCK via pinned `screencapturekit` | §Area 2 |
| CAP-02 | Windows WGC via pinned `windows-capture` | §Area 3 |
| CAP-03 | xcap fallback | §Area 2, §Area 3 |
| CAP-04 | macOS TCC flow (preflight → guided → relaunch) | §Area 2 |
| CAP-05 | Zero-copy, byte-bounded queue, RAII, 30-min soak | §Area 7, PITFALLS.md§8 |
| CAP-06 | Multi-display + retina | §Area 2, §Area 3, PITFALLS.md§7 |
| CAP-07 | PTS preserved; single clock | §Area 2 (CMTime) / §Area 3 (QPC), PITFALLS.md§6 |
| ENC-01 | FFmpeg 7.x universal static sidecar | §Area 1 |
| ENC-02 | HW-encoder runtime feature detection | §Area 1 |
| ENC-03 | native frames → stdin → FFmpeg → MP4 H.264 | §Area 1, §Area 7 |
| ENC-04 | CI signed/notarized artifacts | §Area 8 |
| ENC-05 | `ffprobe` A/V alignment CI (<100ms drift on 10min) | §Area 1, §Area 8 |
| UI-01 | Dashboard | §Standard Stack (frontend); ARCHITECTURE.md§Frontend |
| UI-02 | Story Editor (CodeMirror 6 + diagnostics + selector autocomplete + resizable split) | §Area 5 (diagnostic bridge), ARCHITECTURE.md |
| UI-03 | Live browser preview + timeline panel | §Area 4 (driver preview), §Area 9 |
| UI-04 | Recording View HUD + cursor trail | §Area 9 (Channel streams) |
| UI-08 | Dark-first blended theme | D-33, STACK.md |
| UI-09 | JetBrains Mono + Lucide + motion/react | D-34, D-35 |
| UI-10 | WCAG 2.1 AA | Base UI primitives ship a11y; verify keyboard nav + focus rings per shadcn/Base UI docs |
| DIST-01 | macOS signed + notarized + hardened runtime | §Area 8 |
| DIST-02 | Windows signed (MS Trusted Signing or EV) | §Area 8 |
| DIST-03 | Tauri auto-updater (full-package) | STACK.md; PITFALLS.md§11 |
| DIST-04 | Installer size <50MB ex-FFmpeg; <2s cold start | §Area 1 (FFmpeg size reduction); perf budget audit in CI |
| DIST-05 | No telemetry; opt-in crash only | D-30, STACK.md |
</phase_requirements>

---

## Summary

Phase 1 is the spine of StoryCapture — every later phase depends on it — and it carries **three simultaneously hard risks** (FFmpeg static universal + notarization, SCK/WGC + TCC, chromiumoxide maturity). None can be deferred. Fortunately, the problem space is well-charted: static FFmpeg builds are standard practice (BtbN/ffmpeg-autobuild patterns), both SCK/WGC crates have working minimal examples, and the `BrowserDriver` trait pattern is the known escape hatch for chromiumoxide gaps.

The research below recommends **splitting Phase 1 into two concurrent sub-phases** (scaffold/DSL/CI and automation/capture/encoder) rather than one monolithic phase or a strict sequential split, because the scaffold+CI work unblocks the risky native work while running in parallel and the two streams converge cleanly at UI-03 / UI-04. See §Phase-Split Recommendation at the end.

**Primary recommendation:** Spin up a dedicated `scripts/build-ffmpeg/` CI job on day 1 that produces a universal static `ffmpeg` binary and notarizes an empty Tauri app containing it — before any other native work begins. If that CI is not green by the end of Wave 0, every other task is at risk.

---

## Standard Stack

All versions below are **what the planner should instruct plans to pin**. They are drawn from STACK.md which was version-checked on 2026-04-14. [CITED: .planning/research/STACK.md]

### Core (Phase 1 authoritative)

| Crate / Package | Version | Purpose | Confidence |
|---|---|---|---|
| `tauri` | 2.8.x | Shell | HIGH [CITED: STACK.md] |
| `tauri-specta` | latest 2.x line (verify at scaffold) | Typed IPC codegen Rust→TS | MEDIUM [CITED: chosen over `taurpc` by D-05] |
| `specta` | 2.x | `Type` derive macro | MEDIUM |
| `tauri-plugin-log` / `-keyring` / `-fs` / `-dialog` / `-updater` / `-window-state` / `-shell` / `-process` / `-single-instance` / `-os` | 2.x matched to tauri major | Official plugins | HIGH |
| `tokio` | 1.40+ (avoid 1.38/1.39: Send regression w/ chromiumoxide) | Async runtime | HIGH |
| `pest`, `pest_derive` | 2.7.x | DSL grammar | HIGH |
| `chromiumoxide` | =0.7.x exact | CDP automation | MEDIUM (pre-1.0) |
| `screencapturekit` (doom-fish) | =1.70.x exact | macOS capture | MEDIUM |
| `objc2` + `objc2-foundation` + `objc2-core-media` + `objc2-screen-capture-kit` | current | Escape hatch | HIGH |
| `windows-capture` (NiiightmareXD) | =1.5.x exact | Windows capture | HIGH |
| `windows` (windows-rs) | 0.58+ | Escape hatch | HIGH |
| `xcap` | 0.8.x | Documented fallback | MEDIUM |
| `rusqlite` (feature `bundled`) | 0.33.x | Embedded SQLite | HIGH |
| `rusqlite_migration` | 1.3.x | Migrations | HIGH |
| `thiserror` | 2.x | Crate errors | HIGH |
| `anyhow` | 1.x | Boundary errors | HIGH |
| `tracing` / `tracing-subscriber` / `tracing-log` | 0.1 / 0.3 / 0.2 | Structured logs | HIGH |
| `serde` / `serde_json` | 1.x | IPC | HIGH |
| `ts-rs` **or** `specta` (via tauri-specta) | latest | DSL AST → TS mirror types | MEDIUM (pick one; tauri-specta already brings specta, so use it for both) |

### Frontend (React 19 + Vite 6)

shadcn/ui + `@base-ui-components/react` (`base-vega` style) · `motion` (package name `motion`, import `motion/react`) · `lucide-react` · `@tanstack/react-query` 5.x · `zustand` 5.x · `@uiw/react-codemirror` 4.25+ · `@codemirror/{autocomplete,language,lint,state,view}` 6.x · `@lezer/highlight` 6.x · `tailwindcss` 4.x + `@tailwindcss/vite` · `@tauri-apps/api` 2.x · `sonner` · `cmdk` · `react-hook-form` + `zod`.

### FFmpeg sidecar (Phase 1 ENC-01..03)

- FFmpeg 7.x (7.0.x LTS-ish stable line). Build static with `--enable-static --disable-shared --pkg-config-flags=--static`, `--disable-gpl`, enable only needed codecs/encoders: VideoToolbox on mac, NVENC + QSV + AMF on win, libx264 with **`--enable-libx264` explicitly NOT set** (avoid GPL). AAC via `aac` (native) + `opus` via `libopus` optional. For Phase 1, output container `mp4`, video `h264_videotoolbox` / `h264_nvenc` / `h264_qsv` / `libopenh264` (LGPL fallback) or **no fallback → error** (see §Area 1 open question).
- Distributed under `apps/desktop/src-tauri/binaries/ffmpeg-<target-triple>` — Tauri v2 externalBin naming convention requires exactly `ffmpeg-aarch64-apple-darwin`, `ffmpeg-x86_64-apple-darwin`, `ffmpeg-x86_64-pc-windows-msvc.exe`. [CITED: v2.tauri.app/develop/sidecar/]

### Playwright sidecar (AUTO-06, D-15)

- Node.js 20.x LTS bundled (not system Node). **Recommended approach:** Node SEA (Single Executable Application, Node ≥ 20) to produce `node` bundled with `playwright-core` + a small JSON-RPC stdin/stdout server script. [CITED: nodejs.org/api/single-executable-applications.html] Alternative: `@yao-pkg/pkg` (community fork of vercel/pkg), maturity is fine in 2026 but licensing is murky for some deps.
- Playwright `playwright-core` 1.48+. `playwright install chromium` at build time to produce the browser binary; ship alongside the sidecar (adds ~150 MB — major size cost; see §Area 10).

### Alternatives Considered

| Instead of | Could Use | Why not in Phase 1 |
|---|---|---|
| pest | chumsky | Chumsky has better recovery but steeper learning curve; pest is in CONTEXT lock (D-07) |
| tauri-specta | taurpc | CONTEXT lock chose tauri-specta (D-05); taurpc is heavier and less aligned with Channel APIs |
| Node SEA for Playwright sidecar | @yao-pkg/pkg; Deno compile | SEA is officially supported by Node; pkg is a fork; Deno doesn't run playwright-core cleanly |
| Static FFmpeg | Dynamic dylibs + post-bundle signing walk | PITFALLS.md§2 — dynamic path is a known release blocker; only static sidesteps nested-dylib notarization reliably |
| ffmpeg-kit | Custom static build | ffmpeg-kit is Android/iOS-focused, abandoned for macOS in 2023 [ASSUMED — last release 2023; verify]; BtbN/FFmpeg-Builds is better for static Windows; for mac a custom build scripted is standard |

### Installation (bootstrap order)

```bash
# Day 1, Wave 0:
pnpm create tauri-app@latest
pnpm install
cargo install tauri-cli@2 cargo-edit cargo-nextest cargo-deny sccache
# Base UI + shadcn
npx shadcn@latest init  # choose base-ui, new-york/vega style
npx shadcn@latest add button card dialog tooltip tabs
# Design tokens
npx getdesign@latest add runwayml linear.app elevenlabs
```

**Version verification note:** The `npm view` / `cargo search` probes below should be run by Wave 0 tasks — treat the versions in this document as HIGH-confidence target floors, not exact pins:

```bash
cargo search chromiumoxide         # confirm 0.7.x
cargo search screencapturekit      # confirm 1.70.x
cargo search windows-capture       # confirm 1.5.x
npm view @tanstack/react-query version
npm view @uiw/react-codemirror version
```

---

## Architecture Patterns

### Recommended Project Structure (from ARCHITECTURE.md)

```
StoryCapture/
├── apps/
│   ├── desktop/
│   │   ├── src/                 # React 19 feature-sliced
│   │   │   ├── features/{dashboard,editor,recorder}/
│   │   │   ├── ipc/             # typed wrappers around generated bindings
│   │   │   └── lib/
│   │   └── src-tauri/
│   │       ├── src/
│   │       │   ├── main.rs      # thin
│   │       │   ├── commands/    # delegate to crates
│   │       │   ├── state.rs     # actor senders only
│   │       │   └── sidecars.rs  # ffmpeg + playwright spawn
│   │       ├── binaries/        # ffmpeg-<triple>, node+playwright
│   │       └── tauri.conf.json
│   └── web/                     # empty scaffold (Phase 4)
├── packages/
│   ├── shared-types/            # tauri-specta output
│   ├── story-dsl/               # CM6 lang pack + snippets + TS AST mirror
│   ├── ui/                      # shadcn + Base UI + blended tokens
│   └── config/                  # biome, tsconfig, tailwind presets
├── crates/
│   ├── story-parser/            # pure, CLI-ready
│   ├── automation/              # BrowserDriver trait + 2 impls
│   ├── capture/                 # SCK + WGC + xcap behind trait
│   ├── effects/                 # typed AST skeleton only (Phase 2 implements)
│   ├── encoder/                 # FFmpeg sidecar lifecycle
│   └── storage/                 # SQLite + project folder layout
├── scripts/
│   └── build-ffmpeg/            # universal static recipe + CI script
├── Cargo.toml                   # workspace
├── rust-toolchain.toml          # pinned
├── turbo.json
├── pnpm-workspace.yaml
└── biome.json
```

### Pattern: Actor-Style State (D-06, Area 9)

```rust
// crates/automation/src/session.rs (pure crate — no tauri)
pub enum SessionCmd {
    Start { story: Ast, reply: oneshot::Sender<Result<SessionId, SessionError>> },
    Pause { reply: oneshot::Sender<()> },
    Stop  { reply: oneshot::Sender<SessionReport> },
}

pub struct SessionActor {
    rx: mpsc::Receiver<SessionCmd>,
    driver: Box<dyn BrowserDriver>,
    capture: Box<dyn CaptureBackend>,
    encoder: EncoderHandle,
    events: mpsc::Sender<SessionEvent>, // bridged to Tauri Channel at the host
}

impl SessionActor {
    pub fn spawn(deps: SessionDeps) -> (mpsc::Sender<SessionCmd>, mpsc::Receiver<SessionEvent>) {
        let (cmd_tx, cmd_rx) = mpsc::channel(32);
        let (evt_tx, evt_rx) = mpsc::channel(256);
        tokio::spawn(Self { rx: cmd_rx, driver: deps.driver, capture: deps.capture,
                             encoder: deps.encoder, events: evt_tx }.run());
        (cmd_tx, evt_rx)
    }

    async fn run(mut self) {
        while let Some(cmd) = self.rx.recv().await {
            match cmd { /* match → drive sub-actors */ }
        }
    }
}
```

Tauri host (`apps/desktop/src-tauri/src/state.rs`) holds only `Mutex<HashMap<SessionId, mpsc::Sender<SessionCmd>>>` — never the session state itself. [CITED: ARCHITECTURE.md§Pattern 4]

### Anti-Patterns

- `Arc<Mutex<BigState>>` — locked out by D-06.
- String-concatenated FFmpeg filtergraphs — locked out by D-22/D-25 (typed AST in `crates/effects` from the start, even if only used in Phase 2).
- Frame-count-bounded queue — locked out by D-19 (byte-bounded only).
- Shell out to system `ffmpeg` — PITFALLS.md§TechDebt: never.
- Single global Chrome — PITFALLS.md§IntegrationGotchas: one BrowserContext per story.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---|---|---|---|
| FFmpeg static build | Bash-scripted `./configure` from scratch for macOS | Adapt BtbN/FFmpeg-Builds (Windows) + a mac-universal script (lipo arm64+x86_64 built separately) | Dependency graph of libopus, AAC, etc. has 20+ traps; BtbN captures them all |
| macOS notarization walk | Manual codesign loops | `tauri-apps/tauri-action` + `apple-actions/import-codesign-certs` + `notarytool submit --wait` | Well-trodden path; custom walks lose to the many edge cases documented in Tauri #8075/#11992 |
| Browser auto-waiting | Custom sleep loops between CDP commands | Playwright-style actionability: wait for element stable, visible, enabled, in-viewport, not-animating | chromiumoxide has none of this built-in; naively waiting a few ms is flaky |
| DSL error recovery | Custom panic-mode in pest | Two-phase pest: (1) lenient `command` rule matches any `IDENT ~ ARGS ~ NEWLINE`, (2) semantic walk validates verb names; skip-to-newline on error | Pest doesn't do panic-mode; the two-phase pattern IS the community pattern |
| Cursor → bitmap overlay math | Hand pixel math in rayon | Phase 2 problem — Phase 1 only captures cursor positions + timestamps into `cursor.json`; NO rendering |
| Keychain wrapping | Custom `security` shell-outs | `tauri-plugin-keyring` (OS APIs directly) | Wraps macOS Keychain / Windows Credential Manager correctly incl. ACLs |
| SQLite migrations | Ad-hoc version table | `rusqlite_migration` 1.3.x — already chosen | Solved problem |
| Node sidecar bundling | Custom extraction + PATH hacks | Node 20 SEA (first-party) | Officially supported; notarizable |
| Tauri IPC type drift | Hand-maintained TS bindings | `tauri-specta` generates both sides | One build, two languages |
| Frame PTS math | Rust-side timestamp rewriting | **Preserve** capture API PTS (CMTime / QPC) end-to-end | D-21 locked; Pitfall #6 is explicit |
| Levenshtein implementation | Custom distance fn | `strsim` crate | 20 lines saved, well-tested |
| CI signing cert import | Bash keychain-add scripts | `apple-actions/import-codesign-certs@v3` | De-facto standard for GH Actions |

**Key insight:** Every single one of Phase 1's release-blocking risks (notarization, TCC, chromiumoxide coverage, frame pipeline) has a *known* community-hardened solution. The failure mode is attempting to invent a shortcut.

---

## 1. Universal Static FFmpeg Build Recipe

**Target artifacts** (in `scripts/build-ffmpeg/out/`):
- `ffmpeg-aarch64-apple-darwin` (arm64 slice, static)
- `ffmpeg-x86_64-apple-darwin` (x86_64 slice, static)
- `ffmpeg-x86_64-pc-windows-msvc.exe` (static, MSVC-compatible runtime linkage)

On macOS, Tauri v2 externalBin expects **separate per-triple binaries** (not a lipo-fat binary), because each architecture slice is bundled next to the corresponding app slice. [CITED: v2.tauri.app/develop/sidecar/] So produce two mac binaries, not one fat file.

**Recommended build framework:**
- **macOS:** custom `scripts/build-ffmpeg/build-macos.sh` using native cross-builds (build arm64 on arm64, x86_64 on x86_64 or via cross). Do NOT use `lipo` to merge — ship per-slice.
- **Windows:** fork BtbN/FFmpeg-Builds' `build.sh` or use its prebuilt static binaries and verify codec set matches LGPL requirement. [CITED: github.com/BtbN/FFmpeg-Builds]
- Source: FFmpeg 7.0.x from `https://ffmpeg.org/releases/` (SHA256 verified in CI).

**Core configure flags (macOS, LGPL, HW encoders):**
```bash
./configure \
  --prefix=$PWD/out/$TRIPLE \
  --arch=$ARCH --target-os=darwin \
  --enable-static --disable-shared --pkg-config-flags=--static \
  --disable-gpl --disable-nonfree \
  --disable-debug --disable-doc --disable-ffplay \
  --disable-network --disable-autodetect \
  --enable-small \
  --enable-videotoolbox \
  --enable-audiotoolbox \
  --enable-encoder=h264_videotoolbox,hevc_videotoolbox,aac,pcm_s16le \
  --enable-decoder=h264,hevc,aac,pcm_s16le,rawvideo \
  --enable-parser=h264,hevc,aac \
  --enable-muxer=mp4,mov,matroska,null \
  --enable-demuxer=mov,matroska,rawvideo,aac \
  --enable-protocol=file,pipe \
  --enable-filter=scale,format,fps,setpts,asetpts,aresample,anull,null \
  --enable-bsf=h264_mp4toannexb,hevc_mp4toannexb \
  --extra-cflags="-mmacosx-version-min=11.0" \
  --extra-ldflags="-mmacosx-version-min=11.0"
```

**For Windows (MSVC-compat):** Use BtbN-style mingw-w64 cross from Linux, then `--enable-nvenc --enable-amf --enable-libmfx` (QSV requires libmfx). Verify no `.dll` dependencies in final binary with `dumpbin /DEPENDENTS ffmpeg.exe` — must only list kernel32, user32, ole32, etc.

**Size budget:** with these flags, `ffmpeg` should come in at ~35-50 MB per slice [ASSUMED — verify in Wave 0; if over 60 MB, disable more protocols/muxers]. Total mac app size ≈ 110-140 MB including both slices.

**Software fallback encoder:** `libopenh264` (BSD-licensed, LGPL-safe) is the recommended software H.264 fallback — NOT libx264 (which is GPL and would force entire FFmpeg to GPL). Add `--enable-libopenh264`. [CITED: openh264.org/faq.html — BSD-2-clause]

**Notarization proof end-to-end (MUST happen in Wave 0):**
1. Build static `ffmpeg-aarch64-apple-darwin`.
2. `codesign --force --options runtime --timestamp --sign "Developer ID Application: …" ffmpeg-aarch64-apple-darwin`.
3. Drop it into a minimal Tauri app with `tauri.conf.json` `bundle.externalBin = ["binaries/ffmpeg"]`.
4. `tauri build`, then `xcrun notarytool submit ...dmg --wait`.
5. Staple: `xcrun stapler staple StoryCapture.app` (staple the app, not the sidecar directly — sidecars inside an app inherit the app's ticket).
6. Verify on a fresh VM: `spctl -a -vv StoryCapture.app` → "accepted" + "Notarized Developer ID".

**CI script committed to `scripts/build-ffmpeg/`:** (planner should make this a Wave 0 task).

**Open questions:**
1. **Software fallback: libopenh264 vs. mpeg4 vs. hard error.** D-24 says libx264 fallback — but libx264 would pull GPL. Recommend **swap to libopenh264** in plans; mpeg4 is too low-quality. (Decision: libopenh264 is the right call; planner should flag this as a change to D-24 to user.)
2. **Bundle ffmpeg inside installer vs. first-run download.** D-44 locks "baseline plan = single installer" — accept ~130 MB total. Keep this unless a size gate blocks.
3. **Apple ARM + x86 build hosts:** CI needs both `macos-14` (arm64) and `macos-13` (x86_64) runners to build each slice natively; cross-compiling FFmpeg on a single host is painful and not recommended.

**Confidence:** MEDIUM-HIGH. The build steps above are standard practice in 2026 and have published working examples; the risk is in codec selection and the software-fallback decision, both of which are configurable.

---

## 2. macOS Screen Recording TCC Flow + `screencapturekit` Crate

**TCC flow (CAP-04):**

```rust
// crates/capture/src/macos/tcc.rs
use core_foundation::base::Boolean;
extern "C" { fn CGPreflightScreenCaptureAccess() -> Boolean; fn CGRequestScreenCaptureAccess() -> Boolean; }

pub fn preflight() -> bool { unsafe { CGPreflightScreenCaptureAccess() != 0 } }

/// Open System Settings and exit — user must relaunch (Sequoia re-prompt friendly)
pub fn request_and_relaunch_helper() -> ! {
    // 1. Ask kernel once (shows Apple dialog if never-asked)
    unsafe { CGRequestScreenCaptureAccess() };
    // 2. Open Settings pane
    std::process::Command::new("open")
        .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
        .spawn().ok();
    // 3. Relaunch self after delay (or exit + user relaunch)
    std::process::exit(0);
}
```

**UI flow (Phase 1, minimal):**
1. On app start, `preflight()` — if granted, proceed.
2. If denied: show a guided modal ("StoryCapture needs Screen Recording permission"); primary button calls `request_and_relaunch_helper()`.
3. On next launch, `preflight()` returns true; proceed normally.
4. **Sequoia 7-day re-prompt:** macOS 15+ re-prompts weekly/monthly. Detect by catching `SCStreamError::noPermission` from SCK mid-session; emit `capture:permission-revoked` event; offer the same modal.

**Stable signing identity (PITFALLS.md§1):** Every dev machine uses `codesign -s "Developer ID Application: TEAM (TEAMID)"` with the team-shared cert, not ad-hoc. Local dev certs go via `apple-actions/import-codesign-certs` analogue or a one-time `security import` from a pkcs12. If every dev uses the same bundle ID + team ID, TCC doesn't ghost-grant.

**`screencapturekit` crate minimal pipeline (MEDIUM confidence — API surface may have drifted between 1.68 and 1.70, verify in Wave 0):**

```rust
// crates/capture/src/macos/sck.rs
use screencapturekit::{
    shareable_content::SCShareableContent,
    stream::{SCStream, configuration::SCStreamConfiguration, content_filter::SCContentFilter},
    output::{sc_stream_output::{SCStreamOutput, SCStreamOutputType}, CMSampleBuffer},
};

pub struct SckCapturer {
    stream: SCStream,
    frame_tx: tokio::sync::mpsc::Sender<FrameBuf>,
}

impl SckCapturer {
    pub async fn start(display_id: u32, frame_tx: mpsc::Sender<FrameBuf>) -> Result<Self> {
        let content = SCShareableContent::get().await?;
        let display = content.displays().iter()
            .find(|d| d.display_id() == display_id)
            .ok_or(CaptureError::DisplayNotFound)?;

        let filter = SCContentFilter::new_with_display_excluding_windows(display, &[]);

        let mut cfg = SCStreamConfiguration::new();
        cfg.set_width(display.width_in_pixels() as usize);   // pixels, not points — Pitfall #7
        cfg.set_height(display.height_in_pixels() as usize);
        cfg.set_minimum_frame_interval(CMTime::new(1, 60));  // 60 fps cap
        cfg.set_shows_cursor(true);                          // Pitfall #7: off by default
        cfg.set_pixel_format(/* BGRA or NV12 */);

        let mut stream = SCStream::new(&filter, &cfg, /*delegate=*/ None);
        let output = FrameOutput { frame_tx: frame_tx.clone() };
        stream.add_output(output, SCStreamOutputType::Screen, /*queue=*/ None);
        stream.start_capture().await?;
        Ok(Self { stream, frame_tx })
    }
}

struct FrameOutput { frame_tx: mpsc::Sender<FrameBuf> }
impl SCStreamOutput for FrameOutput {
    fn did_output_sample_buffer(&self, sample_buffer: CMSampleBuffer, _of_type: SCStreamOutputType) {
        // CMSampleBuffer is IOSurface-backed; wrap in RAII and send PTS through
        let pts = sample_buffer.presentation_timestamp(); // CMTime
        let frame = FrameBuf::from_cm_sample_buffer(sample_buffer); // Arc-like
        let _ = self.frame_tx.try_send(frame.with_pts(pts));
    }
}
```

**RAII wrapper** for `CMSampleBuffer` must call `CFRelease` on drop — PITFALLS.md§8. The `screencapturekit` crate already wraps this correctly; what the planner must avoid is storing raw pointers.

**Entitlements (`Entitlements.plist`):**
```xml
<key>com.apple.security.device.camera</key><false/>
<key>com.apple.security.device.audio-input</key><false/>
<!-- Phase 3 for audio when TTS lands -->
<key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>  <!-- FFmpeg JIT filters -->
<key>com.apple.security.cs.disable-library-validation</key><false/>       <!-- static FFmpeg: keep false -->
```

**Open questions:**
1. **Crate API drift:** confirm 1.70.x public API matches the sketch above (Wave 0 probe task).
2. **Cursor exclusion** (for e.g. a "hide system cursor" mode): may need a Swift/objc2 shim if the crate doesn't expose `SCStreamConfiguration.queryDisplayMaskingOptions`. Deferred to Phase 2 (cursor overlay).
3. **Multi-display hot-plug:** subscribe to `NSApplication.didChangeScreenParametersNotification` and re-enumerate.

**Confidence:** MEDIUM (API shape likely correct; exact method names may shift).

---

## 3. Windows.Graphics.Capture via `windows-capture`

**Minimal pipeline (HIGH confidence — the NiiightmareXD crate has a well-documented README with working examples):**

```rust
// crates/capture/src/windows/wgc.rs
use windows_capture::{
    capture::{GraphicsCaptureApiHandler, Context},
    frame::Frame,
    graphics_capture_api::InternalCaptureControl,
    monitor::Monitor,
    settings::{ColorFormat, CursorCaptureSettings, DrawBorderSettings, Settings},
};

pub struct WgcCapturer { frame_tx: mpsc::Sender<FrameBuf> }

impl GraphicsCaptureApiHandler for WgcCapturer {
    type Flags = mpsc::Sender<FrameBuf>;
    type Error = Box<dyn std::error::Error + Send + Sync>;

    fn new(ctx: Context<Self::Flags>) -> Result<Self, Self::Error> {
        Ok(Self { frame_tx: ctx.flags })
    }

    fn on_frame_arrived(&mut self, frame: &mut Frame, _ctl: InternalCaptureControl) -> Result<(), Self::Error> {
        // Frame.buffer() gives access to ID3D11Texture2D; to avoid CPU round-trip,
        // prefer `frame.as_raw_surface()` path → D3D11 copy into encoder input surface.
        // Phase 1: to meet zero-copy intent without a D3D11 encoder binding, take PTS
        // and the texture handle into FrameBuf — encoder stage will copy into NV12 via
        // D3D11 shader or via MF SinkWriter at encode time.
        let pts_qpc = frame.timespan();  // QPC-based timestamp
        let buf = FrameBuf::from_wgc_frame(frame, pts_qpc);
        self.frame_tx.try_send(buf).ok();
        Ok(())
    }

    fn on_closed(&mut self) -> Result<(), Self::Error> { Ok(()) }
}

pub fn start(monitor: Monitor, frame_tx: mpsc::Sender<FrameBuf>) -> Result<()> {
    let settings = Settings::new(
        monitor,
        CursorCaptureSettings::WithCursor,
        DrawBorderSettings::Default,
        ColorFormat::Bgra8, // or Rgba16F for HDR — Phase 1 tone-map to SDR
        frame_tx,
    );
    WgcCapturer::start(settings)?;
    Ok(())
}
```

[CITED: github.com/NiiightmareXD/windows-capture — README examples]

**Graphics adapter selection:** on multi-GPU laptops (NVIDIA Optimus), WGC's default adapter may be the integrated GPU, which kills NVENC availability. Use `IDXGIFactory1::EnumAdapters1` to pick the adapter the target monitor is connected to. `windows-capture` 1.5.x may abstract this; if not, drop to raw windows-rs for adapter enumeration only. [MEDIUM confidence — verify in Wave 0].

**Retina/DPI:** Windows capture returns pixels, not DIPs, so less trap than macOS. But the Tauri window itself must set per-monitor DPI awareness (`tauri.conf.json` does this by default).

**Permission model:** WGC has no system-level opt-in prompt (unlike macOS TCC). Windows does show a yellow border around captured surfaces by default — **disable via `DrawBorderSettings::WithoutBorder`** for cinematic output.

**Cursor:** `CursorCaptureSettings::WithCursor` is correct default. For Phase 2 cursor overlay, Phase 1 captures with cursor-on and captures position separately from `GetCursorInfo`.

**Open questions:**
1. **Adapter selection API surface** in `windows-capture` 1.5 — verify vs. raw DXGI.
2. **TDR recovery** (Timeout Detection & Recovery, when the GPU driver resets) — crate may not auto-handle; plan defensive reconnection.
3. **Display hot-plug:** subscribe to `WM_DISPLAYCHANGE`; recreate capture.

**Confidence:** HIGH for the basic path; MEDIUM for multi-GPU and TDR edge cases.

---

## 4. BrowserDriver Trait — Chromiumoxide + Playwright Sidecar

**Trait shape (AUTO-01..06):**

```rust
// crates/automation/src/driver.rs
#[async_trait]
pub trait BrowserDriver: Send + Sync {
    fn capabilities(&self) -> DriverCaps;
    async fn new_context(&self, opts: ContextOpts) -> Result<ContextHandle, DriverError>;
    async fn close_context(&self, ctx: ContextHandle) -> Result<(), DriverError>;

    // Core verbs — all drivers must support
    async fn navigate(&self, ctx: ContextHandle, url: &str, wait: WaitStrategy) -> Result<(), DriverError>;
    async fn click(&self, ctx: ContextHandle, sel: &Selector) -> Result<(), DriverError>;
    async fn type_text(&self, ctx: ContextHandle, sel: &Selector, text: &str, cfg: TypeCfg) -> Result<(), DriverError>;
    async fn scroll(&self, ctx: ContextHandle, axis: Axis, amount: ScrollAmount) -> Result<(), DriverError>;
    async fn hover(&self, ctx: ContextHandle, sel: &Selector) -> Result<(), DriverError>;
    async fn drag(&self, ctx: ContextHandle, from: &Selector, to: &Selector) -> Result<(), DriverError>;
    async fn select_option(&self, ctx: ContextHandle, sel: &Selector, value: &str) -> Result<(), DriverError>;
    async fn wait(&self, ctx: ContextHandle, strat: WaitStrategy) -> Result<(), DriverError>;
    async fn assert_visible(&self, ctx: ContextHandle, sel: &Selector) -> Result<(), DriverError>;
    async fn screenshot(&self, ctx: ContextHandle, name: &str) -> Result<PathBuf, DriverError>;

    // Known-weak in chromiumoxide — the trait exposes them but
    // `capabilities().supports_upload` etc. tells the dispatcher where to route.
    async fn upload(&self, ctx: ContextHandle, sel: &Selector, paths: &[PathBuf]) -> Result<(), DriverError>;
    async fn wait_for_download(&self, ctx: ContextHandle, timeout: Duration) -> Result<PathBuf, DriverError>;

    // Side-channel for selector autocomplete (UI-02/D-38)
    async fn dom_snapshot(&self, ctx: ContextHandle) -> Result<DomSnapshot, DriverError>;
    async fn evaluate(&self, ctx: ContextHandle, js: &str) -> Result<serde_json::Value, DriverError>;
}

#[derive(Clone, Copy, Debug)]
pub struct DriverCaps {
    pub supports_upload: bool,
    pub supports_download_wait: bool,
    pub supports_shadow_pierce: bool,
    pub supports_popup_consent: bool, // OAuth
    pub supports_iframe_nav: bool,
}

pub const CHROMIUMOXIDE_CAPS: DriverCaps = DriverCaps {
    supports_upload: false,       // route to Playwright
    supports_download_wait: false,
    supports_shadow_pierce: false,
    supports_popup_consent: false,
    supports_iframe_nav: true,    // works in 0.7.x
};
pub const PLAYWRIGHT_CAPS: DriverCaps = DriverCaps { /* all true */
    supports_upload: true, supports_download_wait: true, supports_shadow_pierce: true,
    supports_popup_consent: true, supports_iframe_nav: true,
};
```

**Verb dispatcher:**

```rust
pub struct HybridDriver {
    primary: Arc<ChromiumoxideDriver>,
    fallback: Arc<PlaywrightSidecarDriver>,
}

impl HybridDriver {
    async fn route_for<'a>(&'a self, verb: VerbKind) -> &'a dyn BrowserDriver {
        let caps = self.primary.capabilities();
        let needs_fallback = match verb {
            VerbKind::Upload          => !caps.supports_upload,
            VerbKind::WaitForDownload => !caps.supports_download_wait,
            VerbKind::ShadowClick     => !caps.supports_shadow_pierce,
            VerbKind::OAuthPopup      => !caps.supports_popup_consent,
            _ => false,
        };
        if needs_fallback { &*self.fallback } else { &*self.primary }
    }
}
```

**Auto-waiting (AUTO-02, D-12):** every verb wraps a pre-condition check:
```rust
async fn wait_actionable(&self, ctx: &ContextHandle, sel: &Selector, timeout: Duration) -> Result<()> {
    // 1. wait for DOM attach
    self.wait_for(ctx, WaitStrategy::SelectorAttached(sel.clone()), timeout).await?;
    // 2. visible + in-viewport
    self.wait_for(ctx, WaitStrategy::SelectorVisible(sel.clone()), timeout).await?;
    // 3. enabled (not disabled attr, pointer-events allowed)
    self.wait_for(ctx, WaitStrategy::Enabled(sel.clone()), timeout).await?;
    // 4. stable: bounding box unchanged for 2 frames
    self.wait_for(ctx, WaitStrategy::Stable(sel.clone()), timeout).await?;
    // 5. network idle (500ms no requests) OR animation frame settled
    Ok(())
}
```

**Smart selector chain (AUTO-03, D-13):** `Selector` is an ADT:
```rust
pub enum Selector {
    Text(String),                     // "Save"
    TestId(String),                   // data-testid="save-btn"
    AriaLabel(String),                // aria-label="Save"
    Css(String),                      // button.primary
    Chain(Vec<Selector>),             // try each in order
}
```
Implementation: each driver's `click` first tries `Text` via XPath `//*[normalize-space()='Save']`, falls through to test-id, aria, then CSS. Every attempt logged with outcome for UI retry UX (AUTO-05).

**chromiumoxide 0.7.x verb reliability (MEDIUM confidence from PITFALLS.md§3):**

| Verb | chromiumoxide status | Route to Playwright? |
|---|---|---|
| navigate, click, type, scroll, hover, select | Reliable | No |
| wait-for (selector visible) | Reliable, but no built-in actionability — wrap manually | No |
| upload (file input) | **Unreliable** — `Page.setFileInputFiles` CDP call surfaces but timing-flaky | **Yes** |
| drag (mouse events) | Reliable with manual `Input.dispatchMouseEvent` | No |
| wait-for-download | **Not implemented** — needs CDP `Browser.setDownloadBehavior` coordination | **Yes** |
| shadow DOM click | **Poor** — no `piercing=` combinator; must evaluate JS to pierce | **Yes** |
| OAuth popup (new window) | **Unreliable** — Target.attachedToTarget race | **Yes** |
| iframe nav | OK with explicit frame tree walk | No |

**Playwright sidecar JSON-RPC wire format (sketch):**
```json
// Request (Rust → Node over stdin):
{"id":42,"method":"ctx.upload","params":{"ctxId":"c1","selector":{"kind":"testid","value":"file-input"},"paths":["/tmp/a.png"]}}
// Response (Node → Rust over stdout, newline-delimited):
{"id":42,"result":{"ok":true}}
// Event (push notification, e.g. download):
{"event":"download.completed","ctxId":"c1","path":"/tmp/d.pdf"}
```

Node-side server: a small Playwright wrapper script (~200 LOC) dispatches methods to `playwright-core`. Bundled via Node SEA — see §Area 10.

**Open questions:**
1. Exact chromiumoxide 0.7.x API for file upload — verify in Wave 0 spike (CONTEXT §specifics says "chromiumoxide verb-coverage spike").
2. Does Playwright sidecar need Chromium bundled separately or can it reuse chromiumoxide's browser? Recommendation: **bundle separately** — mixing could cause profile conflicts.
3. Cookie/storage isolation between sessions: `new BrowserContext` per story; never reuse.

**Confidence:** MEDIUM (trait shape HIGH; exact chromiumoxide verb-by-verb reliability is the thing to spike).

---

## 5. pest Grammar + Error Recovery

**Two-layer parse (D-08, D-09, DSL-05, DSL-06):**

**Layer 1 — lenient tokenize.** pest grammar accepts ANY `IDENT` as a command name:
```pest
// crates/story-parser/src/story.pest
WHITESPACE = _{ " " | "\t" }
COMMENT    = _{ "//" ~ (!NEWLINE ~ ANY)* }

program     = { SOI ~ (meta_block | scene_block | NEWLINE)* ~ EOI }

meta_block  = { "meta" ~ "{" ~ NEWLINE ~ meta_entry* ~ "}" ~ NEWLINE }
meta_entry  = { IDENT ~ ":" ~ value ~ NEWLINE }

scene_block = { "scene" ~ STRING ~ "{" ~ NEWLINE ~ statement* ~ "}" ~ NEWLINE }

// Lenient: ANY identifier is accepted as a command; semantic layer validates the verb name
statement   = { command | bad_line }
command     = { IDENT ~ arg* ~ NEWLINE }
arg         = { STRING | NUMBER | DURATION | IDENT }

// Panic-mode recovery: skip to next newline on unparseable input
bad_line    = { (!NEWLINE ~ ANY)+ ~ NEWLINE }

IDENT       = @{ (ASCII_ALPHA | "-") ~ (ASCII_ALPHANUMERIC | "-" | "_")* }
STRING      = @{ "\"" ~ (!"\"" ~ ANY)* ~ "\"" }
NUMBER      = @{ "-"? ~ ASCII_DIGIT+ ~ ("." ~ ASCII_DIGIT+)? }
DURATION    = @{ NUMBER ~ ("ms"|"s"|"m") }
NEWLINE     = _{ "\n" | "\r\n" }
```

**Layer 2 — semantic validation:**
```rust
// crates/story-parser/src/semantic.rs
pub const VERBS: &[&str] = &[
    "navigate","click","type","scroll","hover","drag","select","upload",
    "wait","wait-for","assert","screenshot","pause",
];

pub fn validate(ast: &Program) -> (ValidatedAst, Vec<Diagnostic>) {
    let mut diags = vec![];
    for stmt in &ast.statements {
        if let Statement::Command(cmd) = stmt {
            if !VERBS.contains(&cmd.verb.as_str()) {
                let suggestion = VERBS.iter()
                    .map(|v| (*v, strsim::levenshtein(v, &cmd.verb)))
                    .min_by_key(|(_, d)| *d)
                    .filter(|(_, d)| *d <= 2);
                diags.push(Diagnostic::unknown_verb(cmd.span, &cmd.verb, suggestion));
            }
        }
        if let Statement::BadLine(b) = stmt {
            diags.push(Diagnostic::parse_error(b.span, "Could not parse this line"));
        }
    }
    // Additional arity checks, type checks, etc.
    (build_validated_ast(ast), diags)
}
```

**Span tracking (DSL-04):** every AST node carries `Span { start_byte: u32, end_byte: u32, line: u16, col: u16 }`. pest already gives byte offsets via `Pair::as_span()`; wrap in a helper.

**Panic-mode recovery in pest:** pest does NOT have built-in panic-mode (unlike chumsky/lalrpop-err). The `bad_line` alternation above IS the community-idiomatic workaround: a catch-all rule that eats until the next statement boundary so the parser can continue. Every `bad_line` becomes a diagnostic; the parse still produces a partial AST.

**Diagnostic shape (for IPC to CodeMirror):**
```rust
#[derive(Serialize, Deserialize, Type /* specta */)]
pub struct Diagnostic {
    pub severity: Severity,         // Error | Warning | Info
    pub span: Span,
    pub message: String,
    pub code: String,               // "DSL-E001-unknown-verb"
    pub suggestion: Option<String>, // "Did you mean `click`?"
}
```

**Golden tests (D-45):** use `insta` for snapshot tests of `parse → validate` output on fixture .story files in `crates/story-parser/tests/fixtures/`.

**Pure-crate discipline (DSL-07, D-07):** `crates/story-parser/Cargo.toml` must NOT depend on `tauri`. It depends only on `pest`, `pest_derive`, `serde`, `strsim`, `thiserror`, `specta` (types only, no Tauri).

**Open questions:**
1. `meta` block keys: research names `app`, `viewport`, `theme`, `speed` (from DSL-01). Planner should confirm value grammar (e.g., viewport `1280x800` vs. `{ width: 1280, height: 800 }`).
2. Whitespace/comment tolerance (CONTEXT §Claude's Discretion): recommend Python/YAML-like — newlines are statement terminators, comments start with `//`, indentation is free.

**Confidence:** HIGH (pattern is canonical; code sketches compile-ready after minor adaptation).

---

## 6. tauri-specta Codegen + Channel Streams

**Pipeline:**

```rust
// apps/desktop/src-tauri/src/main.rs
use specta::Type;
use tauri_specta::{collect_commands, collect_events, Builder};

#[derive(Serialize, Deserialize, Type)]
pub struct StartRecordingArgs { pub story_id: Uuid }

#[tauri::command] #[specta::specta]
async fn start_recording(
    args: StartRecordingArgs,
    progress: tauri::ipc::Channel<RecordingProgress>,
    state: State<'_, AppState>,
) -> Result<SessionId, IpcError> { /* ... */ }

#[derive(Serialize, Deserialize, Type, tauri_specta::Event)]
pub struct EncodeProgress { pub session_id: SessionId, pub percent: f32 }

fn main() {
    let builder = Builder::<tauri::Wry>::new()
        .commands(collect_commands![start_recording, parse_story, list_projects /* ... */])
        .events(collect_events![EncodeProgress, CapturePermissionRevoked]);

    #[cfg(debug_assertions)]
    builder.export(
        specta_typescript::Typescript::default(),
        "../../../packages/shared-types/src/ipc.ts",
    ).expect("codegen");

    tauri::Builder::default()
        .invoke_handler(builder.invoke_handler())
        .setup(move |app| { builder.mount_events(app); Ok(()) })
        .run(tauri::generate_context!())
        .expect("error");
}
```

**Generated TS usage:**
```ts
// apps/desktop/src/ipc/commands.ts
import { commands, events } from "@shared-types/ipc";

const sessionId = await commands.startRecording({ storyId: "..." }, new Channel<RecordingProgress>(onProgress));
events.encodeProgress.listen(e => /* ... */);
```

**Codegen hook in `turbo.json`:** the `codegen` task runs `cargo check -p app-desktop-src-tauri --features=specta-export` as a dev dep of the `dev` task, so running `pnpm dev` regenerates `packages/shared-types/src/ipc.ts` before Vite picks it up. [CITED: github.com/specta-rs/tauri-specta README]

**Channels for streams (D-06):**
- Channel<T> is a one-shot stream scoped to the command invocation. For `start_recording(progress: Channel<Progress>)`, the channel is alive until the command returns — so `start_recording` returns immediately with a `SessionId` and the channel stays open for the lifetime of the session by keeping the command future running (not returning) until stop is called.
- Alternative pattern: command returns `SessionId`, then a **separate** `subscribe_progress(session_id, Channel<Progress>)` command is invoked — cleaner lifecycle. Recommended.

**Confidence:** HIGH (tauri-specta is well-documented; exact version depends on Tauri 2.8 compatibility — verify in Wave 0).

---

## 7. Zero-Copy Capture → FFmpeg Pipeline

**Goal:** avoid copying a 4K60 BGRA frame (~25 MB) into a heap Vec before handing to FFmpeg stdin.

**Reality check:** *true* zero-copy into an external FFmpeg process via stdin is **impossible** — stdin is a byte stream. The "zero-copy" goal means:

1. Do not COPY the frame from IOSurface/D3D11 into an intermediate Vec<u8>.
2. Write directly from the mapped native surface to the pipe.
3. Keep the native surface alive (RAII) until stdin.write returns.

**macOS implementation sketch:**
```rust
// crates/encoder/src/macos/stdin_pump.rs
use core_video::pixel_buffer::CVPixelBuffer;

pub async fn pump_frame(frame: FrameBuf, stdin: &mut ChildStdin) -> Result<()> {
    let pb: CVPixelBuffer = frame.into_pixel_buffer();
    pb.lock_base_address(CVPixelBufferLockFlags::READ_ONLY);
    // Borrow the raw pointer + stride; don't copy
    let ptr = pb.base_address_of_plane(0);
    let stride = pb.bytes_per_row_of_plane(0);
    let height = pb.height();
    // Write row-by-row to handle stride != width*bytes_per_pixel
    for row in 0..height {
        let slice = unsafe { std::slice::from_raw_parts(ptr.add(row * stride), stride) };
        stdin.write_all(slice).await?;
    }
    pb.unlock_base_address(CVPixelBufferLockFlags::READ_ONLY);
    Ok(())
}
```

**Windows (D3D11 texture):** `Map` the staging texture read-only, `WriteFile` per-row from the mapped pointer to the pipe, `Unmap`. Same principle.

**Byte-bounded queue (D-19, CAP-05):**
```rust
// crates/capture/src/queue.rs
pub struct ByteBoundedQueue<T: Sized> {
    tx: mpsc::UnboundedSender<(T, usize)>,
    rx: Mutex<mpsc::UnboundedReceiver<(T, usize)>>,
    bytes_in_flight: Arc<AtomicUsize>,
    cap_bytes: usize, // e.g., 256 * 1024 * 1024
    dropped_counter: Arc<AtomicU64>,
}

impl<T> ByteBoundedQueue<T> {
    pub fn try_push(&self, item: T, size: usize) -> Result<(), DropReason> {
        let current = self.bytes_in_flight.load(Ordering::Relaxed);
        if current + size > self.cap_bytes {
            self.dropped_counter.fetch_add(1, Ordering::Relaxed);
            return Err(DropReason::QueueFull);
        }
        self.bytes_in_flight.fetch_add(size, Ordering::Relaxed);
        self.tx.send((item, size)).map_err(|_| DropReason::Closed)?;
        Ok(())
    }
    // On recv, fetch_sub(size).
}
```

Emits `capture:dropped` event to UI when `dropped_counter` increments.

**30-min soak (CAP-05):** CI test runs capture at 1080p60 for 30 minutes headless, asserts `max_rss < 800 MB`. Implementable via `sysinfo` crate polling every 10s, failing if threshold exceeded.

**OSS prior art:** OBS's `obs-ffmpeg` source uses a similar pipe-based pump (C, not Rust). Screen Studio is closed-source; reverse-engineering notes from community blogs suggest they use VideoToolbox's `VTCompressionSession` directly (no FFmpeg sidecar) — an option if Phase 2 needs more perf. For Phase 1, the pipe model is adequate.

**Confidence:** HIGH on the pattern; MEDIUM on exact throughput — verify 4K60 stays <30% CPU on M-series in Wave 0 benchmark.

---

## 8. Tauri macOS Signing + Notarization CI

**End-to-end GitHub Actions workflow (`.github/workflows/release.yml`):**

```yaml
name: Release
on: { push: { tags: ["v*"] } }
jobs:
  build:
    strategy:
      matrix:
        include:
          - { os: macos-14, target: aarch64-apple-darwin }
          - { os: macos-13, target: x86_64-apple-darwin }
          - { os: windows-latest, target: x86_64-pc-windows-msvc }
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v3
      - uses: actions/setup-node@v4
        with: { node-version: "20" }
      - uses: dtolnay/rust-toolchain@stable
        with: { targets: ${{ matrix.target }} }
      - uses: Swatinem/rust-cache@v2
      - run: pnpm install --frozen-lockfile

      # Download prebuilt FFmpeg sidecar from release artifact
      - run: scripts/fetch-ffmpeg.sh ${{ matrix.target }}

      - name: Import macOS certs
        if: startsWith(matrix.os, 'macos')
        uses: apple-actions/import-codesign-certs@v3
        with:
          p12-file-base64: ${{ secrets.APPLE_CERTS_P12 }}
          p12-password: ${{ secrets.APPLE_CERTS_P12_PASSWORD }}

      - name: Sign FFmpeg sidecar before bundling
        if: startsWith(matrix.os, 'macos')
        run: |
          codesign --force --options runtime --timestamp \
            --sign "${{ secrets.APPLE_DEVID_APP_IDENTITY }}" \
            apps/desktop/src-tauri/binaries/ffmpeg-${{ matrix.target }}
          codesign --verify --verbose=2 apps/desktop/src-tauri/binaries/ffmpeg-${{ matrix.target }}

      - name: Tauri build + sign
        uses: tauri-apps/tauri-action@v0
        env:
          APPLE_ID: ${{ secrets.APPLE_ID }}
          APPLE_PASSWORD: ${{ secrets.APPLE_APP_SPECIFIC_PASSWORD }}
          APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}
          APPLE_SIGNING_IDENTITY: ${{ secrets.APPLE_DEVID_APP_IDENTITY }}
          TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_UPDATER_PRIVATE_KEY }}
          TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_UPDATER_KEY_PASSWORD }}
        with:
          args: --target ${{ matrix.target }}

      # Post-bundle safety net walk — per Tauri issue #8075 recommendation
      - name: Re-sign every Mach-O inside the bundle
        if: startsWith(matrix.os, 'macos')
        run: scripts/notarize/post-bundle-sign.sh

      - name: Notarize + staple
        if: startsWith(matrix.os, 'macos')
        run: |
          xcrun notarytool submit "target/${{ matrix.target }}/release/bundle/dmg/StoryCapture.dmg" \
            --apple-id "$APPLE_ID" --password "$APPLE_PASSWORD" --team-id "$APPLE_TEAM_ID" \
            --wait --timeout 30m
          xcrun stapler staple "target/${{ matrix.target }}/release/bundle/macos/StoryCapture.app"
          xcrun stapler validate "target/${{ matrix.target }}/release/bundle/macos/StoryCapture.app"
          spctl -a -vv "target/${{ matrix.target }}/release/bundle/macos/StoryCapture.app"

      - uses: actions/upload-artifact@v4
        with: { name: "storycapture-${{ matrix.target }}", path: "target/${{ matrix.target }}/release/bundle/" }
```

**`scripts/notarize/post-bundle-sign.sh`:**
```bash
#!/bin/bash
set -euo pipefail
APP="$1"
: "${APPLE_SIGNING_IDENTITY:?required}"

# Walk the .app, sign every Mach-O (binaries + dylibs + frameworks) with hardened runtime
find "$APP" -type f \( -name "*.dylib" -o -perm +111 \) -print0 | \
while IFS= read -r -d '' f; do
    if file "$f" | grep -q "Mach-O"; then
        codesign --force --options runtime --timestamp \
            --sign "$APPLE_SIGNING_IDENTITY" "$f" || true
    fi
done

# Re-sign outer app last (signatures must be outer-most)
codesign --force --deep --options runtime --timestamp \
    --sign "$APPLE_SIGNING_IDENTITY" \
    --entitlements apps/desktop/src-tauri/Entitlements.plist \
    "$APP"

codesign --verify --deep --strict --verbose=2 "$APP"
```

**`--deep` caveat:** Apple has deprecated `codesign --deep`. Use the walk-and-sign-inside-out pattern above, then a final outer sign WITHOUT `--deep`. [CITED: Tauri issue #8075 discussion]

**Windows signing (DIST-02):**
- **Microsoft Trusted Signing** (2024+): cheap ($10/mo), no hardware, integrates with Azure Key Vault. Use action `azure/trusted-signing-action@v0.5`. Preferred per D-42.
- **EV cert via Azure Key Vault:** action `GabrielAcostaEngler/signtool-code-sign` + `azure/login`. More expensive; no immediate SmartScreen reputation needed.
- Recommendation: **spike MS Trusted Signing** in Phase 1; if onboarding stalls, fall back to EV cert.

**Fresh-runner notarization verification:** add a `verify-install` job that runs on a freshly allocated `macos-14` runner (different from build runner), downloads the artifact, mounts the DMG, runs `spctl -a -vv StoryCapture.app` and asserts "accepted". This catches "ghost-granted on build machine" failures.

**Confidence:** HIGH on the workflow shape (publicly documented Tauri recipes); MEDIUM on some secrets wiring (specific secret names vary).

---

## 9. Actor Pattern — SessionActor w/ tokio mpsc

Referenced in §Architecture Patterns above. Full sketch:

```rust
// crates/automation/src/session.rs
pub struct SessionActor {
    cmd_rx: mpsc::Receiver<SessionCmd>,
    evt_tx: mpsc::Sender<SessionEvent>,
    parser: Arc<StoryParser>,
    driver: Arc<HybridDriver>,
    capture: Box<dyn CaptureBackend>,
    encoder: EncoderHandle,
    state: SessionState,
}

enum SessionState { Idle, Running { session_id: SessionId, step: usize }, Paused(..), Stopping }

pub enum SessionCmd {
    Start { story_src: String, reply: oneshot::Sender<Result<SessionId, SessionError>> },
    Pause { reply: oneshot::Sender<()> },
    Resume,
    Stop { reply: oneshot::Sender<SessionReport> },
}

pub enum SessionEvent {
    Started(SessionId),
    StepStarted { index: usize, verb: String },
    StepCompleted { index: usize, duration_ms: u32 },
    StepFailed { index: usize, error: StepError, screenshot: PathBuf, attempted_selectors: Vec<String> },
    CaptureFrameDropped,
    EncodeProgress { percent: f32 },
    Completed { report: SessionReport },
}

impl SessionActor {
    async fn run(mut self) {
        while let Some(cmd) = self.cmd_rx.recv().await {
            if let Err(e) = self.handle(cmd).await {
                let _ = self.evt_tx.send(SessionEvent::Failed(e)).await;
            }
        }
    }
    // handle() state-machines based on self.state
}
```

**Host wiring (`apps/desktop/src-tauri/src/state.rs`):**
```rust
pub struct AppState {
    sessions: RwLock<HashMap<SessionId, mpsc::Sender<SessionCmd>>>,
}
```

**Event bridging to Tauri Channel:**
```rust
#[tauri::command]
async fn subscribe_session(
    session_id: SessionId,
    channel: Channel<SessionEvent>,
    state: State<'_, AppState>,
) -> Result<(), IpcError> {
    let mut evt_rx = state.take_event_stream(session_id)?;
    tokio::spawn(async move {
        while let Some(evt) = evt_rx.recv().await {
            if channel.send(evt).is_err() { break; }
        }
    });
    Ok(())
}
```

**Open questions (CONTEXT §Claude's Discretion):**
- Worker threads: recommend `#[tokio::main(flavor = "multi_thread", worker_threads = 4)]` for Phase 1; adjustable.
- Channel sizes: cmd_rx cap 32 (low-frequency), evt_tx cap 256 (events can burst during step transitions).

**Confidence:** HIGH.

---

## 10. Node Sidecar Bundling for Playwright

**Recommended approach: Node 20 SEA (Single Executable Application).** Officially supported, notarizable, no third-party tooling. [CITED: nodejs.org/api/single-executable-applications.html]

**Build steps (`scripts/build-playwright-sidecar/`):**
```bash
# 1. Write a self-contained bundled server script
esbuild src/playwright-server.ts --bundle --platform=node --target=node20 \
    --outfile=dist/playwright-server.cjs

# 2. Create SEA blob
node --experimental-sea-config sea-config.json
# sea-config.json:
# {
#   "main": "dist/playwright-server.cjs",
#   "output": "dist/playwright-sidecar.blob",
#   "disableExperimentalSEAWarning": true
# }

# 3. Copy Node binary, inject blob, codesign (macOS)
cp $(command -v node) dist/playwright-sidecar
npx postject dist/playwright-sidecar NODE_SEA_BLOB dist/playwright-sidecar.blob \
    --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 \
    --macho-segment-name NODE_SEA

# 4. Rename per Tauri target triple convention
mv dist/playwright-sidecar apps/desktop/src-tauri/binaries/playwright-sidecar-$TRIPLE
```

**Playwright browser (Chromium) bundling — the size problem:**
- `playwright-core` (Node package) = ~5 MB.
- Chromium (what playwright actually drives) = **~180 MB per platform** after `playwright install chromium`.
- This blows the <50 MB installer budget (DIST-04) even excluding FFmpeg.

**Recommendation:** Playwright sidecar uses `PLAYWRIGHT_BROWSERS_PATH` env var to point at a **shared Chromium** — but in Phase 1 there's no good way to share between chromiumoxide and Playwright because they have different launch requirements.

**Options for planner to resolve:**
1. **Accept the size hit** — ship Chromium inside installer (~300 MB total). Violates D-44 budget.
2. **First-run download** — on first use of a fallback-requiring verb, download Chromium to app data dir. Delays fallback by 60-120s. Preferred.
3. **Share Chromium with chromiumoxide's browser fetcher** — both point at same binary. Requires custom logic; chromiumoxide may lock browser profile. Risky.

**Recommended: Option 2 (first-run download).** Implementation: `PlaywrightSidecarDriver::new_context` checks if Chromium is installed; if not, spawns sidecar with `playwright install chromium` first-run. Progress streamed over Channel to UI.

**Licensing (D-15):** Node.js is MIT + attribution. playwright-core is Apache 2.0. Chromium is BSD. All compatible with commercial bundling — just include LICENSE/NOTICE in the app.

**Open questions:**
1. Signing: SEA binaries on macOS need `codesign --options runtime` with `com.apple.security.cs.allow-jit` entitlement (V8 JIT). Verify notarization end-to-end in Wave 0.
2. Windows SEA signing: standard Authenticode works.
3. Alternative: **use `@yao-pkg/pkg`** if SEA has blockers — ecosystem maturity is fine in 2026 but adds a dep.

**Confidence:** MEDIUM (SEA is official but less battle-tested for Playwright specifically).

---

## Common Pitfalls (Phase 1 subset from PITFALLS.md)

Each entry cites PITFALLS.md. Planner should consume PITFALLS.md directly for full treatment; summary here:

### Pitfall 1 — SCK ghost-granted TCC
Re-stated above in §Area 2. Stable signing identity + preflight + relaunch-after-grant. [CITED: PITFALLS.md§1]

### Pitfall 2 — FFmpeg notarization
Addressed end-to-end in §Area 1 + §Area 8. Universal **static** build is the single most important mitigation. [CITED: PITFALLS.md§2]

### Pitfall 3 — chromiumoxide maturity gaps
Addressed in §Area 4: hybrid driver + capability flags. [CITED: PITFALLS.md§3]

### Pitfall 6 — A/V drift on long recordings
Preserve capture API PTS; single clock; `ffprobe` CI check. D-21 + D-26 + ENC-05. [CITED: PITFALLS.md§6]

### Pitfall 7 — Multi-display / retina / HDR
Query `backingScaleFactor`; set SCK `width/height` in pixels; HDR = tone-map to SDR BT.709 for Phase 1; explicit display picker in UI. [CITED: PITFALLS.md§7]

### Pitfall 8 — Native capture memory leaks
Zero-copy, byte-bounded, RAII, 30-min soak CI — §Area 7. [CITED: PITFALLS.md§8]

### Pitfall 9 — pest cryptic errors
Two-layer + Levenshtein + panic recovery — §Area 5. [CITED: PITFALLS.md§9]

### Pitfall 10 — Monorepo/native onboarding pain
sccache, platform-gated deps, `rust-toolchain.toml`, tri-OS PR matrix. D-03/D-04/D-40. [CITED: PITFALLS.md§10]

### Pitfall 11 — Auto-updater signing
Full-package updates only in Phase 1 (D-43); differential in Phase 5. Notarize every payload; store updater key in GitHub secret. [CITED: PITFALLS.md§11]

---

## Code Examples Cross-Reference

Working code sketches are embedded in each §Area. Minimum verifiable snippets the planner can reference when authoring plans:

- SCK capture pipeline — §Area 2
- WGC capture pipeline — §Area 3
- BrowserDriver trait — §Area 4
- pest grammar + semantic validation — §Area 5
- tauri-specta main.rs — §Area 6
- Zero-copy stdin pump — §Area 7
- Post-bundle sign script — §Area 8
- SessionActor — §Area 9
- Node SEA build — §Area 10

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `tauri-specta` has a stable 2.x compatible with tauri 2.8.x as of 2026-04 | §Area 6 | MEDIUM — may need to wire `ts-rs` as a backup |
| A2 | `screencapturekit` 1.70.x API matches the crate sketch | §Area 2 | MEDIUM — exact method names may have shifted since research date |
| A3 | `windows-capture` 1.5.x multi-GPU adapter selection works | §Area 3 | LOW — fall back to raw windows-rs if not |
| A4 | libopenh264 is an acceptable LGPL-safe software fallback (replacing the "libx264 fallback" in D-24) | §Area 1 | HIGH if wrong — would need to rethink fallback; planner should confirm with user |
| A5 | Node SEA is mature enough to ship Playwright sidecar end-to-end | §Area 10 | MEDIUM — @yao-pkg/pkg is the backup |
| A6 | ffmpeg-kit macOS support is abandoned (2023 last release) | §Alt Considered | LOW — just affects "alternatives" table |
| A7 | Tauri v2 externalBin expects per-triple sidecar binaries (not lipo fat) | §Area 1 | MEDIUM — verify against v2.tauri.app/develop/sidecar/ in Wave 0 |
| A8 | Chromium bundled with Playwright sidecar is ~180 MB per platform | §Area 10 | LOW — even if larger, first-run download strategy holds |
| A9 | macOS CI runners `macos-14` (arm64) and `macos-13` (x64) are both available for per-slice FFmpeg builds | §Area 1 | LOW — if x64 retired, use Rosetta or `cross` |

**User confirmation recommended on:** A4 (libopenh264 vs. libx264 LGPL — changes D-24).

---

## Open Questions (for plan-check / execution)

1. **Software H.264 fallback encoder**: D-24 says libx264; research recommends **libopenh264** to preserve LGPL. Needs user ratification — the change is invisible in behavior but material in licensing.
2. **Chromium distribution for Playwright sidecar**: ship-in-installer vs. first-run download. Recommendation: first-run download, progress streamed to UI. Confirm with user if install size >180 MB is tolerable; otherwise first-run.
3. **DSL `meta` block value grammar**: `viewport: 1280x800` vs. `viewport: { width: 1280, height: 800 }` — planner decides during DSL grammar plan.
4. **BrowserDriver context lifetime**: one browser instance with N contexts (isolated) vs. N browser instances. Recommendation: one browser, one context per story.
5. **HW-encoder probe mechanism**: run `ffmpeg -hide_banner -encoders` at first launch and cache, or probe on each session? Recommendation: cache in `app.sqlite` keyed by hw signature.
6. **tauri-driver on Windows E2E**: confirm it still supports Tauri 2.8; if not, defer E2E to manual on Windows too.

---

## Environment Availability

Phase 1 depends on the following — planner should add Wave 0 probe tasks:

| Dependency | Required By | Available | Version Target | Fallback |
|---|---|---|---|---|
| Rust stable | All crates | probe | 1.82+ (check `rust-toolchain.toml`) | — |
| pnpm | Monorepo | probe | 9.x | — |
| Node.js 20 LTS | Playwright sidecar build | probe | 20.x | — |
| Xcode CLT | macOS build, codesign | probe on mac | latest | — |
| Windows SDK + MSVC | win build | probe on win | 10.0.22000+ | — |
| Apple Developer Program membership | notarization | secret gate | — | No release builds until set up |
| Microsoft Trusted Signing onboarding | win signing | spike | — | EV cert; or unsigned PR builds |
| Chrome/Chromium | chromiumoxide at runtime | download on first use | latest stable | Same as Playwright — first-run |
| sccache (optional, speed) | build caching | optional | latest | Cold builds |

**Missing dependencies with no fallback:** Apple Developer cert blocks macOS release path — must be in place by first notarized build.

**Missing dependencies with fallback:** Windows signing (unsigned PR builds allowed per D-42).

---

## Phase-Split Recommendation

**Claim:** Phase 1 at 44 requirements and 10 major risks is too big for a single coherent phase but can be split cleanly along a **natural dependency seam**.

### Recommendation: **Split into Phase 1A + Phase 1B, running in overlap with a tight convergence gate.**

**Phase 1A — "Scaffold + DSL + CI + Static FFmpeg"** (covers FOUND-01..08, DSL-01..07, UI-01, UI-02 minus selector autocomplete, UI-08..10, ENC-01, DIST-01/02/04/05, partial DIST-03)

*Rationale: no native-capture risk, no browser automation risk. Unblocks everything. Produces a signed+notarized empty-but-bootable Tauri app with a working DSL parser + CodeMirror editor + working FFmpeg sidecar (provable by an end-to-end "parse then encode a black frame to MP4" smoke test).*

Wave 0 of 1A is the critical path: `scripts/build-ffmpeg/` notarization proof. Nothing else matters if this is not green.

**Phase 1B — "Automation + Capture + Encoder glue + Recording UI"** (covers AUTO-01..06, CAP-01..07, ENC-02..05, UI-03, UI-04, completes DIST-03)

*Rationale: this is the risk-heavy phase. Depends on 1A being landable (scaffolding, CI, typed IPC, FFmpeg signed). Can begin Wave 0 (spikes) in parallel with late 1A, but must not merge until 1A is green.*

**Convergence gate:** a demonstrable `.story → signed MP4` end-to-end run on both platforms. This is exactly the original Phase 1 success criterion.

### Alternative: single phase with 8-10 parallel plans

If the user prefers a single-phase structure, the planner can organize 8-10 parallel plans that mirror the split:

- P1: Monorepo scaffold + toolchain pins + Biome + sccache (Wave 0 gate)
- P2: `scripts/build-ffmpeg/` universal static recipe + CI notarization proof (Wave 0 gate, parallel to P1)
- P3: Tauri v2 shell + frontend scaffold (Base UI, tokens, routes) — depends P1
- P4: tauri-specta + codegen pipeline + IPC scaffolding — depends P3
- P5: `story-parser` crate (pest + two-layer + diagnostics + Span + TS mirror types) — depends P4
- P6: `storage` crate (rusqlite two-tier + migrations + project folder) + keyring plugin — depends P4
- P7: Story Editor UI (CodeMirror + diagnostics IPC + Dashboard) — depends P3, P5
- P8: `automation` crate (BrowserDriver trait + chromiumoxide + Playwright sidecar build) — depends P4; Wave 0 spike on verb coverage
- P9: `capture` crate (SCK + WGC + xcap + byte-bounded queue + TCC helper + 30-min soak test) — depends P4; Wave 0 spike on SCK API shape
- P10: `encoder` crate (FFmpeg sidecar lifecycle + HW-probe + zero-copy pump + ffprobe A/V CI) + Recording UI — depends P2, P9, P8

Parallelizable: P1/P2 at root, then P3..P6 concurrent, then P7..P10 concurrent. Convergence at end in a `integration` plan that glues the SessionActor and proves end-to-end.

### Planner's choice

Given CONTEXT specifies "parallelization: true" in `.planning/config.json`, **recommend the single-phase-with-10-plans approach**. The split-into-1A/1B form is cleaner on paper but adds phase-level overhead that the parallel plan structure already solves. Plan ordering + dependencies give the same convergence guarantees as a sub-phase split.

**Risk to watch:** P2 (FFmpeg notarization) MUST be complete and green before any release-relevant work merges. Treat as a Wave 0 hard gate. If P2 slips, either (a) delay all signing-dependent plans, or (b) merge P2 as an isolated spike and re-attempt next sprint.

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — project-level STACK.md is well-sourced and CONTEXT locked choices.
- Architecture: HIGH — ARCHITECTURE.md patterns are canonical Tauri v2.
- Area 1 (FFmpeg build): MEDIUM-HIGH — standard patterns, but exact configure flags need Wave 0 validation.
- Area 2 (SCK): MEDIUM — crate API may shift; sketch is plausible but not verified against 1.70.x source.
- Area 3 (WGC): HIGH — NiiightmareXD README is clear.
- Area 4 (BrowserDriver): MEDIUM — trait shape HIGH; chromiumoxide per-verb reliability requires spike.
- Area 5 (pest): HIGH — community-idiomatic pattern.
- Area 6 (tauri-specta): HIGH — well-documented.
- Area 7 (zero-copy pump): HIGH pattern, MEDIUM throughput estimate.
- Area 8 (CI signing/notarization): HIGH — recipe is publicly documented.
- Area 9 (actor): HIGH.
- Area 10 (Node SEA): MEDIUM — recent but official; @yao-pkg/pkg backup viable.
- Pitfalls: HIGH — PITFALLS.md authoritative.

**Research date:** 2026-04-14
**Valid until:** ~2026-05-14 (30 days for stable aspects; re-verify crate versions in Wave 0)

---

## Sources

### Primary (HIGH confidence)
- `.planning/PROJECT.md`, `.planning/REQUIREMENTS.md`, `.planning/STATE.md`, `.planning/ROADMAP.md` — project ground truth.
- `.planning/research/SUMMARY.md`, `STACK.md`, `ARCHITECTURE.md`, `PITFALLS.md` — project-level research synthesis.
- `.planning/phases/01-foundation-dsl-automation-capture-encode/01-CONTEXT.md` — user-locked decisions.
- Tauri v2 docs: `v2.tauri.app/develop/sidecar/`, `v2.tauri.app/distribute/sign/macos/`.
- Tauri issues #8075, #11992 — nested dylib signing, externalBin notarization.
- github.com/NiiightmareXD/windows-capture — README + examples.
- nodejs.org/api/single-executable-applications.html — SEA docs.
- openh264.org/faq.html — BSD-2 licensing.

### Secondary (MEDIUM confidence — verified via STACK.md cross-refs)
- github.com/doom-fish/screencapturekit-rs — public repo; API details to confirm at crate version pin.
- docs.rs/chromiumoxide — per-verb coverage documentation inferred from PITFALLS.md§3.
- github.com/BtbN/FFmpeg-Builds — static build reference for Windows.
- github.com/specta-rs/tauri-specta — codegen pipeline.

### Tertiary (LOW confidence — flagged in Assumptions Log)
- ffmpeg-kit macOS abandonment status (A6) — asserted; verify if used.
- Exact version floor of Microsoft Trusted Signing GH Action — verify at Wave 0.

---

*Phase 1 research complete. Ready for `/gsd-plan-phase`.*
