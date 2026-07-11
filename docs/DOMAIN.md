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
contains the checked-in, `ts-rs`-generated AST/vocabulary and CodeMirror stream
language/highlight support; runtime parsing is exposed to the renderer through
`apps/desktop/src/ipc/parse.ts` and the Electron host.

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
click <button> "Save"
type <textbox> "Search" "StoryCapture"
fill field "Email" with "admin@example.com"
click <link> "Dashboard"
click testid "btn-save"
click aria "Close dialog"
click text "Exactly this text"
click <button> "Save" nth 2
```

Picker and UI-mode serialization use `<role> "accessible name"` for every
accessibility role so arbitrary roles round-trip without a shared allowlist.
The runtime parser still accepts established bare-role input such as
`button "Save"`, `heading "Main Page"`, and legacy `textbox "Search"`.

`nth N` is 1-indexed and disambiguates repeated targets.

## Project And Sidecars

StoryCapture stores source plus JSON sidecars near projects and recordings.

- `.story.targets.json`: primary and fallback targets keyed by step id.
- `<story>.polish.json`: optional post-production intent edited in UI mode.
- `.storycapture/output.json`: per-project output preferences.
- `<recording>.actions.json`: action/timing events from a recording.
  Version 2 action sidecars may include `cursor_timing`, `input_timing`, and
  `cursor_motion_preset` so post-production can distinguish cursor travel,
  target arrival, dwell, and semantic browser input. Consumers must keep v1
  fallback behavior for sidecars that only have `t_start_ms`, `t_action_ms`,
  and `t_end_ms`.
  Version 3 adds encoded-video media-clock metadata, committed cursor paths,
  input landmarks, and explicit presented/timeout/not-applicable outcomes.
  The v1/v2 reader remains part of the compatibility contract.
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
  opaque source rewrites. Current source has feature code/tests for chat,
  diffs, apply, and regeneration, but no desktop route-level mount was found.

## Automation And Recording

The Electron host owns automation and capture behavior. There are no current
Rust/native capture crates.

- Automation is BrowserWindow-based in the Electron host. It can launch an
  offscreen browser window or attach to an author preview stream.
- Recording uses Electron capture APIs such as `desktopCapturer`, `screen`, and
  `webContents.capturePage`.
- Frame capture writes a PNG sequence and then encodes through
  `ffmpeg-static`.
- Audio is optional and merged during encode when available. The Electron
  preload special-cases recording start/stop so renderer-side browser
  `MediaRecorder` microphone capture can be handed back to the host through
  `electron_recording_set_audio`.
- Recording lifecycle supports start/stop and pause/resume surfaces.
- Recording sidecars feed post-production cursor, zoom, callout, highlight, and
  sound defaults.
- Recorded automation treats `click`, `hover`, `type`, and `select` as
  cursor-visible interaction events. `wait-for` and `assert` never create
  cursor movement; `drag` and `upload` remain outside synced cursor recording
  until the Electron runner implements those commands end to end.
- Recording cursor synchronization is anchored to committed encoded frames,
  not wall-clock callbacks. `recording-media-clock.ts` owns frame-to-PTS
  conversion; `action-landmarks.ts` owns arrival/input/presentation landmarks;
  `cursor-sync-mode.ts` owns rollout. The required ordering is cursor arrival
  <= input action <= first post-input frame when presentation is applicable.

Operator-gated capture work still requires real macOS Screen Recording/TCC
verification; do not treat simulated tests as equivalent to OS-level UAT.
The current source includes helper/test coverage for screen-capture permission
probing, but that does not replace operating-system permission testing.

## Post-Production

Main files live under `apps/desktop/src/features/post-production`.

The editor loads story source, the latest recording where applicable, saved
timeline layout JSON, action events, cursor trajectory, step timing, and
optional polish data before building timeline tracks. Saved layout wins over
generated bootstrap data; corrupt or unsupported layout falls back to bootstrap
without crashing. The editor owns:

- `editor-shell.tsx`: primary route surface.
- Timeline and track state: video, cursor, zoom, sound, annotation/highlight.
- `state/timeline-layout.ts`: versioned timeline layout persistence schema.
- `state/build-timeline-from-story.ts`: Story plus sidecars to initial timeline.
- `state/compute-graph.ts`: timeline to render/export graph.
- Inspector panels for output, background, effects, sound, and export settings.
- Preview engine with WebGPU path where available and fallback behavior.
- Export modal, render queue/progress UI, undo/history, sound drawer, and
  voiceover compact UI.

Current host export behavior: `export_run` writes a graph snapshot and creates
real render queue jobs. The legacy host path plans each output before queueing:
eligible one-source, match-source, high-quality MP4/WebM exports use stream
copy; source-only re-encodes apply encoder quality, keyframe, scale, and audio
settings through FFmpeg; supported one-source composited MP4/WebM graphs render
through a hidden renderer canvas and stream raw BGRA frames into FFmpeg.
Supported compositor nodes include background, zoom, cursor, ripple, highlight,
and text overlays with source audio mapped from the source video when the source
starts at `pts_offset_ms: 0`. Multiple sources, non-zero source offsets,
transitions, GIF compositing, and separate audio graph nodes still fail clearly
before queueing instead of being silently dropped.

## Render And Export

Renderer-side boundaries:

- `apps/desktop/src/ipc/render.ts`: render job/progress facade.
- `apps/desktop/src/ipc/export.ts`: export catalogue/validation/run facade.
- `apps/desktop/src/ipc/encode.ts`: recording encode and hardware probe facade.
- Post-production `compute-graph.ts`: graph generation.

Host-side boundaries:

- Modular handlers under `apps/desktop/electron/ipc/*`.
- Remaining render/export implementation in `ipc/legacy.ts`; export planning and
  FFmpeg argument mapping live in `ipc/legacy/export-planning.ts`; hidden
  renderer orchestration for composited exports lives in
  `ipc/legacy/export-compositor.ts`.
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

Important web behavior details:

- Auth uses NextAuth/Auth.js v5 database sessions through Prisma. User creation
  also creates a personal workspace.
- Desktop token exchange validates an Auth.js session token and mints a
  30-day desktop JWT; SSE subscription JWTs are short-lived, currently
  15 minutes.
- Workspace roles are `OWNER`, `EDITOR`, and `VIEWER`.
- Upload APIs create multipart R2 uploads, persist `Video` rows as
  `UPLOADING`, presign parts/thumbnails, complete to `READY`, or mark failed.
- Watch and embed pages serve `READY` videos by slug/id. oEmbed requires the
  video to be public.
- Analytics uses an anonymous `sc_session` cookie, accepts event batches of
  1-50, has an in-memory 10 requests/second/IP guard, aggregates daily stats
  through cron, and retains raw events for 90 days.
- Sync uses metadata-only `SyncedProject` records, recording status updates,
  in-memory EventEmitter subscriptions, short-lived JWT membership checks for
  subscriptions, and polling fallback.

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
- Generated video, cursor, zoom, and action layers share a sync group, stable
  source revision, and source-to-timeline map. Group move/trim/delete and preset
  reflow are atomic; independent user overlays are not attached to the group.
- Source-bound preview overlays advance from presented video frames, not RAF
  wall time. Non-identity maps and holds are shared with export; preserve-full-
  motion is opt-in and inserts only the exact cursor deficit.
- Graph schema v3 carries `source_time_map` on source nodes. Preview and the
  hidden export compositor share timeline-to-source mapping; non-identity maps
  require composition, and capture-bound audio is trimmed, silenced across
  holds, then concatenated through the same map. Identity maps retain the
  direct optimization.
