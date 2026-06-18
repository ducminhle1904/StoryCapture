# StoryCapture - Domain & Pipeline

The business layer: DSL grammar, browser automation, recording/export,
post-production, AI/TTS surfaces, and web companion sync.

## DSL (`.story`)

Stories describe browser actions and post-production intent.

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

`nth N` is 1-indexed and used to disambiguate repeated targets.

## Sidecars

StoryCapture uses JSON sidecars next to projects and recordings:

- `.story.targets.json` stores primary/fallback selector targets keyed by step.
- `.actions.json` stores action/timing events from a recording.
- `.trajectory.json` stores cursor movement data.
- `.steps.json` stores step timing summaries.
- `.storycapture/output.json` stores per-project output preferences.
- Optional `<story>.polish.json` stores post-production intent edited in UI mode.

## Desktop Pipeline

```text
.story source
  -> Electron IPC parser/simulator helpers
  -> browser automation in the Electron host
  -> native browser/screen capture in Electron
  -> FFmpeg via ffmpeg-static
  -> post-production graph/export
  -> optional web upload/share
```

The Electron host in `apps/desktop/electron/ipc.ts` owns the runtime behavior
that used to be provided by the native host: project file access, automation,
recording, export, logging, settings, provider key plumbing, upload/sync, and
Tauri-compatible plugin commands.

## Recording And Export

- Recording captures frames from the active browser/session surface.
- Audio is optional and merged during FFmpeg export.
- Export uses `ffmpeg-static`; local hardware encoder selection is surfaced in
  the export UI where available.
- Recording sidecars feed cursor, zoom, callout, highlight, and sound defaults
  in post-production.

## Post-Production

The editor owns a typed timeline with video, cursor, zoom, sound, and
annotation tracks. `features/post-production/state/compute-graph.ts` projects
timeline state into the export graph consumed by the Electron host.

Preview is renderer-side and uses WebGPU where available, with WebGL fallback.

## AI / NL / TTS

AI provider setup is intentionally credential-gated. The app exposes UI and IPC
surfaces for:

- Natural-language editing and diff cards.
- Voice catalog and TTS clip generation.
- API-key storage through the desktop settings surface.

Provider credentials are not committed and are handled manually by the operator.

## Web Companion

The web app supports sharing, watch/embed pages, workspace dashboards, invites,
analytics aggregation, R2 uploads, and desktop sync endpoints.
