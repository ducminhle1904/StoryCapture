# StoryCapture — Domain & Pipeline

The business layer: DSL grammar, the recording → encode → post-production
pipeline, the intelligence layer, and a compact live roadmap summary.
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

Target kinds (`grammar.pest` lines 104–124): `selector | testid | aria | role | field | text | bare_text`. Supported ARIA roles (23): `button, link, heading, image, img, checkbox, radio, tab, menuitem, menu, option, combobox, listbox, dialog, alert, tooltip, switch, slider, row, cell, navigation, main`.

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
            │   └─► targets_store          → self-heal fallback promotion
            └─► BrowserDriver
                 └─► PlaywrightSidecarDriver  (JSON-RPC via stdio to Node SEA)
                      └─► Chromium via playwright-core CDP
  ┌─► capture::CapturePipeline              (parallel, started on record)
  │    ├─► SckBackend (macOS) / WgcBackend (Windows) / XcapBackend (fallback)
  │    ├─► target kinds: display, window, WindowByPid, region
  │    ├─► ByteBoundedQueue (default 256 MiB)
  │    ├─► one-shot thumbnails for picker/recorder preview
  │    └─► cpal+ringbuf audio (Phase 6)
  └─► encoder::EncodePipeline
       ├─► probe_encoders() → VideoToolbox | NVENC | QSV | AMF | libopenh264
       ├─► FfmpegSidecar (static universal, bundled binary)
       └─► macOS: vt_writer zero-copy fastpath (AVAssetWriter, CVPixelBuffer direct)
  → MP4 in project folder (ProjectFolder::EXPORTS_DIRNAME)

Post-production (Phase 2):
  effects::GraphBuilder  → Graph AST (canonical order: video → cursor → zoom → annotations → audio)
    ├─► FfmpegEmit    → filter_complex string → FFmpeg render
    └─► PreviewEmit   → PreviewRenderPlan → WebGPU/WebGL2 preview

Render queue: encoder::RenderQueueActor drives MP4/WebM/GIF × resolution × quality fanout, persists jobs in project.sqlite.

Web companion (Phase 4):
  upload to R2 (multipart presigned URLs, SSE-S3) → Prisma Video row → shareable /watch/<slug> + embed + analytics + desktop-web sync.
```

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

`crates/effects/src/ast.rs` — `Graph { video: Vec<VideoNode>, audio: Vec<AudioNode> }`, `SCHEMA_VERSION` for `.scpreset` compatibility.

- **5-track timeline:** Video | Cursor | Zoom | Sound | Annotations.
- **VideoNode variants:** `Background`, `Transition`, `Cursor`, `Zoom`, `TextOverlay`, plus primitives `Scale`, `Crop`, `Fade`, `SlideTransition`, `LetterBox`, `ZoomRectTracker`, `CursorTrajectory`.
- **AudioNode variants:** `AudioMix`, `Normalize`, `DuckOnSpeech`, `Crossfade`, `AudioClip`.
- **Math primitives** (`effects/src/math/`): `min_jerk` (cursor smoothing), `spring` (zoom pan), `perlin` (natural jitter), `ease`, `lowpass`.
- **Cursor** (`effects/src/cursor/`): trajectory, compositor, 5 skins, click ripple, PNG sequence loading.
- **Auto-zoom** (`effects/src/zoom/`): click-tracking ken-burns; 3 presets (Dynamic/Calm/Subtle).
- **Background** (`effects/src/background/`): gradients, rounded frame, shadow.
- **Sound library** (`assets/sound-library/`): 20 bundled CC0/CC-BY-4.0 files (12 SFX + 8 BGM, 48kHz, -16 LUFS). Curation runbook: `scripts/curate-sound-library.md`.
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
- **Dry-Run** (`dryrun/`): reuses Phase 1 Executor without capture/encode; per-step selector fallback attempts, wait-for timeouts, assertion results. Seconds-scale iteration.
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

## Live roadmap summary

Source of truth: `.planning/STATE.md`.

As of 2026-04-22:

- Phases 1-5 are code-complete, with remaining operator-gated verification on
  capture soak, release signing, audio curation, accounts walkthrough, and web
  integration walkthrough.
- Phase 6 shipped mic audio, region capture, and chrome-hiding foundations.
- Phase 7 semantic verbs, picker, step IDs, and self-healing targets are in
  code.
- Phase 9 live preview is code-complete.
- Phase 10 author-time simulator is code-complete.
- Phase 11 author-time picker relocation is partially landed in source and no
  longer belongs in the “planned from scratch” bucket.
- Phase 16 dependency refresh and Phase 17 recording lifecycle hardening are
  complete.

Do not duplicate the full phase ledger here. Read `.planning/STATE.md` for the
live milestone position and operator blockers.

## References

- `docs/ARCHITECTURE.md` — repo layout, crate responsibilities, IPC, trait boundaries.
- `docs/CONVENTIONS.md` — coding conventions, testing, commits, GSD artifacts.
- `.planning/STATE.md` — live status.
- `.planning/ROADMAP.md` — phase breakdown with requirement IDs.
- `.planning/phases/NN-*/NN-CONTEXT.md` — phase-specific decision logs.
- `docs/CREDENTIALS.md` — secret/credential conventions.
