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
- New canonical takes live at `exports/takes/<take-id>/`. `manifest.json` is
  committed last and is the discovery authority; `media/video.mp4`, optional
  audio tracks, action/health sidecars, and salvage diagnostics stay inside the
  immutable bundle. Legacy flat MP4 recordings remain discoverable.
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
- Display/window capture keeps the PNG path for compatibility and uses the live
  raw BGRA encoder sink when enforced readiness needs pre-input ACKs;
  author-preview capture uses that live sink directly. Every selected path
  reports real encoded-frame acknowledgements to the same readiness and health
  contracts.
- Browser automation cannot start until the first encoded frame is committed.
  Scene work uses hard capture barriers; individual action boundaries use
  bounded soft barriers and never invent frame PTS on failure.
- Microphone capture supports a bounded ordered stream from preload to host.
  Encoded-video PTS is the master clock; pause spans, start offset, end drift,
  padding/trimming, and the explicit video duration are recorded as A/V
  evidence. The legacy whole-buffer path remains rollout-controlled.
- Multitrack mode preserves `microphone`, author-preview `tab`, and platform
  `system` as separate identities and immutable stems. Author preview may use
  microphone plus tab; external targets may use microphone plus system; tab
  and system never alias or run together. Required track failure cannot pass
  strict outcome, while optional failure is retained as a warning. A derived
  compatibility mix pads leading PTS gaps to the full video duration and never
  deletes the source stems. Electron coverage records microphone and tab
  concurrently through separate authenticated channels; fake-device evidence
  does not replace physical-device packaged UAT.
- The live engine-health snapshot exposes FPS/loss/backpressure, audio-track
  state, target liveness, disk pressure, and terminal health. Fatal UI actions
  are restricted to the host-provided Stop, Cancel, and Repair allowlist. The
  steady-state event stream is capped at 1 Hz; severity, terminal, and disk
  pressure transitions bypass that throttle.
- Recording lifecycle is a guarded session state machine. Stop and cancel are
  idempotent, cleanup runs once, and a cached typed terminal result can be
  replayed after renderer reattachment.
- A read-only preflight checks permission, exact target liveness, writable
  output, disk, encoder smoke, and requested audio before allocating a session.
- Terminal verdicts are `passed`, `repairable`, `failed`, or `cancelled`.
  Partial artifacts may be retained, but only `passed` with a committed
  canonical bundle is a successful, publishable take. Shadow mode keeps legacy
  UX while emitting the strict classifier result for comparison.
- Durable session journals support restart-time Recover or Discard. Recovery
  salvages committed media/sidecars only and never resumes browser state or
  automation input.
- Scene checkpoints produce immutable media attempts and soft per-step
  PTS/frame/state-hash landmarks. Each attempt snapshot also preserves its
  source frame/PTS range and the actions/checkpoints captured inside that
  range. Repair is manual and valid only while the original browser session is
  alive; unsafe replay expands to scene/full rerun.
- A successful repair selects one committed attempt per scene and assembles a
  new immutable revision. Video, action, and checkpoint time are rebased from
  each selected attempt's source range; audio stems are sliced against the
  encoded-video master clock, retained by track identity, and mixed only into a
  derived compatibility track. The revision manifest is committed last, then
  canonical media points at that revision. The original session media and all
  source attempts remain immutable and registered in the recording bundle.
  Token expiry, attempt exhaustion, cancellation, or another non-success exit
  does not assemble an incomplete revision; it finalizes the original media as
  a non-success salvage bundle.
- Browser-surface video stays on direct Electron author-preview capture.
  External window/display capture resolves exact target identity through the
  host-private capture-backend contract. Missing, ambiguous, PID-unresolvable,
  or lost targets fail with typed evidence; a running session never switches
  backend mid-artifact. Contract delivery carries the actual bitmap with an
  explicit sequence, frame index, and PTS. Shadow mode only observes the
  contract; internal/GA modes emit target loss once, retain its terminal
  provenance, and reject every later frame for that target.
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
  `drag` uses mouse-down, interpolated committed movement, and mouse-up with a
  complete cursor/input trajectory. `upload` uses the Chromium file-input path,
  validates allowed file scope and multiplicity, and redacts local paths from
  logs and sidecars.
- Recording cursor synchronization is anchored to committed encoded frames,
  not wall-clock callbacks. `recording-media-clock.ts` owns frame-to-PTS
  conversion; `action-landmarks.ts` owns arrival/input/presentation landmarks;
  `cursor-sync-mode.ts` owns rollout. The required ordering is cursor arrival
  <= input action <= first post-input frame when presentation is applicable.
  Before browser input, the runner requests a serialized frame commit from the
  active capture session. A committed frame produces authoritative landmarks;
  timeout, backpressure, capture failure, or encoder failure degrades to the
  existing timing fallback without inventing frame PTS or blocking valid input.
  A post-input presentation timeout is a typed repair condition. Choosing
  `await_presentation` rearms the presentation wait and never replays the
  browser input. Stop/cancel settles pending landmark waiters.
- External window/display capture is fail-closed. Once the exact source
  disappears, the backend emits one typed target-loss event, rejects later
  frames, and strict outcome reports `failed/capture_target_lost`.

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

`computeGraph` emits the JSON-safe schema-v4 composition contract from
`packages/shared-types/src/export-composition.ts`. Preview and export evaluate
that same contract through the canonical scene evaluator and Canvas renderer;
the hidden export window is only a host for the canonical engine. Source-copy
and source-only bypasses are retired: MP4, WebM, and GIF all receive raw BGRA
frames from the canonical renderer, including multi-source transitions,
background, zoom, cursor, ripple, highlight, and text layers.
In framed mode, the editor's transparent background means the canonical
ambient treatment: a blurred, darkened source fill behind the contained source
frame. Match-source keeps the foreground at native pixels and expands the
output by the configured frame padding. Source mode remains full-bleed and
does not emit a background node.

`export_preflight` returns structured info/warning/error issues scoped to an
output and, where available, a clip. Warnings stay visible but only errors block
submission. `export_run` writes a unique graph snapshot, reserves each output
independently, and queues jobs with `queued`, `rendering`, `mixing`,
`verifying`, `completed`, `failed`, or `cancelled` status. One failed output
does not stop siblings in the same batch.

The audio planner builds deterministic source, BGM, SFX, and voiceover inputs.
It applies source transition crossfades, timeline trim/delay, BGM looping,
voiceover sidechain ducking, channel/sample-rate normalization, a limiter, and
silence for sources without audio. MP4 uses AAC, WebM uses Opus, and GIF emits
an informational no-audio diagnostic.

FFmpeg writes a same-folder partial file. Completion is published only after
ffprobe validates dimensions, frame rate, duration, and stream shape and FFmpeg
decodes the whole artifact. The host then publishes the reserved final path;
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
  `export-artifact-verification.ts`.
- `ipc/export-binaries.ts` resolves packaged FFmpeg and ffprobe executables,
  including their unpacked application paths.

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
