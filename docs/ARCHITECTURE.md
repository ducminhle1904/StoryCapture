# StoryCapture — Architecture Map

Read-on-demand reference. Keep `AGENTS.md` / `CLAUDE.md` lean; load this when
touching structure, crates, IPC, or cross-layer flows.

> Deeper per-phase design notes live in `.planning/research/ARCHITECTURE.md` (658 lines) and per-phase `CONTEXT.md` under `.planning/phases/`. This doc is the fast orientation.

## Repo layout

```
apps/
  desktop/              React 19 + Vite 8 + Tauri 2.10 shell
    src/                frontend (TypeScript 6)
    src-tauri/          Tauri host (Rust) — thin IPC/plugin wiring
  web/                  Next.js 16 (Turbopack) + tRPC 11 + Prisma 6 + R2/S3

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
  ui/                   Shared tokens plus shipped `claude-design` namespace and Sc* primitives
  shared-types/         Auto-generated tauri-specta IPC types (`ipc.ts`), browser presets, generated effects AST
  story-dsl/            CodeMirror StreamLanguage + autocomplete/lint vocabularies for DSL editor
  config/               tsconfig base

scripts/
  playwright-sidecar/   Node SEA (server.mjs) — JSON-RPC 2.0 Playwright driver + element picker overlay
  build-ffmpeg/         Static universal FFmpeg 7.0.2 per-triple build (GPL libx264 + HW encoders)
  notarize/             macOS signing + notarytool flow
    smoke-app/          Standalone Tauri smoke fixture for signing/notarization validation
  benchmark/, dev/, ci/, release/  runbooks + helpers
  curate-sound-library.md, test-windows-capture.md, verb-whitelist-grep.sh, download-fonts.sh

tools/
  e2e-playwright-capture/   Rust smoke binary: WindowByPid + SCK capture verification against a live Playwright browser

.planning/              GSD artifacts (PROJECT, ROADMAP, STATE, REQUIREMENTS, phases/, quick/, research/)
assets/                 sound-library, fonts, icons
.github/workflows/      CI matrix (ci, capture-soak, capture-windows-e2e, encoder-av-drift, ffmpeg-build, release, notarize-smoke, rust-check, ...)
```

## Workspace and scripts

- pnpm workspace packages: `apps/*`, `packages/*`, and
  `scripts/playwright-sidecar`.
- Root scripts: `dev`, `build`, `lint`, `format`, `typecheck`.
- Desktop scripts: `tauri:dev` kills stale native desktop processes, rebuilds
  the Playwright sidecar SEA, then starts Tauri; `tauri:build` also rebuilds
  the sidecar first.
- Web scripts: `dev`, `build`, `start`, `typecheck`, plus Prisma helpers
  (`db:migrate`, `db:push`, `db:generate`, `db:seed`).

## Trait boundaries (the key abstractions)

| Trait | Where | Impls | Purpose |
|---|---|---|---|
| `BrowserDriver` | `crates/automation/src/driver.rs` | `PlaywrightSidecarDriver`, `NoopDriver` | Dispatch DSL verbs → browser. Capability flags (`CapabilitySet`) route per-verb fallback. |
| `CaptureBackend` | `crates/capture/src/backend.rs` | `SckBackend` (macOS), `WgcBackend` (Windows), `XcapBackend` (fallback) | Frame streaming; `pick_default_backend()` chooses, `orchestrate_start()` falls back on failure. |
| `LlmProvider` | `crates/intelligence/src/llm/mod.rs` | Anthropic, OpenAI | Streamed text+tool-use with usage/cache metrics. |
| `TtsProvider` | `crates/intelligence/src/tts/mod.rs` | ElevenLabs, OpenAI TTS | Voice synthesis + list voices; MP3 bytes. |

Plus `effects::emit::{FfmpegEmit, PreviewEmit}` emitters on `Graph` AST (not a trait, parallel static emitters).

Other important boundaries that matter in practice:

- `encoder::sidecar::SidecarCommand` + queue job execution separate FFmpeg
  process control from render orchestration.
- `storage::AppDb` and `storage::ProjectDb` split global app metadata from
  per-project state and artifacts.

## Tauri host (`apps/desktop/src-tauri`)

- **Entry:** `main.rs` shim → `lib.rs::run()` builds `tauri_specta::Builder`, wires plugins, installs panic hook, creates `AppState`, exports TS bindings in debug to `packages/shared-types/src/ipc.ts`.
- **Single source of truth for IPC:** `src/ipc_spec.rs` (collect_commands! + .typ::<T>()). All types listed there auto-become TS.
- **Commands:** module-per-feature under `src/commands/`. As of 2026-05-02,
  `ipc_spec.rs` exports 28 IPC modules, 122 commands, and 145 Specta types:
  `actions`, `app_settings`, `audio`, `author_snapshot`, `automation`,
  `capture`, `dryrun`, `encode`, `export`, `frontend_log`, `keys`, `lsp`,
  `nl`, `parse`, `picker`, `preset`, `projects`, `render`, `simulator`,
  `sound_library`, `system`, `timeline`, `trajectory`, `tts`, `updater`,
  `upload`, `web_account`, `web_sync`. The command directory also contains
  helper-only modules such as `automation_shared` and `util`.
- **Author driver registry (Phase 11):** `author_driver.rs` is the exclusive-lock state machine for author-time browser sessions (Idle / LivePreview / Picking / SimulatorRunning / SimulatorPaused). `picker_start_author`, `simulator_*`, and `attach_author_driver` all route through it; cancel is FSM-routed (commit `e13e8b5`).
- **Logging (overhauled 2026-04-23, commit `a8e78b6`):** `logging.rs` wires `tracing` + `tauri-plugin-log` to a `SizeRollingWriter` (live + numbered archives, configurable `max_files` from Settings → Logs). Per-run UUID prefix on every event via `SessionPrefixFormat`. ~95 commands wear `#[tracing::instrument(err(Debug))]`. Frontend errors flow through `log_from_frontend` IPC and an `ErrorBoundary` + global `onerror`/`unhandledrejection` hooks. All logs **local-only** — no network telemetry.
- **State:** `AppState` holds `data_dir`, `log_dir`, actor registry,
  `render_queue`, `http_client`, recording `playwright_driver`, preview
  driver/pump handles, author preview session registry, latest browser session
  profile, and the active author stream id.
- **Error boundary:** `AppError` enum (Specta-serializable) wraps domain errors per crate.
- **Plugins loaded (v2.x line):** log, fs, dialog, updater, window-state,
  shell, process, store, opener, single-instance, os. Keyring via `keyring`
  crate directly (not plugin). The host also owns the system tray wiring and a
  runtime macOS Dock icon path for dev/local builds.

## Typed IPC flow

1. Rust commands annotated `#[tauri::command] #[specta::specta]`.
2. `tauri-specta` generates `packages/shared-types/src/ipc.ts` on debug build (never hand-edit).
3. `apps/desktop/src/ipc/*.ts` wraps generated commands with TanStack Query hooks / Channel streams (e.g. `render.ts`, `upload.ts`, `automation.ts`).
4. Long-running operations use Tauri `Channel<T>` for progress (render, upload, automation events).
5. AST TS exports are split by package: story-parser exports the Story AST to
   `packages/story-dsl/src/ast.ts`; effects exports the Graph AST to
   `packages/shared-types/src/generated/effects.ts`.

### Author-preview Tauri events

Each `start_author_preview` registers two per-stream Tauri events the
webview consumes:

- `preview://frame/<streamId>` — JPEG frame stream from the CDP screencast
  (latest-wins). Payload: `PreviewFrame { data, width, height, timestamp }`.
- `preview://nav/<streamId>` — current URL + `canGoBack`/`canGoForward`
  flags pushed every time the sidecar's `framenavigated` listener fires
  or after one of the URL-bar verbs (`author_preview_back`,
  `author_preview_forward`, `author_preview_reload`). Payload:
  `AuthorPreviewNavPayload { streamId, url, canGoBack, canGoForward }`.
  History tracking lives in the sidecar (Playwright doesn't expose
  `canGoBack`/`canGoForward` directly); hash-only navigations don't emit
  `framenavigated` and therefore don't update the URL bar.

### Author-preview input forwarding

The LivePreview canvas is the input surface; the headless author browser
is the DOM target. `author_dispatch_input` carries six event variants
through `AuthorInputEvent`:

- Pointer: `mousemove`, `click`, `wheel` — coordinates in page viewport
  space (canvas → page transform happens in the renderer).
- Keyboard: `keydown`, `keyup`, `text` — `keydown`/`keyup` map to
  `page.keyboard.down/up` for raw key dispatch (modifiers, navigation,
  shortcuts), while `text` maps to `page.keyboard.insertText` and
  carries paste contents and IME-composed text in a single shot. The
  renderer suppresses the `Cmd/Ctrl + ,/q/w` whitelist so app menu
  shortcuts still escape the canvas; all other keys are
  `preventDefault()`-ed while the canvas is focused. The sidecar drops
  any keyboard variant when the picker overlay is armed
  (defense-in-depth alongside the renderer's `pickerArmed` prop).

## Frontend desktop (`apps/desktop`)

- **Routing:** React Router v7 data router in `src/routes/index.tsx`.
  `AppLayout`: `/`, `/settings`, `/post-production`.
  `FullscreenLayout`: `/onboarding`, `/editor/:projectId`,
  `/recorder/:projectId`, `/post-production/:storyId`.
- **State (Zustand 5):**
  - `features/post-production/state/store.ts` — 6-slice compound store with `persist()`: `timeline-slice`, `panels-slice`, `selection-slice`, `export-slice`, `queue-slice`, `undo-slice` (HistoryBuffer cap 50 + Coalescer 500ms, not persisted).
  - `state/projects.ts` — dashboard UI state.
  - `state/editor.ts`, `state/recorder.ts` — editor and recorder UI/session state.
  - `state/simulator-store.ts` — author-time simulator state, filmstrip scrubber, persisted hints, and "re-pick from failed step" UX (commit `1ae57bd`).
  - `state/output-prefs.ts` — shared recording/export output knobs; recording
    pacing is fixed at the 1x presentation profile.
  - `stores/upload-store.ts` — upload Channel progress.
  - `stores/web-account-store.ts`, `stores/web-sync-store.ts` — desktop ↔ web auth/sync state.
  - `features/nl-mode/nlStore.ts` — NL chat panel (streamed deltas, diff cards, 200-msg cap).
  - `features/voiceover/voiceoverStore.ts` — voiceover catalog + per-step clip map.
  - `features/editor/dryRunStore.ts` — dry-run event router.
- **Server state:** TanStack Query 5 (`ipc/query-client.ts`: staleTime 30s, refetchOnWindowFocus false, retry 1).
- **DSL editor:** `@uiw/react-codemirror` + extensions in `features/editor/codemirror-setup.ts`. Diagnostics via `parseStory` IPC with 300ms debounce. Autocomplete/lint vocab from `@storycapture/story-dsl`.
- **Editor-specific surfaces:** live preview, simulator timeline, selector
  validator overlay, author-time preview, and hybrid UI / Code authoring mode
  coexist. UI mode projects parsed `.story` scenes/commands into editable
  blocks and writes canonical DSL back to the same source buffer. Optional
  `<story>.polish.json` sidecars store recipe, zoom/callout/highlight,
  transition, cursor, and auto-zoom intent.
- **Post-production editor:** `features/post-production/editor-shell.tsx` —
  real latest recording preview + inspector + timeline. WebGPU/WebGL
  compositor in `preview/`. 5 typed layer tracks
  (video/cursor/zoom/sound/annotations) are a discriminated Clip union.
  `build-timeline-from-story.ts` auto-populates video/cursor/zoom/sound/
  annotation clips from `.story`, `.polish.json`, and recording sidecars.
  `compute-graph.ts` converts editor state into Effects Graph JSON for export.
- **UI primitives:** shadcn/ui scaffolded, backed by **Base UI** (`@base-ui-components/react`), NOT Radix. CVA-based variants. Tokens from `@storycapture/ui/tokens.css` (`@theme` block, Tailwind v4).
- **Design system package:** `@storycapture/ui` exports both shared tokens and
  the `claude-design` namespace used by the current desktop shell and 15 Sc*
  primitive families (Badge, Button, Callout, Card, EmptyState, Field, Input,
  Kbd, Segmented, Select, Skeleton, Slider, Switch, Tabs, Textarea).
- **Motion:** `motion` (Framer Motion successor), imported as `motion/react`. Shared classname helpers in `components/ui/dialog-motion.ts`.

## Web companion (`apps/web`)

- **Next.js 16 App Router** (Turbopack is the default bundler as of Next 16), src/app organized as `(auth)/`, `(dashboard)/`, public (`/`, `/watch/[slug]`, `/embed/[id]`, `/invite/[token]`), and `api/` for tRPC/auth/upload/oembed/analytics/cron.
- **tRPC 11:** `src/trpc/init.ts` — protectedProcedure gates on NextAuth session. Routers in `src/trpc/routers/`: `_app`, `video`, `workspace`, `user`, `analytics`, `template`, `sync`, `health`. Superjson transformer.
- **Prisma 6 schema (`prisma/schema.prisma`, 12 models):** Auth (`User`/`Account`/`Session`/`VerificationToken`), RBAC (`Workspace`/`WorkspaceMember`/`WorkspaceInvite`), media (`Video` with r2Key + multipart uploadId + storySource + sceneBoundaries), analytics (`ViewEvent`, `DailyVideoStats`), `Template` (9 categories), `SyncedProject` (desktop mirror).
- **Auth:** NextAuth v5 (pinned at `5.0.0-beta.31` — no newer beta on npm dist-tags) in `src/lib/auth.ts` — GitHub + Google OAuth, Prisma adapter, database session strategy, auto-creates personal workspace on first sign-in.
- **R2/S3:** `src/lib/r2.ts` — Cloudflare R2 via AWS SDK v3. Multipart via `UploadPartCommand` presigned URLs (1h expiry); `GetObjectCommand` cached 55min; PUT uses SSE-S3.
- **HTTP/API surface:** beyond tRPC, route handlers cover desktop token minting, SSE JWT minting, analytics session bootstrap, multipart upload initiate/presign/complete, oEmbed, and analytics cron aggregation.
- **GeoIP + deploy config:** `@maxmind/geoip2-node` runs as a server external package against `public/geolite2/GeoLite2-Country.mmdb`; `next.config.ts` defines security headers and R2 image patterns; `vercel.json` schedules analytics aggregation.
- **Desktop ↔ web sync:** SSE + short-lived JWT (`/api/auth/mint-sse-jwt`). Desktop→web via `sync.*` tRPC + `web_sync::*` IPC on desktop side.

## End-to-end recording flow

`.story` → Parse (`story-parser`) → Executor launches sidecar + Chromium → BrowserDriver runs verbs, SmartSelector resolves targets against `.story.targets.json` (self-healing promotes fallbacks atomically) → action/timing sidecars (`.actions.json`, `.steps.json`) written for recording runs → CaptureBackend streams frames to byte-bounded queue (256 MiB default) + best-effort cursor trajectory sidecar (`.trajectory.json`) → audio via cpal+ringbuf → EncodePipeline feeds FFmpeg sidecar stdin (recorder HW encoder chosen by `probe_encoders()`) → MP4 written to project folder → post-production builds typed timeline clips from story/polish/sidecars → computeGraph emits Effects Graph JSON → FfmpegEmit produces filter_complex for post-production render → RenderQueueActor orchestrates export fanout (MP4/WebM/GIF × resolution/quality; post-production MP4 currently encodes with CPU `libx264`) → optional upload to R2 via multipart presigned URLs → sync push to web workspace.

## Key feature gates (Cargo)

| Feature | Crate | Purpose |
|---|---|---|
| `real-capture` | capture | macOS SCK real-hardware tests + 30-min soak |
| `real-capture-windows` | capture | WGC real tests on Windows operator VM |
| `audio-mock` | capture | Synthetic 1kHz sine for CI (headless mic) |
| `real-ffmpeg` | encoder | Tests spawning real FFmpeg binary |
| `real-playwright-tests` | automation | E2E against real Playwright Chromium |
| `phase1-wired` | intelligence | Dry-run uses automation's real BrowserDriver; default builds against `trait_stub` |
| `ts-export` | story-parser, effects | Story AST exports to `packages/story-dsl/src/ast.ts`; effects AST exports to `packages/shared-types/src/generated/effects.ts` |
| `specta-types` | story-parser | Register Specta types for host IPC |
| `sqlite` | effects | Persist presets to project.sqlite |

## Platform-gated modules

- `capture::macos::{sck_backend, window, screenshot, tcc}` under `cfg(target_os = "macos")`.
- `capture::windows::{wgc_backend, frame_from_wgc, pool, thumbnail}` under `cfg(target_os = "windows")`.
- `encoder::macos::vt_writer` — AVAssetWriter zero-copy fastpath (CVPixelBuffer → MP4) via `objc2-av-foundation`.
- `capture::fallback` (xcap) always compiled cross-platform.

## Phase 16 final pinned versions (post deps-upgrade)

Rust workspace:

| Crate | Version | Notes |
|---|---|---|
| `tauri` | 2.10.3 | Plugins 2.x line |
| `tokio` | 1.52.x | rt-multi-thread, sync, macros, time, io-util, fs, process |
| `serde` / `serde_json` | 1.0.228 / 1.0.149 | Stable |
| `thiserror` | 2.0.18 | Stable |
| `anyhow` | 1.0.102 | Stable |
| `tracing` / `tracing-subscriber` | 0.1.44 / 0.3.23 | env-filter |
| `rusqlite` | 0.39 | `bundled` — unified across 4 crates (storage, encoder, effects, src-tauri) |
| `rusqlite_migration` | 2.5.0 | Stable |
| `reqwest` | 0.13 | default-features off; rustls + json (+ stream/gzip for intelligence) |
| `pest` / `pest_derive` | 2.8.6 | DSL |
| `screencapturekit` (doom-fish) | =1.5.4 | Highest 1.x on crates.io; pinned (risk flag) |
| `windows-capture` | =2.0.0 | WGC wrapper |
| `windows` (windows-rs) | 0.58 | Direct dep kept at 0.58; windows-capture pulls 0.62 transitively (benign). Bump to 0.62 deferred — needs Windows CI runner to verify WGC surface. |
| `objc2` family | 0.6 | Unified across capture + encoder in Phase 16 (prior stale comment in encoder Cargo.toml removed). |
| `xcap` | 0.9.4 | Fallback |
| `tauri-specta` | =2.0.0-rc.21 | Bump to rc.24 blocked — rc.24 requires nightly Rust (`const_type_id`, `debug_closure_helpers`). See Phase 16-05 SUMMARY. |
| `specta` | =2.0.0-rc.22 | Same nightly-MSRV blocker as tauri-specta. |
| `specta-typescript` | 0.0.9 | Bump to 0.0.11 requires specta rc.24. |

Desktop frontend:

| Package | Version |
|---|---|
| React / React-DOM | 19.2 |
| TypeScript | 6.0.3 (repo-wide; `baseUrl` removed as deprecated in TS 6) |
| Vite / `@vitejs/plugin-react` | 8.0 / 6.0 |
| Tailwind CSS | 4.x |
| Zustand | 5.0.12 |
| TanStack Query | 5.99 |
| motion | 12.38 |
| lucide-react | 1.8 |
| zod | 4.x |
| sonner | 2.0 |
| cmdk | 1.1.1 |
| react-resizable-panels | 4.x (Group/Separator/percentage-string sizes API) |
| react-hotkeys-hook | 5.x |
| tailwind-merge | 3.x |
| Biome | 2.4.12 |

Web companion:

| Package | Version |
|---|---|
| next | 16.2.4 (Turbopack default) |
| React / React-DOM | 19.2.5 |
| @prisma/client / prisma | 6.x (Prisma 7 deferred — `@auth/prisma-adapter` peerDeps still list `>=6` only) |
| next-auth | 5.0.0-beta.31 (no newer beta on npm dist-tags) |
| @auth/prisma-adapter | 2.11 |
| @trpc/* | 11.16 |
| @tanstack/react-query | 5.99 |
| @aws-sdk/client-s3 / s3-request-presigner | 3.1033+ |
| @maxmind/geoip2-node | 6.3 |
| @vercel/analytics | 2.0 |
| Tailwind CSS | 4.2 |
| zod | 4.x |
| jose | 6.2 |
| pino / pino-pretty | 10.3 / 13.1 |
| resend | 6.12 |
| client-only / server-only | bundled boundary markers |
| @storycapture/ui | workspace package |
| TypeScript | 6.0.3 |

Intentionally deferred in Phase 16 (each needs its own phase):

- **Prisma 6 → 7:** `@auth/prisma-adapter` peerDep does not list Prisma 7. Reattempt when adapter publishes Prisma 7 support.
- **windows 0.58 → 0.62:** Requires a Windows CI runner to verify WGC surface. Two versions coexist transitively today (capture crate direct 0.58; windows-capture 2.0 pulls 0.62).
- **tauri-specta rc.21 → rc.24 + specta rc.22 → rc.24 + specta-typescript 0.0.11:** The latest release of `specta` depends on unstable Rust features (`const_type_id`, `debug_closure_helpers`). Our workspace `rust-version = "1.88"` stable. Revisit when specta stabilizes or we bump MSRV to a nightly-tracking toolchain.

## References

- `docs/CONVENTIONS.md` — coding patterns, naming, testing, commit/GSD conventions.
- `docs/DOMAIN.md` — DSL grammar, targets.json, recording sidecars, Effects AST, pipeline behavior.
- `.planning/STATE.md` — current snapshot, blockers, operator gates.
- `.planning/POST-PROD-ROADMAP.md` — active post-production E2E roadmap.
- `.planning/ROADMAP.md` — historical full phase breakdown.
- `.planning/research/ARCHITECTURE.md` — long-form design doc (historical reference).
