# Phase 13: Video output customization knobs — Context

**Gathered:** 2026-04-19
**Status:** Ready for planning
**Source:** Interactive `/gsd-discuss-phase 13` with operator (Vietnamese)

<domain>
## Phase Boundary

**In scope (Phase 13):**
- Recording-time UI: expose 5 knobs (Resolution / FPS / Fit mode / Pad color / Quality preset) inside `apps/desktop/src/features/recorder/recording-view.tsx`.
- Export modal UI: expand `apps/desktop/src/features/post-production/export-modal/export-modal.tsx` with the 8 export-only knobs (Container / Codec / Rate control / HW encoder / Preset / Keyframe / Downscale algo / Audio params).
- Preset model (Standard / High Quality / Quick / Custom) shared between recording and export, driving the backend enums produced in Phase 12.
- Persistence via `tauri-plugin-store` (global defaults) + per-project override stored inside the `.story` project folder.
- Silent migration path from Phase 12 hard-coded defaults (1080p / 30 fps / Letterbox / Black / Med) so existing users see no behavioural change until they touch a knob.
- Bitrate + file-size-per-minute preview computed frontend-side from Phase 12's `pixel_based` heuristic + `QualityResolver` curves.
- Warnings UX: hard validation for Custom resolution evenness; soft warnings for `Lossless + 4K + HW encoder` bitrate risk and for `output > capture` no-upscale surprise.
- TypeScript IPC wrappers in `apps/desktop/src/ipc/capture.ts` + `apps/desktop/src/ipc/encode.ts` updated to forward the new knobs to Phase 12's already-added optional fields on `StartRecordingArgs` / export command.

**Explicitly out of scope (deferred):**
- User-defined custom presets (e.g. "My 4K preset") — backend `.scpreset`-style plumbing not in Phase 13.
- Separate "last export-modal settings" memory disconnected from the global preset.
- Blur-source pad (`PadColor::Blur`) — stays hidden entirely; will only appear when Phase 12's deferred backend support lands.
- Live frame-based thumbnail preview of the letterbox layout.
- HEVC / VP9 / AV1 codec switching, container switching beyond what Phase 12's `EncodeConfig` already supports, custom x264 opts passthrough.
- FPS split (`fps_target` capture vs `fps_output` encoder CFR) — still flagged from Phase 12 D-12-09.
- Any change to the Phase 12 quality curves themselves; Phase 13 only exposes them.

**Therefore:** Phase 13 is a frontend + persistence phase on top of Phase 12's backend enums/DTOs/filter chain. No encoder crate changes; no new IPC commands; only new fields already wired by Phase 12 (`OutputResolutionDto` / `FitModeDto` / `PadColorDto` / `QualityPresetDto` / `ScaleAlgoDto`) get exercised from the UI plus new persistence logic.

</domain>

<decisions>
## Implementation Decisions (locked in this discussion)

### Recording UI placement & visibility

**D-13-01: Inline `Video Output` section in Recording Setup panel.**
- Render the 5 knobs in a new section inside the existing Recording Setup panel in `recording-view.tsx`, positioned alongside `AudioDevicePicker`, `CursorToggle`, `ChromeHidingToggle` (same section style, same layout rhythm).
- Section only rendered before recording starts (gated by the same state guards the other controls use).
- **Why:** Consistent with existing pattern; discoverable; no extra modal click; matches shadcn/Base UI `base-vega` section design already in place.

**D-13-02: Persistent summary badge next to Record button.**
- Show a compact badge like `1080p • 30fps • Letterbox • Med` adjacent to the Record CTA.
- Clicking the badge scrolls/focuses the `Video Output` section (no modal).
- **Why:** Users always know what they're about to record; avoids "did I set this?" anxiety without consuming panel real-estate.

### Preset model

**D-13-03: Preset + override ("Standard / High Quality / Quick / Custom").**
- Single dropdown/select drives all 5 recording knobs to a named preset. Overriding any individual knob flips the active preset label to `Custom` automatically.
- Bundled presets (initial mapping — open to tweak during planning):
  - **Quick** — 720p / 30fps / Letterbox / Black / Low
  - **Standard** (default, matches Phase 12 seed) — 1080p / 30fps / Letterbox / Black / Med
  - **High Quality** — 1080p / 60fps / Letterbox / Black / High
  - **Custom** — whatever the user overrode to; persisted as a bag of 5 values.
- **Why:** Covers 80% of users with one click (preset) while keeping the escape hatch; matches Screen Studio / OBS expectations.

**D-13-04: Shared preset pool between recording and export.**
- The preset definitions live in a single state slice; both Recording View and Export Modal read from it.
- Recording consumes the 5 core knobs; Export adds 8 export-only knobs (Container / Codec / Rate control / HW encoder / Preset / Keyframe / Downscale / Audio) on top, independent of the recording preset selection.
- Changing a preset in either surface propagates to the other (single source of truth), so "record → edit → export" doesn't surprise users with different settings.
- **Why:** One mental model. Avoids the `recording preset` vs `export preset` divergence that OBS/ShareX struggle with.

### Persistence & migration

**D-13-05: Global defaults in `tauri-plugin-store` + per-project override in `.story` folder.**
- Global: `tauri-plugin-store` key (e.g. `output-prefs.v1`) holds `{ activePreset, customKnobs, exportKnobs }`.
- Per-project: optional override file next to the project (e.g. `<project>/.storycapture/output.json`), read-preference is project > global > Phase 12 default.
- **Not persisted in Phase 13:** user-defined preset names, separate "last export" memory.
- **Why:** Matches a developer workflow where different demo targets (YouTube vs Instagram vs internal) need different defaults per project, while the app-level default covers fresh projects.

**D-13-06: Silent migration — seed to Phase 12 defaults on first launch.**
- On first app launch after upgrading to the Phase 13 build, if the store key is missing, seed it with `{ 1080p / 30 / Letterbox / Black / Med }` so behaviour is bit-for-bit identical to the Phase 12 hard-coded defaults.
- No modal, no onboarding prompt, no "What's new" toast.
- **Why:** Operator priority is "don't interrupt"; users who care will discover the new section naturally via the summary badge.

### HW encoder + Custom resolution

**D-13-07: Auto + available-only HW encoder list.**
- Dropdown default: `Auto` (invokes existing `probe_encoders()` at render time).
- Remaining options: only HW encoders successfully probed on this machine, plus `Software (libx264)` as a universal fallback. Unavailable encoders do NOT appear (no grey-out, no teaser).
- Label format: `Auto` / `VideoToolbox (macOS)` / `NVENC (NVIDIA)` / `QSV (Intel)` / `AMF (AMD)` / `Software (libx264)`.
- **Why:** Keeps the UI honest — don't list what we can't do; Auto covers 99% of users; escape hatch for force-libx264 exists via the explicit option.

**D-13-08: Custom resolution via dropdown option + lazy-revealed W×H inputs.**
- Resolution dropdown options: `720p / 1080p / 1440p / 4K / Match Source / Custom`.
- Selecting `Custom` reveals two number inputs (W, H) with inline validation (both must be even + within `16..=7680 × 16..=4320`, matches Phase 12 D-12-03 `Custom { w, h }` constraints).
- Inline error message (Vietnamese-friendly) displayed adjacent to the failing input; submit/record gated while invalid.
- **Why:** Escape hatch (Instagram square, Twitter 1:1, custom monitor) without cluttering the default UI; validation happens in the same spot so users can self-correct.

### Pad color

**D-13-09: Segmented `Black / White / Custom` with native picker on Custom.**
- Segmented control (3 buttons) bound directly to backend `PadColor` enum: `Black`, `White`, `Custom { r, g, b }`.
- Selecting `Custom` reveals a `<input type="color">` (native OS color picker) alongside a hex text input (lowercase `#RRGGBB`). The two stay in sync; either can drive the value.
- **Why:** 1:1 mapping to backend enum; native picker saves re-inventing a swatch system; Vietnamese-friendly tooltip possible without redesigning anything.

**D-13-10: Blur pad hidden entirely.**
- `PadColor::Blur` is not offered in UI — not even as "coming soon".
- When Phase 12's deferred Blur backend ships, add it as a new segmented-control option; no UI rearrangement needed.
- **Why:** No fake promises; no dead UI. Easy future extension.

### Feedback & validation

**D-13-11: Bitrate + file-size-per-minute estimate shown below the knob group.**
- Text like `~8.3 Mbps • ~60 MB/min` (localized to Vietnamese number formatting as the UI copy dictates).
- Frontend-computed: `pixel_based_kbps = (output_w * output_h * 3) / 1000` (Phase 12 heuristic) × quality-preset multiplier from Phase 12 D-12-04 table (`~0.75` Low, `1.0` Med, `1.25` High, `1.5` Lossless). File-size per minute = `bitrate_kbps * 60 / 8 / 1024` MB.
- No IPC round-trip required — frontend already has enum values; reuse Phase 12's formula in a TypeScript helper.
- Recomputed live as the user edits knobs.
- **Why:** Teaches users how the knobs trade off without requiring an actual test recording.

**D-13-12: Warning matrix.**
- **Hard validation (block submit):**
  - Custom resolution W or H not divisible by 2, or outside `16..=7680 × 16..=4320`.
- **Soft warnings (inline note, do NOT block):**
  - `Lossless + output ≥ 4K + any HW encoder` → note about HW encoder bitrate caps and slow-render risk.
  - `Output dims > capture dims on any axis` → note explaining Phase 12 D-12-02 no-upscale behaviour (source stays native, letterbox fills the rest), so users don't think the app is "broken".
- **Why:** Hard validation protects FFmpeg / yuv420p invariants; soft warnings educate without being paternalistic; operator explicitly chose "show all three" over "clean UI, no warnings".

**D-13-13: No thumbnail / live-frame preview in Phase 13.**
- Deferred. Bitrate + file-size text is the only dynamic preview.
- **Why:** Live preview requires either a capture lifecycle side-channel or a canvas renderer and opens scope significantly; out of phase.

### Claude's Discretion

- **CD-13-01: Export modal layout — progressive disclosure (Basic / Advanced).**
  - Operator skipped the export-modal-structure gray area. Default: keep the current flat surface (`resolution-picker.tsx` + `format-checkboxes.tsx`) visible as "Basic", add a single collapsible "Advanced" group beneath it containing the 8 export-only knobs. One disclosure, not tabs, not a wizard.
  - Rationale: avoids overwhelming casual users; matches the lightweight feel the existing 428-line modal already has; if operator dislikes it during review, it's a styling change not an architectural one.

- **CD-13-02: Preset bundle values.** Initial `Quick / Standard / High Quality` tuples are a best-guess starting point. If planning research surfaces stronger conventions (Screen Studio reference numbers, OBS defaults), planner may adjust without re-entering discuss-phase.

- **CD-13-03: Copywriting & Vietnamese labels.** All user-facing strings in Vietnamese consistent with the rest of the desktop UI; exact wording left to planning/execution.

- **CD-13-04: Export-only knob defaults.** Container / Codec / Rate control / HW encoder / Preset / Keyframe / Downscale / Audio defaults are left to planning (anchored to Phase 12 behaviour: MP4 / H.264 / CBR-via-`pixel_based` / Auto / `medium` preset / 2s keyframe / Lanczos / 160 kbps AAC stereo).

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase 12 (backend enums + DTOs this phase consumes — locked, do NOT re-discuss)
- `.planning/phases/12-fix-video-output-resolution-lock-letterbox/12-CONTEXT.md` — full Phase 12 decision record (D-12-01..12). **Read before touching any knob — the enums, quality curves, and fit-mode semantics are locked here.**
- `.planning/phases/12-fix-video-output-resolution-lock-letterbox/12-RESEARCH.md` — research notes that led to the letterbox chain + per-encoder quality mapping.
- `.planning/phases/12-fix-video-output-resolution-lock-letterbox/12-0{1..5}-PLAN.md` — 5 plans across 3 waves delivering `filters.rs`, `QualityResolver`, `EncodeConfig` refactor, IPC DTOs, and real-ffmpeg integration tests. Source of truth for the types Phase 13 will consume.

### Desktop frontend code Phase 13 modifies
- `apps/desktop/src/features/recorder/recording-view.tsx` — 1263-line Recording View; Phase 13 adds the `Video Output` section here.
- `apps/desktop/src/features/recorder/AudioDevicePicker.tsx`, `CursorToggle.tsx`, `ChromeHidingToggle.tsx` — **layout/pattern reference** for the new `Video Output` section. Match their structure and styling (shadcn/Base UI, `base-vega`).
- `apps/desktop/src/features/post-production/export-modal/export-modal.tsx` — 428-line export modal; Phase 13 adds the Advanced disclosure and 8 export-only knobs.
- `apps/desktop/src/features/post-production/export-modal/resolution-picker.tsx` (56 LOC) + `format-checkboxes.tsx` — existing Basic-section components; Phase 13 either reuses or refactors these to share the preset model.
- `apps/desktop/src/features/post-production/state/export-slice.ts` (61 LOC) — existing Zustand slice for export; Phase 13 extends it (or adds a sibling slice) to hold the new preset state.
- `apps/desktop/src/state/recorder.ts` — recorder state; may need a new sub-slice for `Video Output` preset if not held in a shared slice.
- `apps/desktop/src/ipc/capture.ts`, `apps/desktop/src/ipc/encode.ts` — TS wrappers around Tauri `invoke`. Phase 12 already added optional fields to `StartRecordingArgs` / export command; Phase 13 passes them.

### IPC + generated types (Phase 12 already produced these — do NOT regenerate)
- `apps/desktop/src-tauri/src/ipc_spec.rs` — `collect_commands!` registration; Phase 12 added `OutputResolutionDto`, `FitModeDto`, `PadColorDto`, `QualityPresetDto`, `ScaleAlgoDto`. No new types needed in Phase 13.
- `packages/shared-types/src/ipc.ts` — auto-generated by `tauri-specta`; **never hand-edit**. Regenerated via `pnpm -w gen-ipc` or Tauri build.

### Persistence plumbing to add
- `tauri-plugin-store` (JS side: `@tauri-apps/plugin-store`) — validated in project stack (`CLAUDE.md` Technology Stack table). Currently unused in the repo (only TODO references in `apps/desktop/src/lib/theme.ts:5` and `apps/desktop/src/features/editor/split-pane.tsx:4`); Phase 13 introduces the first production use.
- Per-project override file — new schema under `<project>/.storycapture/output.json`; planner must define a typed reader/writer and a precedence rule (`project > global > Phase 12 default`).

### Project-wide contracts
- `CLAUDE.md` — **no workarounds, no co-authored-by, Vietnamese replies, concise comments, plan before big changes**. Phase 13 is frontend-only + persistence, qualifies as "moderate" — planning step must still enumerate files and risks.
- `docs/CONVENTIONS.md` — Zustand monolithic-per-feature rule (post-production is the documented slice-composed exception). Phase 13's preset state should follow the feature-level convention; if it must cross recorder↔post-production features, document it explicitly.
- `docs/ARCHITECTURE.md` — Phase 13 does NOT change any trait boundaries; pure UI + persistence layer.

### Pattern references (sibling features to mimic)
- `.planning/phases/06-recording-v2-audio-region-capture-chrome-hiding-multi-browse/` — introduced the current Recording Setup panel pattern (AudioDevicePicker / CursorToggle / ChromeHidingToggle). Phase 13's `Video Output` section is the newest sibling in that group.
- `.planning/phases/02-cinematic-post-production-export/` — Post-production preset system (`.scpreset`) for a precedent of "preset + override" model, though Phase 13 does NOT reuse the `.scpreset` format (that's per-project effect presets, not output knobs).

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable assets
- **Recording Setup panel pattern** (`features/recorder/recording-view.tsx` + `AudioDevicePicker.tsx` + `CursorToggle.tsx` + `ChromeHidingToggle.tsx`) — Phase 13's `Video Output` section plugs into the same layout/rhythm.
- **Export modal scaffold** (`export-modal.tsx` + `resolution-picker.tsx` + `format-checkboxes.tsx`) — Basic section already exists; Phase 13 adds an Advanced disclosure alongside.
- **Phase 12 backend** — `FilterSpec`, `QualityResolver`, `EncodeConfig`, `OutputResolution`, `FitMode`, `PadColor`, `QualityPreset`, `ScaleAlgo` already typed and tested; Phase 13 only renders them.
- **IPC DTOs** already emitted via `tauri-specta`; TS types are "free" for Phase 13.
- **shadcn/Base UI (`base-vega`) primitives** — segmented control / select / input / accordion patterns already in use elsewhere in the app; reuse existing components, no new primitive introductions.

### Established patterns
- **Zustand feature-monolithic slices** (`docs/CONVENTIONS.md`) — recording and post-production each own their state; Phase 13 preset model must either live in a shared slice or be duplicated/synced across features. Planning must pick deliberately.
- **Hard-coded defaults in Phase 12 callers** (`commands/encode.rs`, `commands/capture.rs`, `tools/e2e-playwright-capture/src/main.rs`) — Phase 13 replaces these with values read from the new preset state + `tauri-plugin-store`. No backend change; just call site refactor on the Rust side is NOT in scope — the optional IPC fields get filled from the TS side.
- **Biome lint + rustfmt/clippy + cargo-nextest** (CLAUDE.md Conventions) — apply normally.

### Integration points
- `recording-view.tsx` Recording Setup section → add new `<VideoOutputSection />` component alongside existing pickers.
- `export-modal.tsx` → add `<AdvancedOutputOptions />` collapsible beneath the current Basic form.
- Record-button header / HUD → embed new `<OutputSummaryBadge />`.
- `ipc/capture.ts` / `ipc/encode.ts` → thread the new knob values into existing optional `StartRecordingArgs` fields (Phase 12 already defined them).
- `tauri-plugin-store` init happens in `apps/desktop/src-tauri/src/lib.rs` (plugin registration) + a TS singleton client; planning must decide where the `output-prefs.v1` schema owner lives.

</code_context>

<specifics>
## Specific Ideas

### Summary badge copy format
`1080p • 30fps • Letterbox • Med` — four segments, bullet separator, left-to-right priority (resolution first because it changes most often). Custom resolutions render as `1280×720` instead of a preset name. Pad color appears only when non-default (Black is implied).

### Preset → knob mapping (starter values, planner may refine)
| Preset       | Resolution | FPS | Fit        | Pad   | Quality |
|--------------|------------|-----|------------|-------|---------|
| Quick        | 720p       | 30  | Letterbox  | Black | Low     |
| Standard     | 1080p      | 30  | Letterbox  | Black | Med     |
| High Quality | 1080p      | 60  | Letterbox  | Black | High    |
| Custom       | —          | —   | —          | —     | —       |

### Bitrate preview formula (frontend, TS)
```ts
const pixelBasedKbps = (w * h * 3) / 1000;
const qMul = { Low: 0.75, Med: 1.0, High: 1.25, Lossless: 1.5 }[quality];
const bitrateKbps = pixelBasedKbps * qMul;
const mbPerMinute = (bitrateKbps * 60) / 8 / 1024;
// render: `~${(bitrateKbps/1000).toFixed(1)} Mbps • ~${mbPerMinute.toFixed(0)} MB/min`
```
Matches Phase 12 D-12-04 curves 1:1 (VideoToolbox `maxrate` multiplier, NVENC `b:v` multiplier).

### Persistence schema (store key `output-prefs.v1`)
```jsonc
{
  "activePreset": "Standard",           // | "Quick" | "High Quality" | "Custom"
  "recordingKnobs": {
    "resolution": { "kind": "P1080" }, // | { kind: "Custom", w, h } | { kind: "MatchSource" }
    "fps": 30,
    "fit": "Letterbox",
    "pad": { "kind": "Black" },        // | { kind: "Custom", r, g, b }
    "quality": "Med"
  },
  "exportKnobs": {
    "container": "MP4",
    "codec": "H264",
    "rateControl": "Auto",
    "hwEncoder": "Auto",
    "preset": "medium",
    "keyframeSec": 2,
    "downscaleAlgo": "Lanczos",
    "audio": { "codec": "AAC", "bitrateKbps": 160, "channels": 2 }
  },
  "version": 1
}
```
Per-project override at `<project>/.storycapture/output.json` uses the same shape minus `version`; any missing field falls through to the global store.

### Warning copy (Vietnamese-leaning, planner to finalize)
- **Hard (Custom res even):** "Chiều rộng/cao phải là số chẵn và trong khoảng 16–7680 × 16–4320."
- **Soft (Lossless+4K+HW):** "Chất lượng Lossless ở 4K với HW encoder có thể vượt bitrate cap phần cứng và khiến render chậm. Cân nhắc giảm xuống High hoặc chuyển sang Software (libx264)."
- **Soft (Output > Capture):** "Nguồn ghi nhỏ hơn kích thước output — video sẽ giữ nguyên kích thước nguồn và thêm viền thay vì phóng to (không làm mờ text)."

</specifics>

<deferred>
## Deferred Ideas

- **User-defined named presets** (save-as "My 4K preset", show up in dropdown) — scope and persistence story too big for Phase 13; revisit when preset library patterns are proven.
- **Separate last-used memory for export-only knobs** — initial decision is "shared pool drives both"; revisit if users complain that tweaking export accidentally changes recording defaults.
- **Blur-source pad UI** — blocked on Phase 12 backend `PadColor::Blur` support; when that lands, add to segmented control.
- **Live frame-based thumbnail / letterbox preview** — requires capture lifecycle side-channel or canvas renderer; out of Phase 13 scope. Revisit as part of a future "output preview" phase.
- **FPS split** (`fps_target` capture vs `fps_output` encoder CFR) — carried over from Phase 12 D-12-09; still deferred.
- **HEVC / VP9 / AV1 codec switching, container switching, custom x264 opts passthrough** — carried over from Phase 12 deferred list.
- **Onboarding modal / "What's new" toast** — operator rejected in favour of silent migration; revisit only if telemetry / user feedback suggests the new section is undiscoverable.
- **Grey-out unavailable HW encoders with "Requires NVIDIA GPU" tooltip** — current decision is "hide entirely"; revisit if support questions spike.

</deferred>

---

*Phase: 13-video-output-customization-knobs-recording-export-ui*
*Context gathered: 2026-04-19 via /gsd-discuss-phase (interactive, Vietnamese)*
*Operator decisions locked D-13-01..13 + Claude's Discretion CD-13-01..04*
