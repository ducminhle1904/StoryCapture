# Architecture Research — StoryCapture

**Domain:** Tauri v2 desktop app + Next.js web companion, Turborepo monorepo (TS + Rust)
**Researched:** 2026-04-14
**Confidence:** HIGH (validates/refines proposed PROJECT.md layout against standard Tauri v2 patterns)

## Standard Architecture

### System Overview

```
┌──────────────────────────────────────────────────────────────────────────┐
│                       apps/desktop (Tauri v2 shell)                       │
│                                                                            │
│  ┌────────────────────── Frontend (WebView) ──────────────────────────┐  │
│  │  React 19 + Vite + Tailwind v4 + shadcn/ui + Base UI               │  │
│  │  Zustand (session) · TanStack Query (IPC cache) · Framer Motion    │  │
│  │                                                                      │  │
│  │  Views: StoryEditor · Recorder · PostPro · Exporter · Projects      │  │
│  └──────────┬───────────────────────────────────────┬──────────────────┘  │
│             │ invoke() (commands, req/resp)          │ listen() (events)   │
│             ▼                                         ▲                    │
│  ┌────────────────────── Rust Core (tokio) ──────────────────────────┐   │
│  │  ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌─────────────┐    │   │
│  │  │ story-     │ │ automation │ │  capture   │ │  effects    │    │   │
│  │  │ parser     │→│ (CDP)      │→│ (SCK/WGC)  │→│ (post-pro)  │    │   │
│  │  │ (pest)     │ │chromiumoxide│ │  frames    │ │ overlays    │    │   │
│  │  └────────────┘ └────────────┘ └──────┬─────┘ └──────┬──────┘    │   │
│  │                                       │              │            │   │
│  │  ┌───────────── Orchestrator / Executor ─────────────┐            │   │
│  │  │  Session state · step runner · event bus          │            │   │
│  │  └─────────┬────────────────────────────────┬────────┘            │   │
│  │            │                                │                      │   │
│  │  ┌─────────▼───────┐              ┌─────────▼──────────┐          │   │
│  │  │  storage        │              │  secrets           │          │   │
│  │  │  (rusqlite,fs)  │              │  (keyring-rs/OS KC)│          │   │
│  │  └─────────────────┘              └────────────────────┘          │   │
│  └──────────┬──────────────────────────────────┬──────────────────────┘  │
│             │ Sidecar (stdin/stdout pipes)     │ Sidecar (JSON-RPC)       │
│             ▼                                   ▼                          │
│  ┌─────────────────────┐               ┌─────────────────────┐            │
│  │   FFmpeg sidecar    │               │ Playwright sidecar  │            │
│  │  (HW-accel encode)  │               │ (fallback driver)   │            │
│  └─────────────────────┘               └─────────────────────┘            │
└───────────────────────────────────┬──────────────────────────────────────┘
                                    │ WebSocket (optional, authed)
                                    ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                   apps/web (Next.js 15 App Router)                        │
│   tRPC · NextAuth · Prisma + Postgres · S3/R2 upload · share/embed       │
└──────────────────────────────────────────────────────────────────────────┘
```

### Component Responsibilities

**Rust crates** (`crates/*` — workspace members, each a library crate):

| Crate | Responsibility | Owns |
|-------|----------------|------|
| `story-parser` | Parse `.story` DSL → typed AST; validate; emit diagnostics | `pest.rs` grammar, AST types, serde (→ TS via ts-rs) |
| `automation` | Drive a real browser via CDP; smart selector resolution; step execution | `chromiumoxide`, selector fallback chain, retry policy |
| `capture` | Platform-native frame capture + cursor/event tracking | `ScreenCaptureKit` (objc2), `Windows.Graphics.Capture` (windows-rs), XCap fallback |
| `effects` | Post-production primitives: auto-zoom keyframes, cursor overlay math, transition graph | Pure logic + FFmpeg filtergraph builders |
| `storage` *(new)* | SQLite + filesystem project layout; migrations | `rusqlite`, project-folder conventions |
| `encoder` *(new, optional split from `effects`)* | Spawn + manage FFmpeg sidecar; muxing, HW-accel negotiation | Sidecar process, progress parsing |

**Tauri desktop app** (`apps/desktop`):
- Thin "host" crate (`src-tauri/`) that wires crates together, defines Tauri commands/events, manages app state, and hosts the WebView.
- Frontend in `apps/desktop/src/` consumes commands/events only (no direct FS/network — goes through Rust).

**TS packages** (`packages/*`):

| Package | Responsibility |
|---------|---------------|
| `shared-types` | Generated types from Rust (ts-rs or specta) — AST, events, IPC payloads |
| `story-dsl` | DSL-adjacent TS utilities: syntax highlighting grammar (CodeMirror 6 lang), formatter, snippet library |
| `ui` | Cross-app design system: shadcn/ui + Base UI primitives, tokens, DESIGN.md-derived components |
| `config` | Shared ESLint, TS, Tailwind, Prettier config |

**Web companion** (`apps/web`): Next.js 15, tRPC, Prisma — consumes `shared-types` and `ui`, no direct Rust dependency. Communicates with desktop via authenticated WebSocket (optional feature).

### Ownership & Boundaries (validation of PROJECT.md)

PROJECT.md layout is sound. **Refinements:**

1. Split a `storage` crate out of the Tauri host — SQLite schema + project-folder layout benefits from unit tests without a Tauri context.
2. Optionally split `encoder` (FFmpeg sidecar manager) from `effects` — `effects` becomes pure math/filter-graph builders, `encoder` owns process lifecycle. Keeps `effects` testable without spawning processes.
3. Add a `packages/dsl-lang` or fold into `story-dsl`: CodeMirror 6 language definition lives in TS, not Rust (the Rust parser is the source of truth; TS gets a lighter lexer for highlighting only).
4. Keep the Tauri host crate (`apps/desktop/src-tauri/`) thin — it's the only place that depends on `tauri`; all business logic stays in pure crates so they're reusable by a future headless CLI (Phase 5).

## Recommended Project Structure

```
StoryCapture/
├── apps/
│   ├── desktop/                      # Tauri v2 desktop app
│   │   ├── src/                      # React 19 + Vite frontend
│   │   │   ├── features/             # Feature-sliced: editor, recorder, postpro, exporter, projects
│   │   │   │   └── <feature>/
│   │   │   │       ├── components/
│   │   │   │       ├── hooks/        # useInvoke, useEvent wrappers around Tauri
│   │   │   │       └── state/        # Zustand slices
│   │   │   ├── ipc/                  # Thin typed wrappers: commands.ts, events.ts, channels.ts
│   │   │   ├── lib/                  # utils, query client, theme
│   │   │   └── routes/               # Router entry points
│   │   ├── src-tauri/                # Rust host crate (thin)
│   │   │   ├── src/
│   │   │   │   ├── main.rs
│   │   │   │   ├── commands/         # #[tauri::command] handlers — delegate to crates
│   │   │   │   ├── events.rs         # Event emitter helpers (typed)
│   │   │   │   ├── state.rs          # AppState (Arc<Mutex<…>> / actors)
│   │   │   │   └── sidecars.rs       # FFmpeg / Playwright sidecar management
│   │   │   ├── tauri.conf.json
│   │   │   ├── capabilities/         # Tauri v2 permission model
│   │   │   └── binaries/             # Bundled sidecars (ffmpeg, optional node+playwright)
│   │   └── package.json
│   └── web/                          # Next.js 15 companion
│       ├── app/                      # App Router
│       ├── server/                   # tRPC routers
│       ├── prisma/
│       └── lib/
├── packages/
│   ├── shared-types/                 # Rust-generated TS types (ts-rs or specta)
│   │   └── src/generated/            # build output, git-ignored or committed per policy
│   ├── story-dsl/                    # CodeMirror 6 language, formatter, snippets
│   ├── ui/                           # Design system (shadcn/ui + Base UI)
│   └── config/                       # eslint, tsconfig, tailwind, prettier presets
├── crates/                           # Rust workspace members (pure libraries)
│   ├── story-parser/
│   ├── automation/
│   ├── capture/
│   ├── effects/
│   ├── encoder/                      # (new) FFmpeg sidecar manager
│   └── storage/                      # (new) SQLite + project-folder layout
├── Cargo.toml                        # Rust workspace root
├── turbo.json
├── pnpm-workspace.yaml
└── package.json
```

### Structure Rationale

- **apps/ vs packages/ vs crates/:** Apps are deployables (Tauri bundle, Next.js site). Packages are shared TS libraries. Crates are shared Rust libraries — crate separation enables a future headless CLI (reuse `story-parser` + `automation` + `capture` + `encoder`) without pulling `tauri`.
- **Thin src-tauri/:** The host crate only wires commands and manages state. All logic lives in pure crates with unit tests that don't need Tauri's runtime.
- **ipc/ folder in frontend:** Single place for typed `invoke`/`listen` wrappers. Eliminates raw `invoke('...')` strings scattered across components; enables TanStack Query integration.
- **Feature-sliced frontend:** Each major view (editor, recorder, postpro, exporter, projects) owns its components, state, and hooks. Matches the vertical slices users experience.
- **shared-types generated, not hand-written:** `ts-rs` or `tauri-specta` emit TS from Rust — single source of truth for AST, event payloads, command args.

## Architectural Patterns

### Pattern 1: Tauri Commands for Request/Response, Events for Push

**What:** Use `#[tauri::command]` for synchronous-ish request/response (e.g., `parse_story`, `list_projects`, `start_recording`). Use `app.emit()` / `WebviewWindow::emit()` for progress updates, log streaming, and long-running task status.

**When:** Commands for anything the UI asks for and awaits. Events for anything the backend pushes (step progress, capture FPS, encode progress, automation logs).

**Trade-offs:** Commands serialize over IPC — keep payloads small. Events are fire-and-forget — UI must handle missed events on reconnect (rare in desktop, but possible after reload).

**Example:**
```rust
// Request/response
#[tauri::command]
async fn start_recording(app: AppHandle, story_id: Uuid, state: State<'_, AppState>)
    -> Result<SessionId, IpcError> { … }

// Push progress
app.emit("recording:progress", ProgressPayload { session_id, step: 3, total: 12 })?;
```

```ts
// frontend/ipc/commands.ts
export const startRecording = (storyId: string) =>
  invoke<SessionId>('start_recording', { storyId });

// frontend/ipc/events.ts
export const onRecordingProgress = (cb: (p: ProgressPayload) => void) =>
  listen<ProgressPayload>('recording:progress', e => cb(e.payload));
```

### Pattern 2: Tauri v2 Channels for High-Frequency Streams

**What:** Tauri v2 introduced typed `Channel<T>` — a one-shot stream from Rust to the webview, passed as a command argument. Use it for frame previews, stdout tails, or per-frame automation status where Event bus volume would be wasteful.

**When:** >10 messages/sec to a specific UI subscriber (e.g., live preview thumbnails during recording, FFmpeg encode progress lines).

**Trade-offs:** Channel is scoped to the command invocation — tear-down is automatic when the command returns. Cannot be re-subscribed; events are better for broadcast.

**Example:**
```rust
#[tauri::command]
async fn stream_preview(channel: Channel<PreviewFrame>, session: SessionId) -> Result<(), IpcError> {
    while let Some(frame) = capture.recv().await {
        channel.send(PreviewFrame { ts: frame.ts, jpeg: frame.jpeg })?;
    }
    Ok(())
}
```

### Pattern 3: Sidecar Processes via stdin/stdout Pipes

**What:** Bundle FFmpeg (and optionally a Node+Playwright) as Tauri v2 sidecars. Communicate via stdin (raw frame bytes) / stdout (progress, JSON-RPC). Never shell out to a system binary.

**When:**
- **FFmpeg:** Always. Pipe raw BGRA/NV12 frames from `capture` to FFmpeg stdin; parse stderr progress lines for the UI.
- **Playwright:** Only if `chromiumoxide` can't drive a specific feature (e.g., extension contexts, trace viewer). JSON-RPC over stdin/stdout.

**Trade-offs:** Sidecar bundling bloats the installer (FFmpeg ≈ 30-70 MB depending on build). macOS notarization requires signing the sidecar binary explicitly. Benefit: deterministic environment, no user-installed FFmpeg surprises.

**Example:**
```rust
// crates/encoder/src/ffmpeg.rs
let (mut rx, mut child) = Command::new_sidecar("ffmpeg")?
    .args(["-f","rawvideo","-pix_fmt","bgra","-s","1920x1080","-r","60",
           "-i","pipe:0","-c:v","h264_videotoolbox","-b:v","12M", &out_path])
    .spawn()?;
let mut stdin = child.stdin().take().unwrap();
tokio::spawn(async move {
    while let Some(frame) = frames.recv().await {
        stdin.write_all(&frame.bytes).await?;
    }
});
while let Some(event) = rx.recv().await {
    if let CommandEvent::Stderr(line) = event {
        app.emit("encode:progress", parse_ffmpeg_progress(&line))?;
    }
}
```

### Pattern 4: Actor-Style State with tokio Tasks + mpsc

**What:** Long-running components (session orchestrator, capture pipeline, encoder) are tokio tasks that own their state and accept commands on `mpsc::Receiver`. Tauri commands send messages into these actors instead of locking shared state.

**When:** Any component that coordinates multiple async sub-operations (recording session = parser + automation + capture + encoder in lockstep).

**Trade-offs:** More code than `Arc<Mutex<T>>` for simple state. Much safer for concurrent access and easier to reason about than nested locks.

**Example:**
```rust
pub struct SessionActor { rx: mpsc::Receiver<SessionCmd>, /* … */ }
impl SessionActor {
    pub async fn run(mut self) {
        while let Some(cmd) = self.rx.recv().await {
            match cmd {
                SessionCmd::Start { story, reply } => { /* … */ }
                SessionCmd::Pause => { /* … */ }
                SessionCmd::Stop { reply } => { /* … */ }
            }
        }
    }
}
// AppState holds only mpsc::Sender<SessionCmd>
```

### Pattern 5: Typed IPC via `tauri-specta` / `ts-rs`

**What:** Derive TS types from Rust structs at build time. Generated types live in `packages/shared-types`. Frontend's `ipc/commands.ts` wraps `invoke` with correct types.

**When:** Always. Hand-written duplicate type definitions drift within a week.

**Trade-offs:** Adds a codegen step to `turbo dev`. Upside: compiler catches IPC payload mismatches.

### Pattern 6: Pure-Logic Crates, Host-Wires-Everything

**What:** `story-parser`, `automation`, `capture`, `effects`, `encoder`, `storage` crates contain zero Tauri imports. `apps/desktop/src-tauri` imports them and exposes thin Tauri commands. This makes every crate unit-testable with `cargo test` and reusable for a future headless CLI.

**When:** Always for this project — stated roadmap explicitly includes a CLI in Phase 5.

## Data Flow

### Top-Level Flow: Story → Video

```
┌────────────┐
│ .story file│ (CodeMirror 6 buffer in editor, or file on disk)
└─────┬──────┘
      ▼ fs::read / in-memory string
┌─────────────────────┐
│ story-parser (pest) │  produces typed AST + diagnostics
└─────┬───────────────┘
      ▼ Ast<Scene>, Vec<Diagnostic>
┌─────────────────────┐
│ executor (host)     │  walks AST, calls automation per step
└─────┬───────────────┘
      ▼ Step commands
┌─────────────────────┐       ┌─────────────────────┐
│ automation (CDP)    │──────▶│ real Chromium       │
│ chromiumoxide       │◀──────│ (DOM events)        │
└─────┬───────────────┘       └─────────────────────┘
      │ step events, cursor positions, timing marks
      ▼
┌─────────────────────┐       ┌─────────────────────┐
│ capture (SCK/WGC)   │──────▶│ platform GPU        │
│ raw frames (NV12/   │◀──────│ surface             │
│ BGRA) + cursor meta │       └─────────────────────┘
└─────┬───────────────┘
      │ frame stream (mpsc<Frame>)
      ▼
┌─────────────────────┐
│ encoder (FFmpeg     │  pipes raw frames → H.264/H.265
│ sidecar, HW-accel)  │
└─────┬───────────────┘
      │ .mp4 (raw recording)
      ▼
┌─────────────────────┐
│ effects + encoder   │  auto-zoom, cursor overlay, xfade,
│ post-pro pass       │  backgrounds, TTS mux
└─────┬───────────────┘
      ▼
┌─────────────────────┐
│ export (MP4/WebM/GIF)│
└─────────────────────┘
      │
      ▼ (optional)
┌─────────────────────┐        ┌──────────────────────┐
│ web upload (S3/R2)  │───────▶│ apps/web (share page)│
└─────────────────────┘        └──────────────────────┘
```

### State Management (Frontend)

```
┌─ Tauri events ──────────────────────────────────────┐
│   recording:progress, encode:progress, log:line     │
└──────────────┬──────────────────────────────────────┘
               ▼
       [event listener hook]
               ▼
┌──────────────────────┐     ┌──────────────────────┐
│ Zustand (session UI) │◀───▶│ TanStack Query       │
│  — transient state   │     │  — invoke() cache    │
└──────────┬───────────┘     └──────────┬───────────┘
           ▼                            ▼
      [components] ──────── invoke ────▶ Tauri commands
```

Zustand owns transient UI (selected step, timeline cursor, playback state). TanStack Query caches `invoke` responses (project list, parsed AST, settings) with sensible `staleTime`. Tauri events trigger either Zustand updates (live session) or `queryClient.invalidateQueries` (project list changed).

### Key Data Flows

1. **Edit → Parse → Validate:** User types in CodeMirror → debounced `invoke('parse_story', {src})` → AST + diagnostics returned → diagnostics rendered inline.
2. **Record Session:** `invoke('start_recording', {storyId})` → host spawns SessionActor → parser + automation + capture + encoder tasks started → emits `recording:progress` events per step → UI renders step-by-step progress and live preview via Channel.
3. **Post-Pro Preview:** User drags keyframe in timeline → `invoke('preview_effect', {params})` → `effects` builds FFmpeg filtergraph for a single frame → encoder renders preview JPEG → returned base64 (small) or via Channel (streaming).
4. **Export:** `invoke('export', {sessionId, format, quality})` → long-running task → `export:progress` events → final file path returned when done.
5. **Desktop ↔ Web Sync:** Desktop opens WebSocket to `apps/web` (authed via NextAuth session token) → mirrors recording status + uploads final video via presigned S3/R2 URL obtained from tRPC.

## Concurrency Model

- **Runtime:** Single tokio multi-thread runtime (Tauri v2 uses tokio by default). No blocking calls in commands — use `spawn_blocking` for rusqlite, `tokio::process` for sidecars.
- **Long-running ops:** Always spawned as tokio tasks owned by an actor. Tauri command returns a `SessionId`/`TaskId` immediately; progress flows via events/channels.
- **Backpressure:** Frame pipeline uses bounded `mpsc` (e.g., 8-frame buffer) between capture→encoder. If encoder lags, capture drops frames with a counter emitted to UI (`capture:dropped`).
- **Cancellation:** Every actor accepts a `Stop` message; spawn handles held in AppState for abort on app exit.
- **Thread affinity:** macOS ScreenCaptureKit requires main-thread dispatch for some delegate callbacks — wrap in a dedicated Objective-C runloop thread; surface frames to tokio via `tokio::sync::mpsc`.
- **Rust ↔ JS boundary:** All `#[tauri::command]` marked `async` so they don't block the Tauri IPC worker.

## IPC Design

| Need | Mechanism | Example |
|------|-----------|---------|
| Fire-and-get-result | Tauri command (`invoke`) | `parse_story`, `list_projects`, `start_export` |
| Broadcast status | Tauri event (`emit`/`listen`) | `recording:progress`, `project:updated` |
| High-freq stream per-call | Tauri v2 `Channel<T>` | live preview frames, FFmpeg progress |
| Sidecar control | stdin/stdout pipes | FFmpeg frames in, progress out; Playwright JSON-RPC |
| Desktop ↔ Web | Authenticated WebSocket (optional) | recording status mirror, upload completion |
| Secrets | OS keychain via `keyring-rs` | Anthropic/OpenAI keys, web auth tokens |

**Command / event naming convention:**
- Commands: `verb_noun` snake_case — `start_recording`, `parse_story`.
- Events: `domain:verb` kebab — `recording:progress`, `automation:step-started`, `encode:progress`.

## Storage Layout

### Project Folder Conventions

Single app root under `~/Library/Application Support/StoryCapture/` (macOS) and `%APPDATA%\StoryCapture\` (Windows), via Tauri `path::app_data_dir()`.

```
<app_data>/
├── app.sqlite                # Global index (projects, settings)
├── keychain.enc              # (unused — secrets go to OS keychain)
└── projects/
    └── <project-uuid>/
        ├── project.json      # human-readable metadata (name, created, tags)
        ├── stories/
        │   └── <story-id>.story
        ├── assets/           # user-imported images, audio, voiceover mp3s
        ├── recordings/
        │   └── <session-id>/
        │       ├── raw.mp4           # screen capture only
        │       ├── cursor.json       # cursor trail + click events
        │       ├── steps.json        # per-step timing/annotations
        │       └── manifest.json     # session metadata
        ├── exports/
        │   └── <export-id>.mp4 / .webm / .gif
        └── project.sqlite    # per-project index (sessions, exports, undo history)
```

### SQLite Schema (sketch)

Two databases: **global** (`app.sqlite`) and **per-project** (`project.sqlite`). Keeps project folders portable (zip + move).

**`app.sqlite`:**
```sql
CREATE TABLE projects (
  id            TEXT PRIMARY KEY,          -- uuid
  name          TEXT NOT NULL,
  folder_path   TEXT NOT NULL UNIQUE,
  created_at    INTEGER NOT NULL,
  last_opened   INTEGER,
  tags_json     TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE recent_files (
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  path          TEXT NOT NULL,
  opened_at     INTEGER NOT NULL,
  PRIMARY KEY (project_id, path)
);

CREATE TABLE settings (
  key           TEXT PRIMARY KEY,
  value_json    TEXT NOT NULL
);

CREATE TABLE migrations (
  version       INTEGER PRIMARY KEY,
  applied_at    INTEGER NOT NULL
);
```

**`project.sqlite`:**
```sql
CREATE TABLE stories (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  file_rel_path TEXT NOT NULL,            -- relative to project folder
  updated_at    INTEGER NOT NULL
);

CREATE TABLE sessions (
  id            TEXT PRIMARY KEY,
  story_id      TEXT NOT NULL REFERENCES stories(id),
  started_at    INTEGER NOT NULL,
  ended_at      INTEGER,
  status        TEXT NOT NULL,             -- recording|completed|failed|canceled
  raw_video_rel TEXT,
  duration_ms   INTEGER,
  fps           INTEGER,
  resolution    TEXT,
  error_message TEXT
);

CREATE TABLE session_steps (
  session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  step_index    INTEGER NOT NULL,
  command       TEXT NOT NULL,
  args_json     TEXT NOT NULL,
  started_ms    INTEGER NOT NULL,          -- offset from session start
  ended_ms      INTEGER NOT NULL,
  status        TEXT NOT NULL,             -- ok|failed|skipped
  screenshot_rel TEXT,
  PRIMARY KEY (session_id, step_index)
);

CREATE TABLE exports (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL REFERENCES sessions(id),
  format        TEXT NOT NULL,             -- mp4|webm|gif
  preset_json   TEXT NOT NULL,             -- post-pro settings snapshot
  file_rel_path TEXT NOT NULL,
  size_bytes    INTEGER,
  created_at    INTEGER NOT NULL
);

CREATE TABLE postpro_presets (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  data_json     TEXT NOT NULL,             -- zoom keyframes, cursor style, etc.
  created_at    INTEGER NOT NULL
);

CREATE INDEX idx_sessions_story ON sessions(story_id);
CREATE INDEX idx_exports_session ON exports(session_id);
```

**Migrations:** `refinery` crate or hand-rolled numbered SQL files in `crates/storage/migrations/`.

### Secrets (OS Keychain)

- `keyring-rs` crate — service = `com.storycapture.app`, keys namespaced: `api.anthropic`, `api.openai`, `api.tts.elevenlabs`, `web.session_token`.
- Never stored in SQLite. Never logged. Never synced to web companion.

## Build Order (dependency-respecting)

Cargo workspace dependency graph (leftmost has no intra-repo deps):

```
shared-types (codegen target) ──┐
                                 │
story-parser ────────────────────┤
                                 │
storage ─────────────────────────┤
                                 │
effects (pure) ──────────────────┤
                                 │
encoder ────────────► FFmpeg     │
                                 │
automation ─────► chromiumoxide  │
                                 │
capture ───────► SCK / WGC       │
                                 │
     ┌───────────────────────────┘
     ▼
apps/desktop/src-tauri (host) — imports all of the above
     │
     ▼
apps/desktop/src (frontend) — imports packages/ui, shared-types, story-dsl
     │
     ▼
apps/web — imports packages/ui, shared-types (no Rust dep)
```

**Recommended implementation order (phase-agnostic build order):**

1. **Foundations:** `packages/config`, `packages/shared-types` codegen pipeline, Cargo workspace skeleton, Turborepo pipeline, CI matrix.
2. **story-parser** (no external runtime deps) — ship AST + diagnostics, unit-test heavily. Emits shared types.
3. **storage** (SQLite migrations + project folder API).
4. **packages/ui + packages/story-dsl** (CodeMirror 6 language) — enables editor UX in parallel with backend work.
5. **apps/desktop shell** — minimal Tauri app that can load, parse, and display a story with diagnostics (no recording yet). Establishes IPC conventions.
6. **automation** — chromiumoxide integration; headful browser; selector engine. Expose `run_story_dry` command (no capture).
7. **capture** — platform-native capture; expose `start_capture`/`stop_capture` emitting raw frame events (or file output).
8. **encoder** — FFmpeg sidecar wiring; validate bundling + signing on both OSes early (high-risk).
9. **Integrated recording pipeline** — SessionActor orchestrating automation + capture + encoder → raw MP4 output. End-to-end demo.
10. **effects** + post-pro pipeline — auto-zoom, cursor overlay, transitions, overlays, sound mixer.
11. **Export + project management UI** — format/quality options, batch export, project library.
12. **apps/web** — can start in parallel after step 1 (shared-types); integrate with desktop once export is stable.
13. **AI features** (NL → DSL, TTS) — layered on top; no architectural dependency beyond commands + keychain.
14. **Distribution:** auto-updater, notarization pipeline, signed sidecars.

**Critical early-validation items (do in steps 7–8, not later):**
- FFmpeg sidecar bundling + macOS notarization (known risk in PROJECT.md).
- ScreenCaptureKit + Windows.Graphics.Capture prototypes.
- chromiumoxide vs Playwright-sidecar feature gap assessment.
- macOS permission flow (Screen Recording + Accessibility prompts).

## Scaling Considerations

This is a desktop app, not a server — "scaling" means library size, project count, and video length.

| Scale | Architecture Adjustments |
|-------|--------------------------|
| 1–50 projects, <10 sessions each | SQLite + filesystem as designed; no indexing beyond primary keys. |
| 50–500 projects, hundreds of sessions | Add FTS5 index on `stories.title` + `sessions.story_id` for search; lazy-load project list with virtual scrolling. |
| 1000+ projects, long-running users | Archive old sessions to a `archived/` folder; keep only manifest in DB; add per-project "last used" pruning UI. |
| Per-project: 60-min recording, 60 fps, 4K | Must never buffer full video in memory — frame pipeline is mpsc with bounded capacity (~8 frames). HW-accel encode required. Disk throughput becomes bottleneck before CPU. |

### Scaling Priorities

1. **First bottleneck:** Frame pipeline memory on long 4K recordings → enforced via bounded mpsc + dropped-frame counter + HW-accel encode as baseline, not upgrade.
2. **Second bottleneck:** SQLite write contention during active recording (step logs) → batch step inserts every N steps or on session end; use WAL mode.
3. **Third bottleneck:** Project library UI at 1000+ items → virtualized list + FTS index; don't load full project metadata upfront, lazy-fetch on row hover.

## Anti-Patterns

### Anti-Pattern 1: Business logic in `src-tauri/src/main.rs` or command handlers

**What people do:** Put parser calls, browser driving, and SQL directly inside `#[tauri::command]` functions.
**Why it's wrong:** Cannot unit-test without a Tauri runtime; cannot reuse in a future CLI; tightly couples transport to logic; command files grow to thousands of lines.
**Do this instead:** Commands are 3-10 lines that call into a crate. All logic lives in `crates/*`.

### Anti-Pattern 2: `Arc<Mutex<BigAppState>>` shared across every command

**What people do:** One fat mutex holding parser, automation driver, SQLite connection, and session state; every command locks it.
**Why it's wrong:** Priority inversion, deadlocks when commands await while holding the lock, impossible to reason about concurrency.
**Do this instead:** Per-subsystem actors communicating via `mpsc`. AppState holds only `Sender`s. Lock nothing across `.await`.

### Anti-Pattern 3: Hand-written duplicated types on both sides of IPC

**What people do:** Declare `interface Story { … }` in TS and `struct Story { … }` in Rust independently.
**Why it's wrong:** Drifts within days. Subtle enum mismatches silently break event handlers.
**Do this instead:** `tauri-specta` or `ts-rs` to generate TS from Rust into `packages/shared-types`. Commit generated output or build-time generate.

### Anti-Pattern 4: Emitting events as JSON strings

**What people do:** `emit("progress", json!({...}).to_string())` and `JSON.parse` on the TS side.
**Why it's wrong:** Loses type safety, breaks tauri-specta, hides schema drift.
**Do this instead:** Emit typed structs; let Tauri serialize. Consume with `listen<ProgressPayload>`.

### Anti-Pattern 5: Raw `invoke('foo', …)` string calls in components

**What people do:** Call `invoke('start_recording', {id: story.id})` directly from a React component.
**Why it's wrong:** Typos become runtime errors. Refactoring a command name requires a global grep.
**Do this instead:** Every command has a wrapper in `apps/desktop/src/ipc/commands.ts`. Components import the wrapper.

### Anti-Pattern 6: Polling for job status

**What people do:** Start an export, then `setInterval(() => invoke('get_export_status'), 500)`.
**Why it's wrong:** Wasted CPU, laggy UI, races. Tauri's event bus exists.
**Do this instead:** Command returns immediately; backend emits `export:progress` events; frontend subscribes once with a hook.

### Anti-Pattern 7: Shelling out to user-installed FFmpeg

**What people do:** `Command::new("ffmpeg")` expecting it on PATH.
**Why it's wrong:** Users don't have it; versions vary; HW-accel codec availability is unpredictable; macOS Gatekeeper blocks unsigned spawned binaries.
**Do this instead:** Bundle as Tauri sidecar. Sign + notarize. Known-good build for both platforms.

### Anti-Pattern 8: Capturing frames to intermediate PNG files

**What people do:** Write each frame to disk, then read back for encoding.
**Why it's wrong:** I/O bound, fills disk fast at 60fps, destroys performance targets.
**Do this instead:** In-memory `mpsc<Frame>` from capture → encoder stdin. Disk touches happen only for the final MP4.

### Anti-Pattern 9: Mixing global and per-project data in one SQLite file

**What people do:** Everything in `app.sqlite`, including per-project sessions.
**Why it's wrong:** Can't zip-and-move a project; corruption takes down the entire library.
**Do this instead:** `app.sqlite` (index only) + per-project `project.sqlite` inside the project folder.

## Integration Points

### External Services

| Service | Integration Pattern | Notes |
|---------|---------------------|-------|
| Anthropic / OpenAI (NL→DSL) | HTTPS from Rust (`reqwest`), key from OS keychain | Rust-side only; never send key to frontend |
| ElevenLabs / TTS | Same (HTTPS + keychain) | Stream audio → store in `assets/` |
| S3 / R2 (uploads) | Presigned URL from `apps/web` via tRPC, PUT from desktop | Desktop never holds S3 creds |
| `apps/web` (NextAuth, tRPC) | HTTPS + WebSocket for live status | Session token in OS keychain |
| Tauri updater | Signed update manifest, differential | Key in CI secrets; notarize on macOS |

### Internal Boundaries

| Boundary | Communication | Notes |
|----------|---------------|-------|
| Frontend ↔ Rust host | Tauri commands + events + channels | Only boundary for all OS/fs/network |
| Host ↔ crates | Direct Rust function calls (async) | Crates never call Tauri |
| Host ↔ FFmpeg sidecar | stdin (frames) + stderr (progress) | Bounded mpsc between capture and stdin writer |
| Host ↔ Playwright sidecar (opt.) | JSON-RPC over stdin/stdout | Only if chromiumoxide gap |
| Desktop ↔ Web | WebSocket + HTTPS | Authed; optional feature, degrades gracefully |
| Automation ↔ Browser | CDP over WebSocket | In-process via chromiumoxide |
| Capture ↔ OS | ScreenCaptureKit / WGC | Platform-specific submodules behind trait |

## Sources

- Tauri v2 architecture docs: commands, events, channels, sidecars, permissions — https://v2.tauri.app/concept/
- Tauri v2 sidecar guide — https://v2.tauri.app/develop/sidecar/
- `chromiumoxide` crate docs (CDP in Rust) — https://docs.rs/chromiumoxide/
- `tauri-specta` typed IPC codegen — https://github.com/specta-rs/tauri-specta
- Apple ScreenCaptureKit docs — https://developer.apple.com/documentation/screencapturekit
- Microsoft `Windows.Graphics.Capture` — https://learn.microsoft.com/en-us/windows/uwp/audio-video-camera/screen-capture
- FFmpeg hardware acceleration (VideoToolbox / NVENC / QSV) — https://trac.ffmpeg.org/wiki/HWAccelIntro
- `keyring-rs` — https://github.com/hwchen/keyring-rs
- PROJECT.md (this repo, 2026-04-14)

**Confidence notes:** HIGH on Tauri v2 command/event/channel/sidecar patterns (official docs + stable API). HIGH on the storage layout and actor-style concurrency (standard Rust idioms). MEDIUM on chromiumoxide maturity vs Playwright — validate with a spike in step 6 of build order. MEDIUM on ScreenCaptureKit/WGC integration details — prototype early (already flagged in PROJECT.md risks).

---
*Architecture research for: StoryCapture (Tauri v2 + Next.js monorepo)*
*Researched: 2026-04-14*
