# StoryCapture — Domain & Pipeline

The business layer: DSL grammar, the recording → encode → post-production
pipeline, the intelligence layer, and pointers to live planning state.
Read-on-demand.

## DSL (`.story` format)

pest grammar at `crates/story-parser/src/grammar.pest`, two-layer parse (lenient tokenize → semantic validation) with panic-mode recovery (D-09).

### Tier 1 verbs (Phase 1, shipped)

```
navigate "<url>"
click <target>
fill <target> with "<text>"
type <target> "<text>"
scroll <direction> [<count>]          # up | down | left | right
hover <target>
drag <target> to <target>
select <target> "<value>"
upload <target> "<path>"
wait <duration>                        # number + (ms | s | m)
wait-for <target> [timeout <duration>]
assert <target>
screenshot "<name>"
pause
```

### Tier 2 semantic targets (Phase 7, shipped)

Accessibility-first locators alongside CSS/XPath selectors:

```
click button "Save"
fill field "Email" with "admin@example.com"
click link "Dashboard"
click testid "btn-save"
click aria "Close dialog"
click text "Exactly this text"
select option "2024"
```

Target kinds (`grammar.pest` lines 104–124): `selector | testid | aria | role
| field | text | bare_text`. Supported ARIA roles: 21 normalized roles and 22
accepted spellings because `image` and `img` both normalize to `Image`:
`button, link, heading, image, img, checkbox, radio, tab, menuitem, menu,
option, combobox, listbox, dialog, alert, tooltip, switch, slider, row, cell,
navigation, main`.

Target postfix disambiguation:

```
click button "Save" nth 2
fill field "Email" nth 1 with "admin@example.com"
drag text "Card" nth 3 to text "Done" nth 1
```

`nth N` is 1-indexed. It parses on all targets, but runtime disambiguation is
honored only for Playwright-disambiguable locator tiers such as test id,
role+name, field/label, and exact text. Invalid `nth 0` is ignored with a
diagnostic rather than crashing legacy flows.

### step_id round-trip (Phase 7)

Trailing comment marks each command with a UUIDv7 step id:

```
navigate "https://app.example.com"   # @id=01arwx4enqzt94k58d90xh5w
click button "Login"                 # @id=01arwx4enqzt94k59aa0yp9f
```

- Format: `# @id=<uuidv7_text>` (grammar lines 59–63).
- Semantic: `LineMeta.step_id: Option<Uuid>` (`crates/story-parser/src/semantic.rs`).
- Legacy `.story` files without step ids still parse (`step_id == None`).
- `formatter::format_story()` preserves whitespace + comments on round-trip.
- Stamped on first pick via `picker_stamp_step_id` Tauri command.

### `.story.targets.json` (Phase 7 self-healing)

Sidecar file paired with each `.story`, keyed by step_id. Store: `crates/automation/src/targets_store.rs`.

```json
{
  "version": 1,
  "steps": {
    "01arwx4enqzt94k58d90xh5w": {
      "primary":   { "kind": "role",    "value": { "role": "button", "name": "Save" } },
      "fallbacks": [
        { "kind": "testid", "value": "btn-save" },
        { "kind": "text_exact", "value": "Save" }
      ]
    }
  }
}
```

- Atomic write: temp file + `sync_data()` + `fs::rename()`; orphan tmp cleanup on next write.
- Missing/empty file → `TargetsFile::empty()` (legacy-compatible, no error).
- Executor hook: on primary `wait_actionable()` timeout, promote first passing fallback → primary, demote old primary → `fallbacks[0]`, atomic rewrite. **`.story` source is never modified.**

## Recording pipeline (end-to-end)

```
.story file
  └─► story-parser::parse()              → Story AST + Diagnostics
       └─► automation::Executor           → drives BrowserDriver per command
            │   ├─► SmartSelector          → resolves against .story.targets.json
            │   ├─► targets_store          → self-heal fallback promotion
            │   └─► action/timing sidecars → .actions.json + .steps.json
            └─► BrowserDriver
                 └─► PlaywrightSidecarDriver  (JSON-RPC via stdio to Node SEA)
                      └─► Chromium via playwright-core CDP
  ┌─► capture::CapturePipeline              (parallel, started on record)
  │    ├─► SckBackend (macOS) / WgcBackend (Windows) / XcapBackend (fallback)
  │    ├─► target kinds: Display, Window, WindowByPid, DisplayRegion
  │    ├─► ByteBoundedQueue (default 256 MiB)
  │    ├─► one-shot thumbnails for picker/recorder preview
  │    └─► cpal+ringbuf audio (Phase 6)
  └─► encoder::EncodePipeline
       ├─► probe_encoders() → VideoToolbox | NVENC | QSV | AMF | libx264 | libopenh264
       ├─► FfmpegSidecar (static universal, bundled binary)
       └─► macOS: VT HEVC/H.264 fastpath (AVAssetWriter, CVPixelBuffer direct)
  → MP4 in project folder (ProjectFolder::EXPORTS_DIRNAME)

Browser session sync:
  Live Preview and Simulator run in the author-preview Playwright session.
  Record launches a separate recording Playwright context for native capture.
  Settings exposes a fixed-list browser language preference; `System default`
  preserves default browser/site behavior, while an explicit language requests
  Playwright locale plus `Accept-Language`. When Record starts, the host
  refreshes the latest author-preview `BrowserSessionProfile` and imports its
  browser environment plus Playwright storage state into the recording context
  when available. This keeps browser hints and persisted origin state aligned;
  it does not translate target text or guarantee a site supports the requested
  language.

Recording sidecars:
  <recording>.actions.json     semantic action timeline from automation
  <recording>.trajectory.json  best-effort OS cursor samples at ~60 Hz,
                                including click=true samples when available
  <recording>.steps.json       recording-relative step timing and target metadata

Post-production:
  build-timeline-from-story.ts → typed 5-track Clip union
  compute-graph.ts            → Effects Graph JSON
  effects::GraphBuilder       → Graph AST (canonical order)
    ├─► FfmpegEmit            → filter_complex string → FFmpeg render
    └─► PreviewEmit           → PreviewRenderPlan → WebGPU/WebGL2 preview

Render queue: encoder::RenderQueueActor drives MP4/WebM/GIF × resolution × quality fanout, persists jobs in project.sqlite. MP4 export defaults to libx264 for offline quality and keeps hardware encoders available as explicit/fast-path choices.

Web companion (Phase 4):
  upload to R2 (multipart presigned URLs, SSE-S3) → Prisma Video row → shareable /watch/<slug> + embed + analytics + desktop-web sync.
```

Recording encode hardening: `EncodeConfig` separates capture dimensions from
output dimensions and carries fit mode, pad color, scale algorithm, color
adjustment, quality preset, optional force-FFmpeg, keyframe interval, stdin
write timeout, first-frame timeout metadata, realtime mode, and
capture-dimension mismatch telemetry. Encodes stage to `.partial` and
atomically rename on success. macOS prefers VideoToolbox HEVC before H.264
when available and forces `hvc1` for QuickTime/Safari compatibility.

Post-production export encode reality (2026-05-03): recording-time
`EncodePipeline` can select hardware encoders via `probe_encoders()`, and the
post-production `RenderQueueActor` now uses an export-specific H.264 picker for
MP4: macOS auto export now prefers `libx264` over VideoToolbox because
VideoToolbox undershot bitrate on post-processed screen content; Windows still
prefers NVENC → QSV → AMF when available. The export UI can still request a
specific hardware encoder. Source-fill export omits the background/padded frame.
Framed `match-source` export expands the canvas by the frame padding so the
foreground can keep native source pixels instead of being scaled down inside a
1920x1080 canvas. `match-source` and custom export dimensions persist with each
render job, and advanced export options persist as per-job JSON so encoder
choice, CRF/CQ/bitrate, x264 preset, keyframe interval, downscale algorithm, and
audio settings reach FFmpeg argv after app restart. Single MP4 exports bypass
the FFV1 intermediate and render directly from `filter_complex` to MP4 with a final
`scale=...,fps=<target>,setpts=N/(<target>*TB)` timing stage plus
`-fps_mode cfr`. Background plates are also normalized with
`fps=<target>,setpts=N/<target>/TB` before they become the main input to
`overlay`; otherwise looped still-image backgrounds can impose their default
image cadence and make framed exports look like 30fps despite 60fps output
metadata. FFmpeg filters such as `zoompan`, `scale`, overlays, cursor PNG
sequence compositing, and `drawtext` remain CPU-bound unless a future export path
explicitly moves work to hardware filters. Export preprocessing now turns
`.trajectory.json` / `.actions.json` cursor sidecars and highlight overlay specs
into Rust-owned temp PNG assets before FFmpeg receives the graph, persists
`.export-graph-{batch_id}.json`, then enqueues one render job per batch output.
The hidden `STORYCAPTURE_POSTPROD_EXPORT_BACKEND` boundary can select the future
GPU compositor path, but that direct MP4 compositor is not implemented; the
FFmpeg filter graph is still the production backend.

Rounded-frame export tradeoff (2026-05-03): FFmpeg export intentionally treats
`Background.radius_px` as a no-op in
`crates/effects/src/background/rounded_frame.rs`. The old implementation used a
`format=rgba,geq=...pow(...)` alpha expression to cut rounded corners for every
pixel of every frame; on the 38.36s / 2302-frame VanTixS demo it dominated the
render and produced ~322s exports even with `h264_videotoolbox`. Replacing that
mask with `null` brought the same export down to ~11.7s. Preview/WebGPU may
still show rounded framing, but final FFmpeg exports currently have square
foreground corners. If a user asks why rounded video corners are missing in
export, or asks to restore bo tròn/rounded export, do not reintroduce per-frame
`geq`; implement a precomputed mask/alpha asset, GPU compositor, or another
measured fast path first.

When optimizing export performance, inspect
`crates/effects/src/background/rounded_frame.rs`,
`crates/encoder/src/queue/fanout_executor.rs`,
`crates/encoder/src/fanout/intermediate.rs`, and
`crates/encoder/src/fanout/multi_encode.rs`,
`crates/encoder/src/quality.rs`,
`apps/desktop/src-tauri/src/commands/render.rs`,
`apps/desktop/src/features/post-production/hooks/use-render-progress.ts`, and
`apps/desktop/src-tauri/src/commands/projects.rs::install_project_render_queue`.

## Storage and project model

- `storage::AppDb` stores global app-level data such as projects, recent state,
  and cross-project metadata.
- `storage::ProjectDb` stores per-project timeline/render/preset state.
- `storage::ProjectFolder` defines the on-disk project layout, including
  stories, exports, simulator artifacts, and sidecar files.
- `.scpreset` import/export and migrations live in the storage boundary, not in
  the Tauri host.

## Utility boundary

`crates/util` stays intentionally small. Today it mainly provides common helper
surfaces like content hashing and frame-drop callbacks used across crates.

## Effects AST & post-production model

`crates/effects/src/ast/` — `Graph { video: Vec<VideoNode>, audio: Vec<AudioNode> }`, `SCHEMA_VERSION = 2` for `.scpreset` compatibility.

- **5-track timeline:** Video | Cursor | Zoom | Sound | Annotations.
- **VideoNode variants:** `Source`, `ZoomPan`, `Background`,
  `CursorOverlay`, `RippleOverlay`, `HighlightOverlay`, `TextOverlay`,
  `Transition`.
- **AudioNode variants:** `AudioSource`, `Volume`, `Delay`, `Sidechain`,
  `Amix`, `Alimiter`.
- **CursorOverlay input:** final export consumes rendered PNG sequences.
  Export pre-processes `.trajectory.json` and `.actions.json` sidecars into a
  Rust-owned temp PNG sequence before FFmpeg receives the graph.
- **HighlightOverlay input:** final export pre-renders highlight overlay specs
  into temp PNG assets so FFmpeg can composite them like other image overlays.
- **Math primitives** (`effects/src/math/`): `min_jerk` (cursor smoothing), `spring` (zoom pan), `perlin` (natural jitter), `ease`, `lowpass`.
- **Cursor** (`effects/src/cursor/`): trajectory, compositor, 5 skins, click ripple, PNG sequence loading.
- **Auto-zoom** (`effects/src/zoom/`): click-tracking ken-burns; 3 presets (Dynamic/Calm/Subtle).
- **Background** (`effects/src/background/`): gradients, rounded frame, shadow.
  Preview can represent rounded frames; FFmpeg export currently skips the
  rounded mask for performance. See "Rounded-frame export tradeoff" above.
- **Sound library** (`assets/sound-library/`): scaffold for 20 target files
  (12 SFX + 8 BGM, 48kHz, -16 LUFS). The committed assets are placeholders;
  real CC0/CC-BY-4.0 curation and listen-test remain operator-gated by
  `02-08-RESUME.md`. Curation runbook: `scripts/curate-sound-library.md`.
- **Text/fonts:** 5 OFL-licensed fonts downloaded via `scripts/download-fonts.sh` (Geist, JetBrains Mono, …).
- **Presets:** `.scpreset` JSON (5 bundled: Dynamic / Calm / Subtle / Dramatic / Minimal). User presets persisted in `project.sqlite` + `~/.config/storycapture/presets/`.
- **Undo/redo:** 50-step ring buffer + 500ms coalescer in post-production Zustand slice.

## Intelligence layer (`crates/intelligence`)

- **`LlmProvider`** — `anthropic.rs` (streaming + prompt caching + tool-use), `openai.rs` (Chat Completions + `response_format: json_schema`). Event stream: `TextDelta`, `ToolUseComplete { index, input }`, `Usage { input, output, cache_read, cache_write }`.
- **NL→DSL orchestrator** (`nl/mod.rs`): system prompt + `emit_story_doc` tool schema + partial-JSON streaming accumulator + verb-whitelist retry + diff engine for per-step interactive refinement. Conversation state persisted per session (sqlite v5 migration).
- **`TtsProvider`** — ElevenLabs (6 curated voices), OpenAI TTS (6 built-in voices). Cache keyed on `(provider, voice, content_hash)`, sanitized paths, GC via Tauri command.
- **Voiceover ↔ timeline sync** + BGM auto-ducking on speech (Phase 3 Plan 12).
- **tower-lsp** (`lsp/`): `did_open`/`did_change` / diagnostics / hover / completion. Bridged to CodeMirror 6 via **Tauri IPC** (`lsp_request` command) — **not stdio** (avoids shell-escaping issues in packaged app).
- **Selector heuristic linter** (`lsp/selector_lint.rs`): 6 rules for common selector smells.
- **Dry-Run** (`dryrun/`): with `phase1-wired`, reuses automation's real
  `BrowserDriver` without capture/encode; default builds against a local trait
  stub to avoid circular dependencies. Per-step selector fallback attempts,
  wait-for timeouts, assertion results. Seconds-scale iteration.
- **`bin/eval_report`:** offline evaluation CLI against golden dataset (25 prompts in `tests/fixtures/golden/`).
- **Secrets:** `Redacted<T>` wrapper hides API keys in logs via custom `Display`. All provider keys in OS keychain via `keyring` crate (Stronghold is deprecated — do not use).
- **Verb-whitelist enforcement:** `scripts/verb-whitelist-grep.sh` validates golden fixtures against the canonical verb list.

## Web companion domain (`apps/web`)

Prisma models (12) + tRPC surface summary — details in `docs/ARCHITECTURE.md`.

- **Video lifecycle:** UPLOADING → PROCESSING → READY / FAILED. `uploadId` cleared on multipart completion.
- **RBAC:** `WorkspaceMember.role` ∈ {OWNER, EDITOR, VIEWER}; invite tokens with expiry.
- **Analytics:** `ViewEvent` (no-PII session id via httpOnly cookie, country via GeoIP) + `DailyVideoStats` materialized aggregates (cron-refreshed).
- **Templates:** 9 categories (SAAS_ONBOARDING, ECOMMERCE_CHECKOUT, API_WALKTHROUGH, MOBILE_DEMO, CLI_TOOL, LANDING_PAGE, FEATURE_ANNOUNCEMENT, BUG_REPRODUCTION, INTERNAL_TRAINING), system templates have `workspaceId = null`.
- **Desktop ↔ web sync:** `SyncedProject` mirrors desktop project metadata (desktopId, recordingStatus, lastSyncedAt). SSE with short-lived JWT (`/api/auth/mint-sse-jwt`).

## Live roadmap pointer

Do not duplicate the full phase ledger here. Read `.planning/STATE.md` for the
current snapshot, `.planning/POST-PROD-ROADMAP.md` for the active
post-production push, and per-phase summaries under `.planning/phases/` for
historical detail.

## References

- `docs/ARCHITECTURE.md` — repo layout, crate responsibilities, IPC, trait boundaries.
- `docs/CONVENTIONS.md` — coding conventions, testing, commits, GSD artifacts.
- `.planning/STATE.md` — current snapshot.
- `.planning/POST-PROD-ROADMAP.md` — active post-production roadmap.
- `.planning/ROADMAP.md` — historical phase breakdown with requirement IDs.
- `.planning/phases/NN-*/NN-CONTEXT.md` — phase-specific decision logs.
- `docs/CREDENTIALS.md` — secret/credential conventions.
