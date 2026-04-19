# StoryCapture — Architecture Map

Read-on-demand reference. Keep CLAUDE.md lean; load this when touching structure, crates, IPC, or cross-layer flows.

> Deeper per-phase design notes live in `.planning/research/ARCHITECTURE.md` (658 lines) and per-phase `CONTEXT.md` under `.planning/phases/`. This doc is the fast orientation.

## Repo layout

```
apps/
  desktop/              React 19 + Vite 6 + Tauri 2 shell
    src/                frontend
    src-tauri/          Tauri host (Rust) — thin IPC/plugin wiring
  web/                  Next.js 15 App Router + tRPC 11 + Prisma 6 + R2/S3

crates/                 Rust workspace (pure domain crates, zero Tauri deps)
  story-parser/         pest DSL grammar + AST + formatter + suggest
  automation/           BrowserDriver trait + Playwright sidecar driver + Executor + SmartSelector + targets_store + SessionActor
  capture/              CaptureBackend trait + SCK (macOS) / WGC (Windows) / xcap fallback + byte-bounded queue + audio (cpal+ringbuf)
  encoder/              FFmpeg sidecar lifecycle + HW probe + EncodePipeline + RenderQueueActor + macOS vt_writer (AVAssetWriter)
  effects/              Typed Graph AST + GraphBuilder + FfmpegEmit + PreviewEmit + cursor/zoom/background/audio/text/math modules
  storage/              Two-tier rusqlite: AppDb (global) + ProjectDb (per-project) + migrations + .scpreset I/O
  intelligence/         LlmProvider + TtsProvider traits + NL→DSL orchestrator + tower-lsp + Dry-Run + eval_report bin
  util/                 minimal shared helpers

packages/               pnpm workspace (TS)
  ui/                   Design tokens (Tailwind v4 @theme), cream/orange warm palette; consumed by both apps
  shared-types/         Auto-generated tauri-specta TS types (`ipc.ts`) + ts-rs types for story AST & effects AST
  story-dsl/            CodeMirror StreamLanguage + autocomplete/lint vocabularies for DSL editor
  config/               tsconfig base

scripts/
  playwright-sidecar/   Node SEA (server.mjs) — JSON-RPC 2.0 Playwright driver + element picker overlay
  build-ffmpeg/         Static universal FFmpeg 7.0.2 per-triple build (LGPL set; openh264 fallback)
  notarize/             macOS signing + notarytool flow
  benchmark/, dev/, ci/, release/  runbooks + helpers
  curate-sound-library.md, test-windows-capture.md, verb-whitelist-grep.sh, download-fonts.sh

tools/
  e2e-playwright-capture/   Rust smoke binary: sidecar + capture + encode + ffprobe verify

.planning/              GSD artifacts (PROJECT, ROADMAP, STATE, REQUIREMENTS, phases/, quick/, research/)
assets/                 sound-library, fonts, icons
.github/workflows/      CI matrix (ci, capture-soak, capture-windows-e2e, encoder-av-drift, ffmpeg-build, release, notarize-smoke, rust-check, ...)
```

## Trait boundaries (the four key abstractions)

| Trait | Where | Impls | Purpose |
|---|---|---|---|
| `BrowserDriver` | `crates/automation/src/driver.rs` | `PlaywrightSidecarDriver`, `NoopDriver` | Dispatch DSL verbs → browser. Capability flags (`CapabilitySet`) route per-verb fallback. |
| `CaptureBackend` | `crates/capture/src/backend.rs` | `SckBackend` (macOS), `WgcBackend` (Windows), `XcapBackend` (fallback) | Frame streaming; `pick_default_backend()` chooses, `orchestrate_start()` falls back on failure. |
| `LlmProvider` | `crates/intelligence/src/llm/mod.rs` | Anthropic, OpenAI | Streamed text+tool-use with usage/cache metrics. |
| `TtsProvider` | `crates/intelligence/src/tts/mod.rs` | ElevenLabs, OpenAI TTS | Voice synthesis + list voices; MP3 bytes. |

Plus `effects::emit::{FfmpegEmit, PreviewEmit}` emitters on `Graph` AST (not a trait, parallel static emitters).

## Tauri host (`apps/desktop/src-tauri`)

- **Entry:** `main.rs` shim → `lib.rs::run()` builds `tauri_specta::Builder`, wires plugins, installs panic hook, creates `AppState`, exports TS bindings in debug to `packages/shared-types/src/ipc.ts`.
- **Single source of truth for IPC:** `src/ipc_spec.rs` (collect_commands! + .typ::<T>()). All types listed there auto-become TS.
- **Commands:** module-per-feature under `src/commands/` (~20 files): `system`, `automation`, `capture`, `encode`, `parse`, `projects`, `render`, `export`, `preset`, `timeline`, `sound_library`, `keys`, `dryrun`, `lsp`, `nl`, `tts`, `upload`, `web_account`, `web_sync`, `picker`, `author_snapshot`, `audio`, `region_overlay`, `app_settings`, `updater`.
- **State:** `AppState` holds `data_dir`, `log_dir`, actor registry, `render_queue`, `http_client`, `playwright_driver`.
- **Error boundary:** `AppError` enum (Specta-serializable) wraps domain errors per crate.
- **Plugins loaded (v2.x line):** log, fs, dialog, updater, window-state, shell, process, single-instance, os. Keyring via `keyring` crate directly (not plugin).

## Typed IPC flow

1. Rust commands annotated `#[tauri::command] #[specta::specta]`.
2. `tauri-specta` generates `packages/shared-types/src/ipc.ts` on debug build (never hand-edit).
3. `apps/desktop/src/ipc/*.ts` wraps generated commands with TanStack Query hooks / Channel streams (e.g. `render.ts`, `upload.ts`, `automation.ts`).
4. Long-running operations use Tauri `Channel<T>` for progress (render, upload, automation events).
5. AST types (`Story`, `Graph`) go through `ts-rs` under the `ts-export` feature, generated into `packages/shared-types/src/generated/{story,effects}.ts`.

## Frontend desktop (`apps/desktop`)

- **Routing:** React Router v7 data router in `src/routes/index.tsx`. Layouts: `AppLayout` (dashboard/settings), `FullscreenLayout` (editor/recorder/post-production), transparent overlay. Routes: `/`, `/settings`, `/editor/:projectId`, `/recorder/:projectId`, `/post-production/:storyId`, `/region-overlay`.
- **State (Zustand 5):**
  - `features/post-production/state/store.ts` — 6-slice compound store with `persist()`: `timeline-slice`, `panels-slice`, `selection-slice`, `export-slice`, `queue-slice`, `undo-slice` (HistoryBuffer cap 50 + Coalescer 500ms, not persisted).
  - `state/projects.ts` — dashboard UI state.
  - `stores/upload-store.ts` — upload Channel progress.
  - `features/nl-mode/nlStore.ts` — NL chat panel (streamed deltas, diff cards, 200-msg cap).
  - `features/voiceover/voiceoverStore.ts` — voiceover catalog + per-step clip map.
  - `features/editor/dryRunStore.ts` — dry-run event router.
- **Server state:** TanStack Query 5 (`ipc/query-client.ts`: staleTime 30s, refetchOnWindowFocus false, retry 1).
- **DSL editor:** `@uiw/react-codemirror` + extensions in `features/editor/codemirror-setup.ts`. Diagnostics via `parseStory` IPC with 300ms debounce. Autocomplete/lint vocab from `@storycapture/story-dsl`.
- **Post-production editor:** `features/post-production/editor-shell.tsx` — ResizablePanelGroup (preview | inspector) + timeline. WebGPU/WebGL compositor in `preview/gpu.ts`. 5 layer tracks (video/cursor/zoom/sound/annotations). Inspector tabs: presets / effects / sound.
- **UI primitives:** shadcn/ui scaffolded, backed by **Base UI** (`@base-ui-components/react`), NOT Radix. CVA-based variants. Tokens from `@storycapture/ui/tokens.css` (`@theme` block, Tailwind v4).
- **Motion:** `motion` (Framer Motion successor), imported as `motion/react`. Shared classname helpers in `components/ui/dialog-motion.ts`.

## Web companion (`apps/web`)

- **Next.js 15 App Router**, src/app organized as `(auth)/`, `(dashboard)/`, public (`/`, `/watch/[slug]`, `/embed/[id]`, `/invite/[token]`), and `api/` for tRPC/auth/upload/oembed/analytics/cron.
- **tRPC 11:** `src/trpc/init.ts` — protectedProcedure gates on NextAuth session. Routers in `src/trpc/routers/`: `_app`, `video`, `workspace`, `user`, `analytics`, `template`, `sync`, `health`. Superjson transformer.
- **Prisma 6 schema (`prisma/schema.prisma`, 12 models):** Auth (`User`/`Account`/`Session`/`VerificationToken`), RBAC (`Workspace`/`WorkspaceMember`/`WorkspaceInvite`), media (`Video` with r2Key + multipart uploadId + storySource + sceneBoundaries), analytics (`ViewEvent`, `DailyVideoStats`), `Template` (9 categories), `SyncedProject` (desktop mirror).
- **Auth:** NextAuth v5 (Auth.js) in `src/lib/auth.ts` — GitHub + Google OAuth, Prisma adapter, database session strategy, auto-creates personal workspace on first sign-in.
- **R2/S3:** `src/lib/r2.ts` — Cloudflare R2 via AWS SDK v3. Multipart via `UploadPartCommand` presigned URLs (1h expiry); `GetObjectCommand` cached 55min; PUT uses SSE-S3.
- **Desktop ↔ web sync:** SSE + short-lived JWT (`/api/auth/mint-sse-jwt`). Desktop→web via `sync.*` tRPC + `web_sync::*` IPC on desktop side.

## End-to-end recording flow

`.story` → Parse (`story-parser`) → Executor launches sidecar + Chromium → BrowserDriver runs verbs, SmartSelector resolves targets against `.story.targets.json` (self-healing promotes fallbacks atomically) → CaptureBackend streams frames to byte-bounded queue (256 MiB default) → audio via cpal+ringbuf → EncodePipeline feeds FFmpeg sidecar stdin (HW encoder chosen by `probe_encoders()`) → MP4 written to project folder → Effects Graph built → FfmpegEmit produces filter_complex for post-production render → RenderQueueActor orchestrates export fanout (MP4/WebM/GIF × resolution/quality) → optional upload to R2 via multipart presigned URLs → sync push to web workspace.

## Key feature gates (Cargo)

| Feature | Crate | Purpose |
|---|---|---|
| `real-capture` | capture | macOS SCK real-hardware tests + 30-min soak |
| `real-capture-windows` | capture | WGC real tests on Windows operator VM |
| `audio-mock` | capture | Synthetic 1kHz sine for CI (headless mic) |
| `real-ffmpeg` | encoder | Tests spawning real FFmpeg binary |
| `real-playwright-tests` | automation | E2E against real Playwright Chromium |
| `phase1-wired` | intelligence | Dry-run uses real BrowserDriver (avoids circular dep) |
| `ts-export` | story-parser, effects | Emit ts-rs TS types into shared-types |
| `specta-types` | story-parser | Register Specta types for host IPC |
| `sqlite` | effects | Persist presets to project.sqlite |
| `audio-mock` | capture | Headless-CI mic synth |

## Platform-gated modules

- `capture::macos::{sck_backend, window, screenshot, tcc}` under `cfg(target_os = "macos")`.
- `capture::windows::{wgc_backend, frame_from_wgc, pool, thumbnail}` under `cfg(target_os = "windows")`.
- `encoder::macos::vt_writer` — AVAssetWriter zero-copy fastpath (CVPixelBuffer → MP4) via `objc2-av-foundation`.
- `capture::fallback` (xcap) always compiled cross-platform.

## References

- `docs/CONVENTIONS.md` — coding patterns, naming, testing, commit/GSD conventions.
- `docs/DOMAIN.md` — DSL grammar, targets.json, Effects AST, phase roadmap status.
- `.planning/STATE.md` — current phase/plan position, blockers, operator gates.
- `.planning/ROADMAP.md` — full phase breakdown.
- `.planning/research/ARCHITECTURE.md` — long-form design doc (historical reference).
