# StoryCapture - Domain & Pipeline

Business reference for `.story` semantics, browser automation, capture/export,
post-production, AI/NL/TTS surfaces, and the web companion.

## Product Loop

```text
.story source
  -> desktop parseStory IPC
  -> editor UI model / diagnostics / dry run / simulator
  -> Electron browser automation
  -> Electron capture + ffmpeg-static encode
  -> recording sidecars
  -> post-production timeline
  -> computeGraph render/export graph
  -> local export and optional web upload/share
```

## DSL (`.story`)

Stories describe browser actions and post-production intent. `packages/story-dsl`
contains the checked-in AST/vocabulary and CodeMirror language support; runtime
parsing is exposed to the renderer through `apps/desktop/src/ipc/parse.ts` and
the Electron host.

Common verbs:

```text
navigate "<url>"
click <target>
fill <target> with "<text>"
type <target> "<text>"
scroll <direction> [<count>]
hover <target>
drag <target> to <target>
select <target> "<value>"
upload <target> "<path>"
wait <duration>
wait-for <target> [timeout <duration>]
assert <target>
screenshot "<name>"
pause
```

Accessibility-first targets remain preferred:

```text
click button "Save"
fill field "Email" with "admin@example.com"
click link "Dashboard"
click testid "btn-save"
click aria "Close dialog"
click text "Exactly this text"
click button "Save" nth 2
```

`nth N` is 1-indexed and disambiguates repeated targets.

## Project And Sidecars

StoryCapture stores source plus JSON sidecars near projects and recordings.

- `.story.targets.json`: primary and fallback targets keyed by step id.
- `<story>.polish.json`: optional post-production intent edited in UI mode.
- `.storycapture/output.json`: per-project output preferences.
- `<recording>.actions.json`: action/timing events from a recording.
- `<recording>.trajectory.json`: cursor movement data.
- `<recording>.steps.json`: step timing summaries.
- Post-production graph snapshots: export/render graph JSON written before host
  export work.

Sidecars are part of the product contract. When changing action timing, target
resolution, polish defaults, or export graph shape, inspect both producer and
consumer paths.

## Authoring

Main files live under `apps/desktop/src/features/editor`.

- Code authoring uses CodeMirror setup, DSL autocomplete, hover docs, lint
  diagnostics, and source normalization.
- Parser/LSP IPC powers diagnostics and UI model extraction.
- UI mode uses `story-builder.tsx` and `story-ui-model.ts` to edit canonical DSL
  back into the source buffer.
- Live preview uses author preview IPC and lifecycle state.
- Element picking uses `src/ipc/picker.ts`, picker hover events, fallback target
  sidecars, and picker action rewrite helpers.
- Dry run and simulator surfaces use dedicated stores, keyboard handling,
  timeline decoration, and host simulator IPC.
- Polish controls write `<story>.polish.json` only after user edits; opening a
  project should not create default polish data.
- NL mode lives in `features/nl-mode` and applies per-step diffs rather than
  opaque source rewrites.

## Automation And Recording

The Electron host owns automation and capture behavior. There are no current
Rust/native capture crates.

- Automation is BrowserWindow-based in the Electron host. It can launch an
  offscreen browser window or attach to an author preview stream.
- Recording uses Electron capture APIs such as `desktopCapturer`, `screen`, and
  `webContents.capturePage`.
- Frame capture writes a PNG sequence and then encodes through
  `ffmpeg-static`.
- Audio is optional and merged during encode when available.
- Recording lifecycle supports start/stop and pause/resume surfaces.
- Recording sidecars feed post-production cursor, zoom, callout, highlight, and
  sound defaults.

Operator-gated capture work still requires real macOS Screen Recording/TCC
verification; do not treat simulated tests as equivalent to OS-level UAT.

## Post-Production

Main files live under `apps/desktop/src/features/post-production`.

The editor owns:

- `editor-shell.tsx`: primary route surface.
- Timeline and track state: video, cursor, zoom, sound, annotation/highlight.
- `state/build-timeline-from-story.ts`: Story plus sidecars to initial timeline.
- `state/compute-graph.ts`: timeline to render/export graph.
- Inspector panels for output, background, effects, sound, and export settings.
- Preview engine with WebGPU path where available and fallback behavior.
- Export modal, render queue/progress UI, undo/history, sound drawer, and
  voiceover compact UI.

Current host export caveat: UI exposes advanced export concepts, but the
Electron host `export_run` path currently shells out to FFmpeg with hardcoded
codec choices for MP4/WebM in the legacy host path. Verify backend support
before assuming every UI option affects final encoding.

## Render And Export

Renderer-side boundaries:

- `apps/desktop/src/ipc/render.ts`: render job/progress facade.
- `apps/desktop/src/ipc/export.ts`: export catalogue/validation/run facade.
- `apps/desktop/src/ipc/encode.ts`: recording encode and hardware probe facade.
- Post-production `compute-graph.ts`: graph generation.

Host-side boundaries:

- Modular handlers under `apps/desktop/electron/ipc/*`.
- Remaining render/export implementation in `ipc/legacy.ts`.
- FFmpeg comes from `ffmpeg-static`.

Export graph changes should include targeted tests around graph generation and
at least one host-path verification when behavior reaches FFmpeg.

## AI / NL / TTS

AI provider setup is credential-gated. The app exposes UI and IPC surfaces for:

- natural-language editing and diff cards;
- per-step regeneration/apply flows;
- voice catalog browsing;
- TTS clip generation;
- API-key storage through desktop settings.

Provider keys are stored at runtime through desktop secret storage/keychain
surfaces. They are never committed.

## Web Companion

The web app supports:

- public home, watch pages, embed pages, invite pages, robots/sitemap;
- dashboard pages for workspaces, videos, analytics, templates, sync, members,
  and settings;
- NextAuth v5 with Prisma adapter, GitHub and Google OAuth, database sessions,
  and personal workspace creation on first user creation;
- tRPC routers for user, workspace, video, analytics, template, sync, and
  health;
- Cloudflare R2 multipart upload initiate/presign/complete APIs;
- analytics session and event ingest plus cron aggregation;
- desktop token exchange and short-lived SSE JWT minting;
- metadata-only desktop sync through `SyncedProject`, recording status, and
  SSE-style subscriptions with polling fallback.

Web tests are currently narrow. Do not infer full coverage for auth callbacks,
upload APIs, invite/RBAC, analytics cron, watch/embed/oEmbed, or route
availability unless tests are added.

## Templates And Workflow Metadata

Templates live in the web companion (`Template` Prisma model and
`templateRouter`). Template records carry story source plus workflow metadata,
required inputs, and optional polish preset. The fork flow returns downloadable
`.story` content and metadata for the desktop/web handoff.

Desktop sync metadata lives in `SyncedProject`; it mirrors project identity,
story source/status, workflow metadata, recording status, and timestamps. It is
not a full project-file sync system.
