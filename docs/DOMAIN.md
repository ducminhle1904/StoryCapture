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
text-overlay "<text>" [<integer>ms]
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

Explicit scroll accepts `px` and `vh`, with optional targeted containers:

```text
scroll down 300px
scroll down 50vh
scroll selector ".activity-panel" down 300px
scroll testid "results" nth 2 up 50vh
```

Unitless legacy amounts normalize to pixels, and an omitted amount defaults to
`500px`. Targeted scroll moves the picked element's own scrollable box or its
nearest scrollable ancestor. `wait-for` and `assert` remain DOM-presence checks;
`wait-for-visible` and `assert-visible` use the actionable visibility pipeline.

`text-overlay` declares a caption that appears in the recording timeline:

```text
text-overlay "Welcome to StoryCapture"
text-overlay "This stays longer" 5000ms
```

The default duration is `2000ms`. An explicit duration must be an integer with
the `ms` suffix from `100ms` through `30000ms`, inclusive; empty text, other
units, unitless or decimal values, values outside the range, and trailing tokens
are parser errors that block recording. UI mode exposes separate text and
duration fields and serializes the default explicitly as `2000ms` while
preserving step-id comments.

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
  sidecars, and picker action rewrite helpers. Native scroll/resize while Picker
  is active refreshes the highlighted element under the stationary pointer and
  never emits DSL; the deliberate “Scroll this container” action emits canonical
  targeted scroll syntax with direction, amount, and unit.
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
- The legacy recorder emits privacy-safe JSONL V2 diagnostics for session,
  preview/backend, target/cursor/readiness, sidecar, cadence/audio, and terminal
  events. Process/session ordering is monotonic; logging failure falls back
  locally and never changes capture or encode outcomes.
- Recording sidecars feed post-production cursor, zoom, callout, highlight, and
  sound defaults.
- Recorded automation treats `text-overlay` as a sequential, pause-aware and
  cancellable delay. It keeps capture active for the declared duration, records
  normal step start/end timing, and does not resolve a target, touch the DOM,
  run interaction readiness, or emit cursor/action events. The following
  command cannot begin until the overlay duration completes.
- Recorded automation treats `click`, `hover`, `type`, and `select` as
  cursor-visible interaction events. Before these actions, pure target
  observation computes safe viewport and nested-scroller clips, chooses an
  unobstructed actionable point, and runs a deterministic distance-scaled
  300-900 ms scroll when needed. Scroll and geometry stabilize before cursor
  travel begins; action sidecars store scroll and cursor timing separately.
  `wait-for` and `assert` never scroll or create cursor movement, while
  `wait-for-visible` and `assert-visible` use the same visibility pipeline.
  `drag` and `upload` remain outside synced cursor recording until the Electron
  runner implements those commands end to end.
- Recording cursor synchronization is anchored to committed encoded frames,
  not wall-clock callbacks. `recording-media-clock.ts` owns frame-to-PTS
  conversion; `action-landmarks.ts` owns arrival/input/presentation landmarks;
  `cursor-sync-mode.ts` owns rollout. The required ordering is cursor arrival
  <= input action <= first post-input frame when presentation is applicable.
  Before browser input, the runner requests a serialized frame commit from the
  active capture session. A committed frame produces authoritative landmarks;
  timeout, backpressure, capture failure, or encoder failure degrades to the
  existing timing fallback without inventing frame PTS or blocking valid input.
  Stop/cancel settles pending landmark waiters.

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
- `state/cursor-click-effect.ts`: normalized cursor click-effect presets and
  deterministic, playhead-driven primitive sampling shared by preview/export.
- `state/compute-graph.ts`: timeline to render/export graph.
- Inspector panels for output, background, effects, sound, and export settings.
- Production Preview adapter over the canonical Canvas renderer shared with
  hidden export; native video remains only for lightweight harnesses.
- Export modal, render queue/progress UI, undo/history, sound drawer, and
  voiceover compact UI.

Text appearance has one shared resolution boundary in `state/text-style.ts`.
Preset values are inherited when a persisted field is absent, while nullable
effects such as the text box and shadows use `null` as an explicit off state.
The same normalized typography, color alpha, wrapping, edge anchoring, and
animation values feed the canonical Preview and export graph. System-font
discovery is user-activated and cached for the renderer session; saved font
metadata remains intact when access is denied or a face is missing, while the
effective preview/export font falls back to bundled Geist.

During recording bootstrap, `text-overlay` directives match `<recording>.steps.json`
timing by step id and then by ordinal when no id is available. Each match creates
a recording-bound annotation from the existing `caption` style: its start comes
from the recorded step, its duration comes from the script, and its end is
clamped to the recorded media. Missing or outside-media timing skips the overlay
and produces one aggregated re-record warning instead of guessing placement.
Generated overlays carry the recording sync group, source revision, and source
time map, so preview and export use the existing annotation/compositor path.
Saved timeline edits are authoritative for the current source revision; a
re-record regenerates script-bound overlays while preserving independent user
annotations. Post-production edits never rewrite the `.story` source.

Action-backed cursor clips support `None`, `Ring`, `Soft Pulse`, `Echo`, and
`Press` click feedback with color and intensity presets. New generated clips
use `Soft Pulse + Auto + Normal`; saved clips without the field normalize to
the legacy `Ring + White + Normal` behavior. Feedback starts at action-sidecar
input timing, is sampled only from playhead/source time, and uses the same
bounded canonical Canvas primitives in Preview and export. Trajectory-only
and PNG-sequence cursors do not infer clicks and keep the controls disabled.

`computeGraph` emits the JSON-safe schema-v5 composition contract from
`packages/shared-types/src/export-composition.ts`. Preview, export, and host
planning accept schema V4 and V5; legacy V4 `padding_px` geometry remains exact.
The canonical scene evaluator and Canvas renderer evaluate the graph, while the
hidden export window is only a host for the canonical engine. Source-copy and
source-only bypasses are retired: MP4, WebM, and GIF all receive raw BGRA frames
from the canonical renderer, including multi-source transitions, background,
zoom, cursor, ripple, highlight, and text layers.
Preview adds a presentation-only layout: the canonical background spans the
full editor stage while the exact composition is aspect-fitted inside it. This
does not change graph or export geometry; export renders the canonical canvas
at its exact output dimensions.
In framed mode, the editor's transparent background means the canonical
ambient treatment: a blurred, darkened source fill behind the contained source
frame. V5 background nodes carry a centered `foreground_scale` from 0.70 to
1.00, defaulting to 0.85. Match-source uses the recorded source dimensions
exactly instead of expanding the output for frame padding. Source frame mode
forces scale 1 and radius 0 for full-bleed output; its background node may
remain in the graph but is covered by the foreground. While Source fill is
active, the Background panel keeps the saved foreground size visible and labels
it as overridden. Choosing a size preset, adjusting the slider, or selecting
`Use cinematic frame` switches to Cinematic framing so the saved size takes
effect; Source fill itself remains full-bleed until that switch.

The host creates an Electron offscreen backing store at an explicit capture DPR
and reads the renderer's presented frame without depending on the physical
display scale. Every successful capture must match the requested physical
dimensions and `width * height * 4` BGRA byte count; a mismatch fails the job
and is never repaired by a resize fallback.

`export_preflight` returns structured info/warning/error issues scoped to an
output and, where available, a clip. Warnings stay visible but only errors block
submission. `export_run` writes a unique graph snapshot, reserves each output
independently, and queues jobs with `queued`, `rendering`, `mixing`,
`verifying`, `completed`, `failed`, or `cancelled` status. One failed output
does not stop siblings in the same batch. The strict priority/FIFO scheduler has
two weighted units: outputs through 2560×1440 consume one unit and larger
outputs consume both. Jobs are ordered by priority and then FIFO, a queued head
job is never bypassed to overcommit memory, and queued jobs expose their current
`queue_position`.

The audio planner builds deterministic source, BGM, SFX, and voiceover inputs.
It applies source transition crossfades, timeline trim/delay, BGM looping,
voiceover sidechain ducking, channel/sample-rate normalization, a limiter, and
silence for sources without audio. MP4 uses AAC, WebM uses Opus, and GIF emits
an informational no-audio diagnostic. MP4 audio is measured and normalized to
-14 LUFS (within 0.5 LU), with true peak capped at -1 dBTP, before the final
render pass. Audio-bearing MP4 is AAC-LC, 48 kHz stereo; an audio-free graph
produces no audio stream. The MP4 audio target is 192 kbps and the loudness
normalizer uses an 11 LU range target.

MP4 delivery uses H.264 High, yuv420p, CFR, limited-range Rec.709, and faststart.
When a batch contains generated voice, the renderer presents the disclosure
choice; enabled MP4 outputs receive a bounded Adobe UUID XMP packet containing
only the approved creator tool, format, generated-voice flag, and generation
method. This is disclosure metadata, not signed C2PA provenance. WebM and GIF
remain exportable and receive a preflight warning because this XMP carrier is
MP4-only.

FFmpeg writes a same-folder partial file. Completion is published only after
ffprobe validates dimensions, frame rate, duration, and stream shape and FFmpeg
decodes the whole artifact. MP4 verification also checks profile, pixel/color
metadata, CFR, faststart, loudness, and requested XMP before publication. The
host then publishes the reserved final path;
the same-folder verified inode is linked atomically so a file created after
reservation can never be overwritten. Failure/cancellation removes partial
state, and startup cleans dead-process reservation sidecars from previously
used output folders.

## Render And Export

Renderer-side boundaries:

- `apps/desktop/src/ipc/render.ts`: render job/progress facade.
- `apps/desktop/src/ipc/export.ts`: export catalogue/validation/run facade.
- `apps/desktop/src/ipc/encode.ts`: recording encode and hardware probe facade.
- Post-production `compute-graph.ts`: graph generation.

Host-side boundaries:

- Modular handlers under `apps/desktop/electron/ipc/*`.
- `ipc/export-compositor-host.ts` owns the hidden renderer window and packaged
  asset resolution; the renderer bridge is
  `features/post-production/export-compositor/export-compositor-app.tsx`.
- Remaining render/export orchestration lives under `ipc/legacy/`:
  `export-render.ts`, `export-planning.ts`, `export-audio-planning.ts`,
  `export-compositor.ts`, `export-output-lifecycle.ts`, and
  `export-artifact-verification.ts`; `export-xmp.ts` owns the bounded MP4 XMP
  writer/parser.
- `ipc/export-binaries.ts` resolves packaged FFmpeg and ffprobe executables,
  including their unpacked application paths.
- `ipc/export-e2e-smoke.ts` and `ipc/export-quality-gate.ts` own the packaged
  all-effects regression and independent quality evidence.

Export graph changes should include targeted tests around graph generation and
the canonical visual/audio planners. Changes that reach FFmpeg or packaged
assets must also run `pnpm --dir apps/desktop run test:e2e:export`.

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
