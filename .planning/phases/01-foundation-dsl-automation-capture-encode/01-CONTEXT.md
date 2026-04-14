# Phase 1: Foundation — DSL, Automation, Capture, Encode - Context

**Gathered:** 2026-04-14
**Status:** Ready for planning
**Mode:** auto (all gray areas auto-resolved to recommended defaults from research)

<domain>
## Phase Boundary

Deliver the end-to-end "story → signed MP4" backbone. A developer can write a `.story` file, run it through StoryCapture on macOS or Windows, drive a real browser through all core DSL verbs, capture the screen natively, encode via bundled FFmpeg with hardware acceleration, and get a playable, signed, notarized artifact — with signing/notarization CI green from the first PR.

**In scope:** monorepo scaffold, typed IPC, DSL grammar + parser + diagnostics, BrowserDriver trait with chromiumoxide + Playwright sidecar implementations, native capture (SCK/WGC + xcap fallback), FFmpeg static universal sidecar + encoder crate, SQLite two-tier persistence, OS-keychain plugin, basic editor + recorder UI shell, CI matrix + signing + notarization + auto-updater.

**Out of scope (later phases):** post-production effects (Phase 2), multi-format export beyond MP4 (Phase 2), AI/LLM features (Phase 3), web companion (Phase 4).

</domain>

<decisions>
## Implementation Decisions

### Monorepo & Build
- **D-01:** Turborepo 2.5 + pnpm + Cargo workspace with layout from research/ARCHITECTURE.md: `apps/{desktop,web}`, `packages/{shared-types,story-dsl,ui,config}`, `crates/{story-parser,automation,capture,effects,encoder,storage}`. `apps/web` scaffolded but empty (Phase 4).
- **D-02:** Linting/formatting via **Biome** single tool (not ESLint + Prettier). Rust uses `rustfmt` + `clippy`.
- **D-03:** `rust-toolchain.toml` pinned; platform-gated native deps in `Cargo.toml` (`[target.'cfg(target_os = "macos")'.dependencies]` etc.) so contributors on any OS can `cargo check` without cross-compilation pain.
- **D-04:** sccache with S3/local shared cache documented in CONTRIBUTING.md.

### Typed IPC
- **D-05:** Typed IPC codegen via **`tauri-specta`** (not `taurpc`). Emit TS bindings to `packages/shared-types/src/ipc.ts` as part of the `pnpm dev` pipeline.
- **D-06:** Three IPC mechanisms used deliberately: `#[tauri::command]` for request/response, `emit`/`listen` for broadcast status, Tauri v2 `Channel<T>` for high-frequency streams (capture frames, FFmpeg progress, cursor trail). No `Arc<Mutex<BigState>>` — state ownership via tokio mpsc actors.

### DSL Parser
- **D-07:** **pest** grammar. AST types live in `crates/story-parser` with `Span` on every node. Pure crate — no Tauri imports — so it compiles unchanged inside a future Phase 5 CLI.
- **D-08:** **Two-layer parse**: layer 1 tokenizes leniently and collects unknown tokens; layer 2 runs semantic checks and emits structured diagnostics with Levenshtein `did you mean` suggestions for misspelled verbs/keywords.
- **D-09:** Panic-mode recovery on statement boundaries so a single parse produces multiple diagnostics (not fail-fast).
- **D-10:** DSL mirror types in `packages/story-dsl` generated from the Rust AST via `ts-rs` or `specta` — single source of truth, no hand-maintained types.

### Browser Automation
- **D-11:** `BrowserDriver` trait in `crates/automation` with **two implementations from day one**: `ChromiumoxideDriver` (primary, fast, in-process) and `PlaywrightSidecarDriver` (fallback, bundled Node sidecar over JSON-RPC). Never ship "Playwright fallback later" — Playwright is wired in Phase 1.
- **D-12:** DSL executor owns explicit **auto-waiting**: every verb has a pre-condition predicate (network idle, selector visible, animation settled). Do not rely on CDP defaults.
- **D-13:** Smart selector fallback chain: visible text → `data-testid` → `aria-label` → CSS. Each attempt logged with outcome for UI retry UX.
- **D-14:** Route known-weak chromiumoxide verbs (`upload`, `wait-for-download`, shadow-DOM click, OAuth popups) to Playwright automatically via capability flags on the driver trait.
- **D-15:** Playwright sidecar is **bundled** (Node runtime packaged alongside), not reliant on the user's system Node. Licensing-compliant Node build.

### Screen Capture
- **D-16:** macOS: `screencapturekit` crate (doom-fish fork), exact version pin. Stable signing identity for dev builds (not ad-hoc) to avoid TCC "ghost granted" states.
- **D-17:** Windows: `windows-capture` crate (NiiightmareXD), not raw `windows-rs` bindings — the higher-level crate already handles frame pool + IDirect3DDevice correctly.
- **D-18:** `xcap` as documented fallback path (not primary).
- **D-19:** Zero-copy frame pipeline: native surface (`CVPixelBuffer` / `ID3D11Texture2D`) → **byte-bounded** mpsc queue (cap ~256 MB, not frame-count-bounded) → encoder. RAII wrappers enforce cleanup. Dropped-frame counter surfaced to UI.
- **D-20:** TCC/permission UX: `CGPreflightScreenCaptureAccess()` probe on launch → guided modal if denied → helper to relaunch-after-grant (handles Sequoia 7-day re-prompt). Sign every dev build with the same identity (`codesign -s "Developer ID Application: …"`).
- **D-21:** Single clock source: `CMTime` on macOS, `QueryPerformanceCounter` on Windows. Preserve capture-API PTS into the frame queue; no Rust-side timestamp rewriting.

### Encoder / FFmpeg
- **D-22:** FFmpeg **7.x built as a universal static binary** (no nested dylibs). LGPL build only — VideoToolbox / NVENC / QSV hardware encoders, no x264/x265 GPL. Recipe and CI script committed to `scripts/build-ffmpeg/`.
- **D-23:** Bundled as Tauri **externalBin sidecar**; invoked over stdin/stdout pipes; process lifecycle owned by `crates/encoder`.
- **D-24:** Runtime hardware-encoder feature detection: probe each encoder at startup, pick best available, fall back to `libopenh264` (LGPL-compatible Cisco reference encoder; Firefox/WebRTC use it) → if unavailable error out with a clear 'no available encoder' diagnostic. x264/x265 are explicitly excluded to preserve LGPL build discipline. Report selection to logs + UI.
- **D-25:** Phase 1 output is **MP4 / H.264 only** (one format, one resolution = capture-native). WebM / GIF / resolution presets are Phase 2.
- **D-26:** `ffprobe` A/V alignment CI job on a synthetic 10-minute recording — drift > 100 ms fails the build.

### Storage
- **D-27:** Two-tier SQLite via `rusqlite` (bundled) + `rusqlite_migration`: global `~/Library/Application Support/StoryCapture/app.sqlite` (projects index, app settings) + per-project `project.sqlite` inside each project folder (sessions, steps, exports, presets).
- **D-28:** Project folder is the portable unit: zip + move works. Migrations run automatically on open; version mismatch warns user before touching data.
- **D-29:** Secrets (LLM/TTS API keys added in Phase 3) via `tauri-plugin-keyring` — NOT Stronghold (deprecated). Scaffolded in Phase 1 even though no keys are used yet, so Phase 3 drops in without plumbing.

### Logging, Errors, Observability
- **D-30:** `tracing` structured logs + `tauri-plugin-log` for file rotation. Log files local only; **no telemetry by default**. Opt-in log/crash upload is a Phase 5 concern.
- **D-31:** Error taxonomy: `thiserror` in every crate (typed errors), `anyhow` only at the Tauri command boundary. Tauri panic handler catches + surfaces to UI + writes to log.

### Desktop UI (Phase 1 scope)
- **D-32:** shadcn/ui + Base UI (`base-vega` style) initialized via `npx shadcn create`. **Base UI**, not Radix — per PROJECT.md constraint. Verify `base-vega` registry compatibility with Tailwind v4 during scaffolding; fall back to a custom registry if incompatible.
- **D-33:** Dark-first theme using tokens blended from Runway (primary cinematic palette), Linear (editor/dashboard precision), ElevenLabs (timeline/waveform accents). Installed via `npx getdesign@latest add runwayml linear.app elevenlabs`. Blending rules documented in `packages/ui/README.md`.
- **D-34:** Fonts: Geist Sans for UI chrome, **JetBrains Mono** for the DSL editor and any code surfaces. Lucide icons.
- **D-35:** Motion library: **`motion/react`** (the rebrand of Framer Motion), not `framer-motion`.
- **D-36:** Phase 1 UI surfaces (only): Dashboard (UI-01), Story Editor with CodeMirror + live preview + timeline panel (UI-02, UI-03), Recording View with HUD + cursor trail (UI-04). No post-production editor, no Settings panes beyond the minimum TCC-permission helper, no NL chat.
- **D-37:** CodeMirror 6 via `@uiw/react-codemirror`. Custom DSL language pack drives syntax highlighting + diagnostics + autocomplete. **LSP wiring is deferred to Phase 3** — Phase 1 uses an in-editor diagnostics provider fed directly by the parser over IPC.
- **D-38:** Selector autocomplete: Story Editor requests live DOM snapshots from the running browser session (when preview is active) via a Tauri command, returns ranked selector candidates.
- **D-39:** State management: Zustand for local UI state (panel sizes, active tab, recording status), TanStack Query v5 for IPC cache (projects list, session state). No Redux, no Recoil.

### Distribution & CI
- **D-40:** GitHub Actions matrix: macOS arm64, macOS x64, Windows x64 — on every PR. Shared cache via `actions/cache` + sccache. Builds artifacts on push; signs + notarizes only on tagged releases (to keep PR builds fast).
- **D-41:** macOS signing: Developer ID Application + hardened runtime + Screen Recording + Accessibility entitlements. Notarization via `notarytool` in CI. Staple ticket before archiving.
- **D-42:** Windows signing: Microsoft Trusted Signing (preferred if available) or EV cert via Azure Key Vault. Decision memo deferred to a spike in Phase 1 but **does not block earlier work** — unsigned Windows builds are acceptable in PR builds.
- **D-43:** Tauri built-in auto-updater with signed update manifests. Differential updates are Phase 5; Phase 1 does full-package updates.
- **D-44:** Installer size budget: < 50 MB (excluding FFmpeg sidecar). FFmpeg sidecar is a separate downloadable asset if necessary to hit the number; baseline plan is a single installer including FFmpeg and accept the ~130 MB total if that's cleaner. Revisit if it blocks users.

### Testing
- **D-45:** `cargo test` per crate. Integration tests for `story-parser` (grammar golden tests), `automation` (against `playwright-test-server` or similar), `capture` (30-min soak memory assertion in CI, headless where possible), `encoder` (fixture-based encode + ffprobe check).
- **D-46:** Frontend: Vitest + React Testing Library for unit, `mockIPC` for Tauri commands.
- **D-47:** E2E: **WebdriverIO + `tauri-driver` on Windows only**. macOS E2E is unsupported by `tauri-driver` — do NOT attempt Playwright-on-Tauri. macOS E2E is manual for Phase 1; revisit with XCUITest/AppleScript harness later if needed.

### Claude's Discretion
- Exact tokio runtime configuration (worker-thread count, blocking-task pool size) — planner decides based on typical workload.
- Internal actor channel sizes beyond the byte-bounded frame queue — planner picks sensible defaults.
- Specific Lucide icons per UI action.
- Exact DSL grammar whitespace/comment tolerance details — parser phase plan resolves.
- Tauri plugin list beyond the named ones (`tauri-plugin-log`, `tauri-plugin-keyring`, `tauri-plugin-fs`, `tauri-plugin-dialog`, `tauri-plugin-updater`, `tauri-plugin-window-state`) — add as needs surface.

### Folded Todos

None — project just initialized.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Project-Level
- `.planning/PROJECT.md` — vision, constraints, Key Decisions (read-first)
- `.planning/REQUIREMENTS.md` — v1 requirement IDs FOUND-*, DSL-*, AUTO-*, CAP-*, ENC-*, UI-*, DIST-*
- `.planning/ROADMAP.md` — phase goals, success criteria, requirement mapping
- `.planning/research/SUMMARY.md` — synthesis; overall guidance
- `.planning/research/STACK.md` — pinned versions, "do not use" list, gap analysis
- `.planning/research/ARCHITECTURE.md` — crate boundaries, IPC patterns, SQLite schema sketch, build order
- `.planning/research/FEATURES.md` — feature landscape (Phase 1 pulls foundational capabilities only)
- `.planning/research/PITFALLS.md` — critical failure modes (Phase 1 addresses pitfalls #1, #2, #3, #4, #7, #8, #10, #11)
- `.planning/config.json` — workflow settings (coarse granularity, parallel plans, research/plan-check/verifier on)

### External (authoritative docs)
- Tauri v2 docs — sidecar (`https://v2.tauri.app/develop/sidecar/`), macOS signing (`https://v2.tauri.app/distribute/sign/macos/`), IPC + Channel, plugins
- Tauri GitHub issues #8075, #11992 — nested dylib / externalBin notarization (shape the FFmpeg-static-binary decision)
- `screencapturekit` (doom-fish) crate docs — macOS capture
- `windows-capture` (NiiightmareXD) crate docs — Windows capture
- `xcap` crate docs — fallback capture
- `chromiumoxide` docs.rs — maturity gaps inform BrowserDriver design
- Playwright docs (videos + driver lifecycle) — sidecar design
- `pest.rs` book — grammar + error recovery patterns
- shadcn/ui + Base UI docs — component initialization (`base-vega` style)
- Apple `ScreenCaptureKit` developer forums — TCC behavior on Sonoma/Sequoia
- Microsoft `Windows.Graphics.Capture` API reference

### Local (to add as encountered)
- `scripts/build-ffmpeg/` (to be created) — universal static FFmpeg recipe + CI script
- `packages/ui/README.md` (to be created) — DESIGN.md blend rules + token mapping
- `CONTRIBUTING.md` (to be created in Phase 1) — toolchain setup, sccache, platform notes

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
None — greenfield repository. Only `.planning/` artifacts exist at the start of Phase 1.

### Established Patterns
None yet. Phase 1 **establishes** patterns that Phases 2-4 will follow:
- Crate boundaries (pure-logic crates, Tauri-free except `apps/desktop/src-tauri`)
- IPC patterns (command / event / channel trichotomy)
- Typed-types codegen (`tauri-specta` Rust → TS)
- Actor-style concurrency (tokio mpsc, not Arc/Mutex for long-running ops)
- Error taxonomy (`thiserror` + `anyhow` at boundary)
- Typed filter-graph AST (introduced in Phase 2 but the shape — typed AST over strings — is a Phase 1 discipline applied later)

### Integration Points
- `apps/desktop/src-tauri/src/main.rs` — wires plugins, commands, events; otherwise thin
- `apps/desktop/src/ipc/` — generated TS bindings re-exported with helpers
- `packages/shared-types/` — codegen target for Rust → TS types
- `crates/*/Cargo.toml` — workspace members

</code_context>

<specifics>
## Specific Ideas

- **FFmpeg notarization risk is the #1 release blocker.** Build static universal binary in `scripts/build-ffmpeg/` and prove the notarization path end-to-end in Phase 1 CI, on a fresh Mac that has never seen the dev cert. Any "we'll figure it out later" here will compound catastrophically.
- **BrowserDriver trait is non-optional and not aspirational.** Both `ChromiumoxideDriver` and `PlaywrightSidecarDriver` exist from day one; the verb dispatcher picks per verb. Retrofitting the trait later means rewriting the whole automation crate.
- **TCC "ghost permissions" are the second #1 risk.** Stable signing identity for every dev build. CI step: `tccutil reset ScreenCapture` then full grant flow before the 30-min soak. Include a preflight + relaunch-after-grant helper in the Phase 1 UI.
- **Zero-copy capture pipeline with byte-bounded queue (not frame-bounded).** 4K60 BGRA = ~25 MB/frame; a "32-frame buffer" is 800 MB. Cap in bytes.
- **The filter-graph work is Phase 2, but the `effects` crate shape (typed AST, not string concatenation) is established in Phase 1** as a skeleton so Phase 2 doesn't retrofit.
- **LSP for the DSL is Phase 3.** Phase 1 ships in-editor diagnostics via direct parser IPC, not a separate LSP server. Don't premature-abstract.
- **macOS E2E is unsupported by `tauri-driver`.** Accept this; don't burn Phase 1 cycles forcing it. Windows gets WebdriverIO + `tauri-driver`; macOS gets manual QA in Phase 1.
- **Windows code signing** (Microsoft Trusted Signing vs. EV cert) is a small spike, not a blocker — unsigned PR builds are fine; decide + implement before first public release.

</specifics>

<deferred>
## Deferred Ideas

These surfaced during discussion/planning but belong elsewhere:

- **Post-production effects** (auto-zoom, cursor ripples, backgrounds, transitions, overlays, sound mixer, preset system, timeline editor) → **Phase 2**
- **Multi-format export** (WebM, GIF, resolution presets, FPS presets, batch export) → **Phase 2**
- **Undo/redo in post-pro editor** → **Phase 2**
- **Natural-language → DSL chat, LSP for DSL, AI voiceover, selector-engine hardening, dry-run mode** → **Phase 3**
- **LLM/TTS API key UI** (keychain plumbing lands in Phase 1; the UI that uses it lands in Phase 3)
- **Web companion** (Next.js app, OAuth, uploads, embeds, workspaces, analytics, marketplace, WebSocket sync) → **Phase 4**
- **Headless CLI, native-app automation, diff-aware re-recording, plugin system, differential updates, HDR pipeline, localization re-run** → **v2 / Phase 5**
- **Opt-in telemetry / crash reporting upload** → **v2 / Phase 5**
- **macOS E2E automation harness** (XCUITest / AppleScript) → deferred; manual QA for Phase 1

### Reviewed Todos (not folded)

None — no todos at project start.

</deferred>

---

*Phase: 01-foundation-dsl-automation-capture-encode*
*Context gathered: 2026-04-14 (auto mode)*
