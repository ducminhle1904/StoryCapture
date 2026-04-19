# Phase 13: Video output customization knobs — Research

**Researched:** 2026-04-19
**Domain:** Desktop UI (React 19 + Base UI) + frontend persistence (`tauri-plugin-store`) on top of the Phase 12 encoder backend
**Confidence:** HIGH (stack and backend surface are fully locked; the one MEDIUM area is the tauri-plugin-store migration pattern, covered below)

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

Copied verbatim from `13-CONTEXT.md` `<decisions>` (D-13-01..13). The planner MUST honor every one of these without re-deriving alternatives.

#### Recording UI placement & visibility

- **D-13-01** — Inline `Video Output` section inside the existing Recording Setup panel in `recording-view.tsx`, rendered alongside `AudioDevicePicker` / `CursorToggle` / `ChromeHidingToggle`, gated by the same pre-record state guards. Same section style, same layout rhythm. `[CITED: 13-CONTEXT.md D-13-01]`
- **D-13-02** — Persistent summary badge `1080p • 30fps • Letterbox • Med` next to the Record CTA; clicking scrolls/focuses the Video Output section (no modal). Custom resolutions render as `1280×720` (literal dims); pad color appears only when non-default. `[CITED: 13-CONTEXT.md D-13-02 + Specifics]`

#### Preset model

- **D-13-03** — Preset + override model (`Standard` / `High Quality` / `Quick` / `Custom`). Single select drives all 5 recording knobs; overriding any individual knob flips the active preset label to `Custom` automatically. Starter bundles:
  - **Quick** — 720p / 30fps / Letterbox / Black / Low
  - **Standard** (default, matches Phase 12 seed) — 1080p / 30fps / Letterbox / Black / Med
  - **High Quality** — 1080p / 60fps / Letterbox / Black / High
  - **Custom** — bag of 5 overridden values. `[CITED: 13-CONTEXT.md D-13-03]`
- **D-13-04** — Shared preset pool between recording and export. Preset definitions live in a single state slice; Recording View reads 5 core knobs, Export Modal reads the same 5 + 8 export-only knobs. Changing a preset in either surface propagates to the other (single source of truth). `[CITED: 13-CONTEXT.md D-13-04]`

#### Persistence & migration

- **D-13-05** — Global defaults in `tauri-plugin-store` (key `output-prefs.v1`) holds `{ activePreset, recordingKnobs, exportKnobs, version }`. Optional per-project override at `<project>/.storycapture/output.json` (same shape minus `version`). Precedence: **project > global > Phase 12 hard-coded default**. Not persisted in Phase 13: user-defined preset names, separate "last export" memory. `[CITED: 13-CONTEXT.md D-13-05]`
- **D-13-06** — Silent migration: on first launch after upgrade, if the store key is missing, seed `{ 1080p / 30 / Letterbox / Black / Med }` + default export knobs so behaviour is bit-for-bit identical to Phase 12. No modal, no onboarding prompt, no "What's new" toast. `[CITED: 13-CONTEXT.md D-13-06]`

#### HW encoder + Custom resolution

- **D-13-07** — HW encoder picker: default `Auto` (invokes existing `probe_hw_encoders()` at render time). Remaining options = only encoders successfully probed on this machine, plus `Software (libx264)` as universal fallback. Unavailable encoders do NOT appear (no grey-out). Labels: `Auto` / `VideoToolbox (macOS)` / `NVENC (NVIDIA)` / `QSV (Intel)` / `AMF (AMD)` / `Software (libx264)`. `[CITED: 13-CONTEXT.md D-13-07]`
- **D-13-08** — Resolution dropdown: `720p / 1080p / 1440p / 4K / Match Source / Custom`. Selecting `Custom` reveals W + H number inputs with inline validation (both even + within `16..=7680 × 16..=4320`; matches Phase 12 D-12-03). Inline error adjacent to the failing input; submit/record gated while invalid. `[CITED: 13-CONTEXT.md D-13-08]`

#### Pad color

- **D-13-09** — Segmented `Black / White / Custom` bound 1:1 to the backend `PadColor` enum. `Custom` reveals a `<input type="color">` + synced lowercase `#RRGGBB` hex text input (either drives the value). `[CITED: 13-CONTEXT.md D-13-09]`
- **D-13-10** — `PadColor::Blur` is hidden entirely (not even "coming soon"). When Phase 12's deferred Blur backend ships, add a new segmented-control option. `[CITED: 13-CONTEXT.md D-13-10]`

#### Feedback & validation

- **D-13-11** — Bitrate + file-size-per-minute estimate shown below the knob group, recomputed live. Frontend-computed from Phase 12 heuristic:
  ```ts
  const pixelBasedKbps = (w * h * 3) / 1000;
  const qMul = { Low: 0.75, Med: 1.0, High: 1.25, Lossless: 1.5 }[quality];
  const bitrateKbps = pixelBasedKbps * qMul;
  const mbPerMinute = (bitrateKbps * 60) / 8 / 1024;
  ```
  No IPC round-trip. `[CITED: 13-CONTEXT.md D-13-11]`
- **D-13-12** — Warning matrix:
  - **Hard (blocks submit):** Custom resolution W or H not divisible by 2, or outside `16..=7680 × 16..=4320`.
  - **Soft (inline, does NOT block):** `Lossless + output ≥ 4K + any HW encoder`; `Output dims > capture dims on any axis` (no-upscale explainer, Phase 12 D-12-02).
  `[CITED: 13-CONTEXT.md D-13-12]`
- **D-13-13** — No thumbnail / live-frame preview in Phase 13; bitrate + file-size text is the only dynamic preview. `[CITED: 13-CONTEXT.md D-13-13]`

### Claude's Discretion

- **CD-13-01** — Export modal layout: progressive disclosure (Basic / Advanced). Keep current flat `resolution-picker.tsx` + `format-checkboxes.tsx` visible as "Basic"; add single collapsible "Advanced" group beneath it containing the 8 export-only knobs. One disclosure, not tabs, not a wizard. Planner may refine styling.
- **CD-13-02** — Preset bundle values. Starter `Quick / Standard / High Quality` tuples are best-guess; planner may adjust based on conventions (see "Preset bundle tuning" below).
- **CD-13-03** — All user-facing strings in Vietnamese, consistent with rest of desktop UI.
- **CD-13-04** — Export-only knob defaults anchored to Phase 12 behaviour: MP4 / H.264 / CBR-via-`pixel_based` / Auto HW / `medium` preset / 2s keyframe / Lanczos / 160 kbps AAC stereo.

### Deferred Ideas (OUT OF SCOPE)

Copied verbatim from `13-CONTEXT.md` `<deferred>`:

- User-defined named presets (save-as "My 4K preset")
- Separate last-used memory for export-only knobs
- Blur-source pad UI (wait on Phase 12 backend `PadColor::Blur`)
- Live frame-based thumbnail / letterbox preview
- FPS split (`fps_target` capture vs `fps_output` encoder CFR) — carried from Phase 12 D-12-09
- HEVC / VP9 / AV1 codec switching, container switching beyond what Phase 12 `EncodeConfig` supports, custom x264 opts passthrough
- Onboarding modal / "What's new" toast
- Grey-out unavailable HW encoders with "Requires NVIDIA GPU" tooltip

**The planner MUST NOT** create plans for any item in this list.
</user_constraints>

<phase_requirements>
## Phase Requirements

`.planning/REQUIREMENTS.md` currently lists only `ENC-01..11`. Phase 13 is not yet enumerated there, so this research proposes stable IDs the planner can register before writing PLAN.md files. `[VERIFIED: .planning/REQUIREMENTS.md:50-60]`

| ID | Description | Research Support |
|----|-------------|------------------|
| **ENC-12** | Expose the 5 recording-time output knobs (Resolution / FPS / Fit mode / Pad color / Quality preset) in the Recording Setup panel, bound 1:1 to Phase 12's `OutputResolutionDto` / `FitModeDto` / `PadColorDto` / `QualityPresetDto` enums. | D-13-01, D-13-08, D-13-09; "UI surface map" below; `ipc_spec.rs:171-177` already registers the DTOs. |
| **ENC-13** | Expose the 8 export-only knobs (Container / Codec / Rate control / HW encoder / Preset / Keyframe / Downscale algo / Audio params) inside the existing Export modal as an `Advanced` collapsible. | CD-13-01, CD-13-04; "Export-only knob defaults" table below. |
| **ENC-14** | Implement the `Standard / High Quality / Quick / Custom` preset model, shared between Recording View and Export Modal; overriding any knob flips the active preset to `Custom`. | D-13-03, D-13-04; "Preset state architecture" below. |
| **ENC-15** | Persist output prefs in `tauri-plugin-store` under key `output-prefs.v1` (global) with a silent-seed migration from Phase 12 defaults on first launch; add optional per-project override at `<project>/.storycapture/output.json` with precedence `project > global > Phase 12 default`. | D-13-05, D-13-06; "Persistence schema + migration" below. |
| **ENC-16** | HW encoder picker shows probe-driven available list + `Software (libx264)` fallback; unavailable encoders are hidden (no grey-out). | D-13-07; "HW encoder probe integration" below. |
| **ENC-17** | Bitrate + file-size-per-minute estimate shown below the knob group, recomputed live using Phase 12's `pixel_based` formula × quality multiplier. | D-13-11; "Bitrate preview formula" in CONTEXT.md `<specifics>`. |
| **ENC-18** | Warning matrix — hard validation blocks submit on Custom resolution even/range violations; soft warnings for `Lossless + 4K + HW` and `output > capture`. | D-13-12; Phase 12 D-12-02 no-upscale semantics. |
| **ENC-19** | Persistent summary badge (`1080p • 30fps • Letterbox • Med`) next to the Record button; clicking scrolls/focuses the Video Output section. | D-13-02. |

Planner should register these IDs in `.planning/REQUIREMENTS.md` during Plan 13-01 (or wire them into the first plan that lands code touching each surface).
</phase_requirements>

---

## Summary

- **Phase 13 is frontend + persistence only.** Phase 12 already shipped the five IPC DTOs (`OutputResolutionDto`, `FitModeDto`, `PadColorDto`, `QualityPresetDto`, `ScaleAlgoDto`) as optional serde-default fields on `StartRecordingArgs`, plus the backend filter chain, `QualityResolver`, and per-encoder quality maps. Phase 13 ships zero Rust encoder/IPC work — only UI wiring + one new persistence plumbing plus (likely) optional fields on the existing `ExportRunArgs`. `[VERIFIED: .planning/phases/12-fix-video-output-resolution-lock-letterbox/12-04-PLAN.md:207-225, apps/desktop/src-tauri/src/ipc_spec.rs:171-177]`
- **`tauri-plugin-store` must be added to the project.** It is listed in `CLAUDE.md` as validated stack but currently is NOT installed (`apps/desktop/package.json` has no `@tauri-apps/plugin-store` entry; the only prior usage is two TODO comments). This is Phase 13's first production use — Plan 13-01 (or similar) must add the plugin, register it in `lib.rs`, and ship the schema + migrator. `[VERIFIED: apps/desktop/package.json; grep shows only TODO refs in apps/desktop/src/lib/theme.ts:5 and apps/desktop/src/features/editor/split-pane.tsx:4]`
- **No new IPC commands needed for recording.** The existing `start_recording` command already accepts the 5 optional DTOs. Phase 13's `capture.ts` / `encode.ts` wrappers gain serialization of the 5 fields — no new commands, no new Rust types. `[CITED: 12-04-PLAN.md task 3, lines 207-249]`
- **Export-only knobs likely need IPC extension.** The current `ExportRunArgs` passes only `format / resolution / fps / quality` per output (`apps/desktop/src/ipc/export.ts:22-31`). The 8 new export-only knobs (container / codec / rate control / HW encoder / preset / keyframe / downscale / audio) are NOT yet modelled in `ExportOutputDto`. Planner must decide: (a) extend `ExportOutputDto` with optional serde-default fields matching the Phase 12 / 13 additions, or (b) serialize a bundled `ExportEncoderOptionsDto` sub-struct. **Recommended: (b)** — cleaner contract, matches how Phase 12 already grouped Phase 13-bound fields via optional additives. See "IPC surface — Export command extension" section.
- **tauri-plugin-store has NO built-in version migration primitive.** It is a bare KV JSON store. Migration is a userland concern: read the store, check the `version` field, run migrators from `v -> v+1`, write back. Idiomatic pattern in the Tauri ecosystem is a TypeScript-side migrator module called once on app startup. `[CITED: context7 /tauri-apps/plugins-workspace query confirmed no migration API for plugin-store; this contrasts with plugin-sql which has a dedicated `Migration`/`MigrationKind` type]`
- **Zustand + slice placement.** Shared preset state between Recording View and Export Modal violates the default "monolithic-per-feature" rule. `docs/CONVENTIONS.md` documents post-production as the already-documented slice-composed exception. Phase 13 is the *second* such exception — planner must place the shared preset slice in a neutral location (recommend `apps/desktop/src/state/output-prefs.ts` as a top-level store, NOT inside either feature folder) and document the exception in CONVENTIONS.md per the "Keep Agent Docs In Sync" rule.
- **UI primitives are sparse.** Currently only `Button`, `Select`, and `dialog-motion.ts` helpers exist under `apps/desktop/src/components/ui/`. Phase 13 needs: segmented control (pad color picker), disclosure/accordion (CD-13-01 Advanced collapsible), number input with inline validation (custom W/H), color input (native `<input type="color">`), slider (CQ/CRF/bitrate). Planner should scaffold via `npx shadcn add` with Base UI variants (`base-vega`) — no new primitive authoring from scratch where a shadcn/Base UI registry item exists.
- **Vietnamese copy throughout.** CD-13-03 locks user-facing labels to Vietnamese. Plan 13-01 (or dedicated copy plan) should establish a constants file (e.g. `features/output-prefs/copy.ts`) so translations are centralized, not scattered inline.
- **No new backend tests needed.** Phase 12 already covers the encoder surface with `insta` snapshots + `real-ffmpeg` gated integration tests. Phase 13 testing is entirely frontend: Vitest + `@testing-library/react` for the new components, `mockIPC` for `start_recording` / `export_run` wiring, unit tests for the migrator + the bitrate preview formula.

**Primary recommendation:** Treat Phase 13 as a UI-shaped phase with one cross-cutting persistence concern. Break into ~5 plans across 3 waves, with Wave 0 adding `tauri-plugin-store` + scaffold primitives, Wave 1 building the preset slice + persistence + migrator (the one infrastructure plan that blocks everything else), and Waves 2–3 shipping the Recording UI and Export UI in parallel. The summary badge + warnings can share Wave 3 with the Export UI.

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|--------------|----------------|-----------|
| Recording knobs UI (5 knobs) | Frontend (React) | — | Pure presentation + state; backend already accepts the values via `StartRecordingArgs`. |
| Export Advanced knobs UI (8 knobs) | Frontend (React) | API/Backend (`export_run` args) | Frontend renders; backend must receive the new fields through `ExportOutputDto` / `ExportRunArgs`. |
| Preset state (shared) | Frontend (Zustand slice) | — | Ephemeral + persisted-via-effect; no backend involvement. |
| Persistence (global) | Frontend (`@tauri-apps/plugin-store`) | Backend (plugin registration only, one line in `lib.rs`) | Plugin is JS-accessible; Rust only registers it. |
| Persistence (per-project) | Frontend (Tauri `plugin-fs` read/write) | Backend (plugin-fs permissions scope) | Uses existing `tauri-plugin-fs`; no new command. |
| Migration (silent seed) | Frontend (userland migrator module) | — | plugin-store has no built-in versioning; migrator runs on app startup. |
| HW encoder probe | Backend (`probe_hw_encoders`, already exists) | Frontend (cached via TanStack Query at render time) | Existing Rust command + TS wrapper (`probeHwEncoders()` at `ipc/encode.ts:64`). |
| Bitrate + file-size preview | Frontend (pure TS computation) | — | No IPC; reuses Phase 12 `pixel_based` heuristic + D-12-04 quality multipliers. |
| Warnings matrix | Frontend (validation hook) | — | Hard validation = form-level; soft warnings = derived from current knob state. |
| Summary badge | Frontend (derived state) | — | Reads preset slice, renders string, scrolls on click. |

**Why this matters:** Phase 13 has no distributed-system concerns. Misassignment risk is negligible except for one case — the `export_run` IPC extension (ENC-13) is a backend-touching change that's easy to miss if the planner assumes "UI phase = no Rust edits."

---

## Standard Stack

### Core (already installed — consume these)

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `react` / `react-dom` | 19.x | UI runtime | Phase baseline. `[VERIFIED: CLAUDE.md stack table]` |
| `zustand` | 5.x | Shared preset slice | Standard state layer per `docs/CONVENTIONS.md`. `[VERIFIED: apps/desktop/package.json]` |
| `@tanstack/react-query` | 5.x | Caching `probeHwEncoders()` at render time (D-13-07) | Canonical IPC cache wrapper per CONVENTIONS.md. `[VERIFIED: AudioDevicePicker.tsx:119 pattern]` |
| `@base-ui-components/react` | 1.x (beta.6) | `Select`, `Dialog`, `Accordion` primitives | shadcn + Base UI is the locked choice (NOT Radix). `[VERIFIED: apps/desktop/package.json, components/ui/select.tsx:13]` |
| `motion` | 12.x | Entry/exit animations on disclosure + warnings | `motion/react` is the project standard. `[VERIFIED: recording-view.tsx:15]` |
| `lucide-react` | 0.460+ | Icons (likely reuse `ChevronDown`, `TriangleAlert`, `Sparkles`, `Settings`) | Project icon standard. `[VERIFIED: export-modal.tsx:22-28]` |
| `@tauri-apps/api` | 2.x | `invoke`, `Channel` | IPC runtime. `[VERIFIED: package.json]` |
| `sonner` | 1.x | Toast for migration errors | Already in use. `[VERIFIED: export-modal.tsx:20]` |

### Supporting (to ADD in Phase 13)

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `@tauri-apps/plugin-store` | 2.x | Global output prefs persistence (D-13-05) | Entire phase — add once, consume everywhere. `[VERIFIED: not currently in apps/desktop/package.json]` |
| `tauri-plugin-store` | 2.4.x (Cargo) | Rust-side plugin registration | Added to `apps/desktop/src-tauri/Cargo.toml` + `lib.rs::run()`. `[CITED: CLAUDE.md stack table confirms 2.4.x]` |

**Version verification:**

- `@tauri-apps/plugin-store` on npm: latest 2.3.x line as of April 2026 per Tauri plugins-workspace v2 branch. **Planner MUST run `npm view @tauri-apps/plugin-store version` and `cargo search tauri-plugin-store` at planning time to pin the current version — training data / CLAUDE.md table may lag.** `[ASSUMED]` (version claimed in CLAUDE.md; unverified at this exact moment against npm registry because web-search flags were off for this session)

### Optional (evaluate if needed)

| Library | Version | Purpose | Notes |
|---------|---------|---------|-------|
| `@tauri-apps/plugin-fs` | 2.x | Reading/writing `<project>/.storycapture/output.json` | Already installed (`apps/desktop/package.json:5`); ensure fs scope in `capabilities/*.json` permits `$PROJECT/.storycapture/**`. |
| shadcn primitives to add | latest | `accordion`, `segmented`, `slider`, `radio-group`, `label`, `input`, `form` error helpers | Scaffold via `pnpm dlx shadcn@latest add <name>` with the `base-vega` registry once Plan 13-01 has confirmed the registry config. |

### Alternatives Considered (and why not)

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `tauri-plugin-store` | Hand-rolled JSON read/write (like `app_settings.rs`) | Faster for one struct, but Phase 13 already introduces schema + migration + cross-feature consumption. The app_settings approach was justified only because it had no UI needs and was sync-safe. Prefer plugin-store for this phase. `[CITED: app_settings.rs:1-6 rationale]` |
| Zustand shared slice | Two independent slices + an event bus | Event-bus pattern is an anti-pattern in Zustand-native codebase. Shared slice with feature selectors is idiomatic. |
| Custom color picker | `<input type="color">` | Native picker satisfies WCAG; no cross-platform rendering risk; no extra dep. D-13-09 explicitly selected this. |
| Drawer for export Advanced | Accordion / collapsible inside existing drawer | CD-13-01 locked progressive disclosure *inside* the current export drawer. Nested drawer would break mental model. |

---

## Architecture Patterns

### System Data Flow

```
              ┌──────────────────────────────────────┐
              │        App startup (lib.ts)          │
              │                                      │
              │  1. Plugin-store.load(output-prefs.  │
              │     v1) — creates empty if missing   │
              │  2. Migrator(current, DEFAULT)       │
              │     ├─ if no version: seed Phase 12  │
              │     │  defaults + write version: 1   │
              │     └─ if version < latest: run      │
              │        v1→v2→… migrators in order    │
              │  3. Hydrate useOutputPrefsStore      │
              └──────────────┬───────────────────────┘
                             │
                             │ (on any route)
                             ▼
              ┌──────────────────────────────────────┐
              │     useOutputPrefsStore (Zustand)    │
              │ activePreset | recordingKnobs |      │
              │ exportKnobs  |  per-project override │
              │ (project>global>seed resolution)     │
              └───┬──────────────────────┬───────────┘
                  │ selector(5 knobs)    │ selector(13 knobs)
                  ▼                      ▼
    ┌───────────────────────┐   ┌────────────────────────────┐
    │  Recording View       │   │  Export Modal              │
    │  <VideoOutputSection/>│   │  Basic (existing) +        │
    │  <OutputSummaryBadge/>│   │  <AdvancedOutputOptions/>  │
    │  live bitrate preview │   │  live bitrate preview      │
    │  inline warnings      │   │  inline warnings           │
    └─────────┬─────────────┘   └──────────────┬─────────────┘
              │ setKnob → flip preset to Custom │
              │ (or re-apply preset bundle)     │
              │ (writes back to plugin-store via debounced effect)
              ▼                                 ▼
    ┌───────────────────────┐   ┌────────────────────────────┐
    │  ipc/encode.ts        │   │  ipc/export.ts             │
    │  startRecording(args) │   │  exportRun({outputs:[...]})│
    │  fills 5 opt fields   │   │  Phase 13 extends Output   │
    │  on StartRecordingArgs│   │  Dto with encoder options  │
    └─────────┬─────────────┘   └──────────────┬─────────────┘
              │                                 │
              ▼ (unchanged Phase 12 backend)    ▼
    ┌───────────────────────────────────────────────────────┐
    │  encode.rs / export.rs → encoder crate → FFmpeg       │
    └───────────────────────────────────────────────────────┘
```

### Recommended Project Structure (additions only)

```
apps/desktop/
├── src-tauri/
│   ├── Cargo.toml                            # add tauri-plugin-store = "2.4"
│   ├── capabilities/
│   │   └── default.json                      # add store + fs scope for .storycapture/**
│   ├── src/lib.rs                            # register plugin_store, plugin_fs stays
│   └── src/commands/export.rs                # extend ExportOutputDto (ENC-13)
├── src/
│   ├── state/
│   │   └── output-prefs.ts                   # NEW — shared Zustand store + selectors
│   ├── lib/
│   │   └── output-prefs-persist.ts           # NEW — migrator + subscribe effect
│   ├── components/ui/                        # scaffold via shadcn:
│   │   ├── accordion.tsx                     # NEW (CD-13-01 Advanced collapsible)
│   │   ├── segmented.tsx                     # NEW (pad color picker)
│   │   ├── radio-group.tsx                   # NEW (fit mode)
│   │   ├── slider.tsx                        # NEW (CQ/CRF/bitrate)
│   │   └── input.tsx                         # NEW (custom W/H, hex)
│   ├── features/
│   │   ├── recorder/
│   │   │   ├── recording-view.tsx            # MODIFY — add <VideoOutputSection/> + <OutputSummaryBadge/>
│   │   │   └── video-output/                 # NEW — Phase 13 recording UI
│   │   │       ├── video-output-section.tsx
│   │   │       ├── resolution-control.tsx
│   │   │       ├── fps-control.tsx
│   │   │       ├── fit-mode-control.tsx
│   │   │       ├── pad-color-control.tsx
│   │   │       ├── quality-preset-control.tsx
│   │   │       ├── preset-select.tsx
│   │   │       ├── bitrate-preview.tsx
│   │   │       ├── warnings.tsx
│   │   │       ├── output-summary-badge.tsx
│   │   │       └── copy.ts                   # Vietnamese string constants
│   │   └── post-production/
│   │       ├── export-modal/
│   │       │   ├── export-modal.tsx          # MODIFY — insert <AdvancedOutputOptions/>
│   │       │   └── advanced-output-options.tsx # NEW — 8 export-only knobs
│   │       └── state/
│   │           └── export-slice.ts           # MODIFY — import preset from shared store
│   ├── ipc/
│   │   ├── encode.ts                         # MODIFY — thread 5 optional DTOs through StartRecordingArgs
│   │   ├── export.ts                         # MODIFY — extend ExportOutput with encoder options
│   │   └── output-prefs.ts                   # NEW — TS wrapper around plugin-store
└── package.json                              # add @tauri-apps/plugin-store
```

### Pattern 1: Preset + Override State Slice (D-13-03, D-13-04)

**What:** Single Zustand store holds `activePreset`, `recordingKnobs`, `exportKnobs`. Selectors derive per-feature views. Any `setKnob` action sets preset to `Custom` unless it matches a preset's bundle exactly.

**When to use:** Only this phase. Placed in `apps/desktop/src/state/output-prefs.ts` as a cross-feature slice (second documented exception to the feature-monolithic rule).

**Example:**
```ts
// Source: Pattern derived from existing zustand/recorder.ts feature-monolithic style.
import { create } from "zustand";

type PresetName = "Quick" | "Standard" | "High Quality" | "Custom";

interface RecordingKnobs {
  resolution: OutputResolutionDto;
  fps: number;
  fit: FitModeDto;
  pad: PadColorDto;
  quality: QualityPresetDto;
}

interface OutputPrefsState {
  activePreset: PresetName;
  recordingKnobs: RecordingKnobs;
  exportKnobs: ExportKnobs;
  setRecordingKnob<K extends keyof RecordingKnobs>(k: K, v: RecordingKnobs[K]): void;
  applyPreset(name: Exclude<PresetName, "Custom">): void;
  setExportKnob<K extends keyof ExportKnobs>(k: K, v: ExportKnobs[K]): void;
}

export const useOutputPrefsStore = create<OutputPrefsState>((set, get) => ({
  activePreset: "Standard",
  recordingKnobs: PRESET_BUNDLES.Standard,
  exportKnobs: DEFAULT_EXPORT_KNOBS,
  setRecordingKnob: (k, v) =>
    set((s) => {
      const next = { ...s.recordingKnobs, [k]: v };
      const matched = matchBundle(next); // returns PresetName or null
      return { recordingKnobs: next, activePreset: matched ?? "Custom" };
    }),
  applyPreset: (name) =>
    set({ activePreset: name, recordingKnobs: PRESET_BUNDLES[name] }),
  setExportKnob: (k, v) =>
    set((s) => ({ exportKnobs: { ...s.exportKnobs, [k]: v } })),
}));
```

### Pattern 2: Plugin-Store Persistence with Debounced Subscribe

**What:** App startup loads the store, runs migrator, hydrates the Zustand slice. A debounced `useEffect` subscribes to store changes and writes back.

**Example:**
```ts
// Source: Standard Tauri v2 plugin-store + Zustand hydration pattern.
// No migration primitive in the plugin itself — migrator is userland.
import { Store } from "@tauri-apps/plugin-store";

const STORE_FILE = "output-prefs.json";
const STORE_KEY  = "output-prefs.v1";
const LATEST_VERSION = 1;

export async function initOutputPrefs() {
  const store = await Store.load(STORE_FILE);
  const raw = (await store.get<PersistShape>(STORE_KEY)) ?? null;
  const hydrated = migrate(raw); // fills in Phase 12 defaults on first run
  if (!raw || raw.version !== LATEST_VERSION) {
    await store.set(STORE_KEY, hydrated);
    await store.save();
  }
  useOutputPrefsStore.setState(hydrated);

  // Subscribe + debounce writes back.
  let t: number | undefined;
  useOutputPrefsStore.subscribe((s) => {
    clearTimeout(t);
    t = window.setTimeout(async () => {
      await store.set(STORE_KEY, { ...s, version: LATEST_VERSION });
      await store.save();
    }, 250);
  });
}
```

### Pattern 3: Probe-Driven HW Encoder Picker (D-13-07)

**What:** Query `probeHwEncoders()` via TanStack Query at mount, filter to `.ok === true`, render options. Always include `Auto` (first) and `Software (libx264)` (last).

**Example:** Mirrors the AudioDevicePicker lazy-load pattern at `AudioDevicePicker.tsx:108-196` — reuse the structure, swap the query.

### Anti-Patterns to Avoid

- **Eager probe on app load.** Probing HW encoders before the user opens the Video Output section spawns FFmpeg subprocesses the user may not need. Query on Select open (matches AudioDevicePicker pattern) or at first render of the section — NOT at app init.
- **Writing to plugin-store on every keystroke.** Debounce writes (250ms is typical; matches input UX). Without debouncing, each slider tick hits disk.
- **Stringly-typed preset names.** Use a literal union `"Quick" | "Standard" | "High Quality" | "Custom"` so mismatches fail at TS compile time. Do NOT use `string`.
- **Per-project override as a second plugin-store instance.** Per-project override lives in the project folder (not app data dir). Use `plugin-fs` with the project path — do NOT instantiate a second `Store`.
- **Hand-editing `packages/shared-types/src/ipc.ts`.** If new export options need IPC visibility, regen via `pnpm tauri dev` per the Phase 12 playbook. Never touch the generated file.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Persistent KV on desktop | Custom `fs::write(app_config_dir.join("prefs.json"))` | `tauri-plugin-store` (D-13-05 locked) | Handles atomic writes, concurrent-access safety, save/load debouncing. `app_settings.rs` pattern is documented as an exception; Phase 13 is the documented graduation point. |
| Color picker | Swatch grid + custom hex parser + eyedropper | `<input type="color">` + `<input type="text" pattern="#[0-9a-f]{6}">` | Native picker is WCAG-compliant, OS-themed, zero-dep. D-13-09 explicitly locked this. |
| Segmented control | Custom `<div>` with click handlers | Base UI `ToggleGroup` (or shadcn `segmented` scaffold) | Keyboard nav + ARIA states for free. |
| Accordion/disclosure | Custom `<details>` + CSS | Base UI `Accordion` (or shadcn `accordion` scaffold) | Animation + controlled state baked in; matches existing Base UI idiom. |
| FFmpeg argv construction | Any TS-side FFmpeg string building | Let backend handle it — Phase 12 already ships `build_vf()` + `QualityResolver` | Frontend only sends enum values; zero argv in TS. `[CITED: 12-CONTEXT.md D-12-07]` |
| Bitrate computation | Re-derive per encoder | Reuse Phase 12 `pixel_based` heuristic × `qMul` in `bitrate-preview.tsx` | D-13-11 formula is exact; backend doesn't expose a preview command and shouldn't. |
| Migration framework | Custom versioned JSON reader | Userland migrator (plugin-store has no built-in) | Schema is flat; a single `migrate(raw)` function handles v0→v1 (seed Phase 12) and future v1→v2. Keep it simple. |
| Form validation | `react-hook-form` + `zod` | Plain state + derived error booleans (CONVENTIONS.md rule) | Project convention is "plain useState forms — no react-hook-form/zod yet". `[CITED: CLAUDE.md Conventions block]` |
| Probe caching | Manual ref + polling | TanStack Query with `staleTime: Infinity` | Already the project-wide IPC caching pattern. |

**Key insight:** The only hand-rolled piece worth writing is the tiny migrator (~20 lines). Everything else has an ecosystem solution already validated in the project stack.

---

## IPC surface

### Recording command: no new commands, no new types

Phase 12's Plan 12-04 already:
- Added `OutputResolutionDto`, `FitModeDto`, `PadColorDto`, `QualityPresetDto`, `ScaleAlgoDto` in `apps/desktop/src-tauri/src/commands/encode.rs` (lines post-146).
- Registered all 5 via `.typ::<T>()` in `ipc_spec.rs:171-177` block.
- Extended `StartRecordingArgs` with 5 `#[serde(default)] pub <field>: Option<XxxDto>` fields.
- Made `start_recording` honor the DTOs with `.unwrap_or(Phase 12 default)`.

**Phase 13 action in `apps/desktop/src/ipc/encode.ts`:** Add the 5 optional fields to the `StartRecordingArgs` TypeScript interface (they'll appear in the regenerated `packages/shared-types/src/ipc.ts` — prefer importing the auto-generated type over re-declaring in the wrapper). `[VERIFIED: 12-04-PLAN.md task 3 + acceptance criteria line 290 confirms typecheck passes]`

### Export command: extension needed (ENC-13)

The current export IPC at `apps/desktop/src-tauri/src/commands/export.rs:41` exposes `ExportOutputDto { format, resolution, fps, quality }`. The 8 export-only knobs from CD-13-04 do NOT exist in this DTO.

**Recommended approach:** Add an optional `encoder_options: Option<EncoderOptionsDto>` field to `ExportOutputDto`, where `EncoderOptionsDto` bundles:

```rust
#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub struct EncoderOptionsDto {
    #[serde(default)] pub container: Option<ContainerDto>,        // Mp4, Mkv, Mov, WebM (Phase 13 only wires Mp4 per CD-13-04)
    #[serde(default)] pub codec: Option<CodecDto>,                 // H264 only in Phase 13; HEVC/VP9/AV1 deferred
    #[serde(default)] pub rate_control: Option<RateControlDto>,    // Cbr / Vbr / Crf / Cq
    #[serde(default)] pub hw_encoder: Option<HardwareEncoderDto>,  // reuses existing Phase 1 DTO
    #[serde(default)] pub x264_preset: Option<X264PresetDto>,      // Ultrafast..Veryslow
    #[serde(default)] pub keyframe_interval_sec: Option<u32>,      // default 2
    #[serde(default)] pub scale_algo: Option<encode::ScaleAlgoDto>,// reuse
    #[serde(default)] pub audio: Option<AudioOptionsDto>,          // {codec, bitrate_kbps, channels, sample_rate}
}
```

And on the Rust side, `export_validate_config` + `export_run_inner` consume the options, defaulting to Phase 12 / Phase 13 defaults when absent. This preserves backward compatibility (existing `ExportOutput` call sites still work).

**Alternative:** Flatten the 8 fields directly onto `ExportOutputDto`. This is simpler but noisier for IPC readers; the recommended nested approach keeps `ExportOutputDto` readable and allows per-output vs per-run option scoping later.

**Planner MUST decide** between nested (recommended) and flat before Plan 13-02.

### tauri-specta regen workflow

Per `12-04-PLAN.md:262-268` (validated pattern):

1. Add new types + `.typ::<T>()` registrations in `ipc_spec.rs`.
2. Run either `pnpm --filter @storycapture/desktop tauri dev` (preferred; runs the debug-assertions-gated `.export()` in `lib.rs:82-91`) OR `cargo build --package <tauri-package-name>` if that triggers the export.
3. The file `packages/shared-types/src/ipc.ts` is rewritten. Commit the diff alongside the Rust change in the same commit.
4. If regen does NOT fire: STOP, report missing regen command — do NOT hand-edit. This is a CLAUDE.md "no workarounds" gate.

---

## UI surface map

### Recording View integration point

`apps/desktop/src/features/recorder/recording-view.tsx` currently renders the Recording Setup panel around lines 795–845:

| Line (approx) | Component | Pattern |
|---|---|---|
| 800 | `<AudioDevicePicker/>` | Base UI Select wrapped in a `SettingsGroup label="Audio input"` |
| 821 | `<CursorToggle/>` | Toggle switch inside `SettingsGroup label="Options"` |
| 827 | `<ChromeHidingToggle/>` | Toggle switch inside the same Options group |

**Phase 13 insertion:** Add a new `<SettingsGroup label="Video Output">` section *between* Audio input and Options (or immediately after Options — planner chooses layout rhythm, but D-13-01 requires it in the Recording Setup panel alongside the others). Inside, render:

```tsx
<SettingsGroup label="Video Output">
  <PresetSelect />
  <ResolutionControl />    {/* reveals CustomResInputs when kind=Custom */}
  <FpsControl />           {/* 24 / 30 / 60 radios; Custom number input behind flag */}
  <FitModeControl />       {/* Letterbox / FillCrop / Stretch radio group */}
  <PadColorControl />      {/* segmented + native color picker */}
  <QualityPresetControl /> {/* Low / Med / High / Lossless select */}
  <BitratePreview />       {/* live text */}
  <Warnings />             {/* hard + soft */}
</SettingsGroup>
```

All controls disabled when `status === "recording" | "paused" | "stopping"` (same guard used by `AudioDevicePicker disabled` prop on line 803). `[VERIFIED: recording-view.tsx:803, 824, 830]`

**Summary badge** (D-13-02) lives adjacent to the Record CTA (search for the Record button in `recording-view.tsx`; planner identifies exact placement during Plan 13-04). Click handler: `badgeRef.scrollIntoView({ behavior: "smooth" })` OR focus the first control.

### Export Modal integration point

`apps/desktop/src/features/post-production/export-modal/export-modal.tsx:244-350` contains the Basic sections (`FormatCheckboxes`, `ResolutionPicker`, FPS radios, Quality select, base name, folder picker). Per CD-13-01:

```tsx
<div className="flex-1 space-y-4 overflow-auto px-5 py-5">
  {/* Existing Basic sections: formats, resolution, fps, quality, folder, basename */}
  ...

  {/* NEW — CD-13-01 Advanced collapsible */}
  <Accordion.Root type="single" collapsible>
    <Accordion.Item value="advanced">
      <Accordion.Trigger>Advanced output options</Accordion.Trigger>
      <Accordion.Content>
        <AdvancedOutputOptions />
      </Accordion.Content>
    </Accordion.Item>
  </Accordion.Root>
</div>
```

`AdvancedOutputOptions` renders the 8 export-only knobs reading from `useOutputPrefsStore((s) => s.exportKnobs)`.

### Conditional-field pattern

D-13-08 (Custom W/H) and D-13-09 (Custom pad color) require conditional reveals. Existing pattern reference: **none** — there is no in-repo reveal pattern. Recommend a tiny helper:

```tsx
{resolution.kind === "Custom" && (
  <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }}>
    <CustomResInputs value={resolution} onChange={setRes} />
  </motion.div>
)}
```

`motion/react` is already the project-standard animation library. AnimatePresence wrapping for exit animations matches the existing pattern at `recording-view.tsx:15`.

### Per-encoder field conditionals (export Advanced)

Show/hide within `AdvancedOutputOptions` based on the selected HW encoder:

| Active encoder | Rate-control control | Quality control |
|---|---|---|
| `Software (libx264)` | `CRF` slider (18–28, default 23) + `preset` select | — |
| `VideoToolbox` | `bitrate` input (kbps, default = pixel_based) + `maxrate`/`bufsize` derived | `q:v` slider (0–100, default 65) |
| `NVENC` | `rc=vbr` + `cq` slider (18–28) + `b:v` input | — |
| `QSV` | `global_quality` slider (18–28) + `preset` select | — |
| `AMF` | `rc=cqp` + `qp_i` + `qp_p` sliders | — |
| `Auto` | **Hide all of the above**; show only "Auto will pick the best available encoder at render time" text. | — |

Per D-13-07 the default is `Auto`, so new users see the simplest UX. Power users flip to a specific encoder to unlock the per-encoder controls.

---

## Defaults + Validation

### Recording knobs — defaults & ranges

| Knob | Type | Default (Phase 12 seed) | Validation |
|---|---|---|---|
| `resolution` | `OutputResolutionDto` | `{ kind: "P1080" }` | For Custom: `w, h ∈ 16..=7680 × 16..=4320`, both even. `[CITED: Phase 12 D-12-03]` |
| `fps` | `u32` | `30` | 1..=120 (UI offers 24/30/60; Custom deferred per D-12-09) |
| `fit` | `FitModeDto` | `"letterbox"` | Enum-bound; no free-form |
| `pad` | `PadColorDto` | `"black"` | For Custom: `r, g, b ∈ 0..=255`; hex parse tolerant of `#RRGGBB` lowercase |
| `quality` | `QualityPresetDto` | `"med"` | Enum-bound |

### Export-only knobs — defaults (per CD-13-04)

| Knob | Default | UI control | Notes |
|---|---|---|---|
| `container` | `Mp4` | Select (Mp4 only active in Phase 13) | Mkv/Mov/WebM deferred |
| `codec` | `H264` | Select (H264 only active in Phase 13) | HEVC/VP9/AV1 deferred |
| `rate_control` | `Auto` (maps to Phase 12 QualityResolver output) | Select (Auto / CBR / VBR / CRF / CQ) | Encoder-scoped — see per-encoder table above |
| `hw_encoder` | `Auto` | Select, probe-filtered | D-13-07 |
| `x264_preset` | `medium` | Select (ultrafast…veryslow) | Only shown when `hw_encoder = Software` |
| `keyframe_interval_sec` | `2` | Slider 1..=10 | Maps to `-g <fps * keyframe_sec>` |
| `downscale_algo` | `Lanczos` | Select (Lanczos/Bicubic/Bilinear/Area) | `ScaleAlgoDto` already exists in Phase 12 DTOs |
| `audio` | `{ codec: "AAC", bitrate_kbps: 160, channels: 2, sample_rate: 48_000 }` | Grouped sub-panel: bitrate slider (64/96/128/160/192/256), channels radio (1/2), sample rate select | Sample-rate 48 kHz is the FFmpeg default; project already uses 48_000 in `app_settings.rs`-adjacent code paths |

### Validation rules (frontend-only)

**Hard (block submit/record):**
- Custom resolution: both axes even, `16..=7680` width, `16..=4320` height → copy: *"Chiều rộng/cao phải là số chẵn và trong khoảng 16–7680 × 16–4320."*
- Custom pad color hex parse: must match `^#[0-9a-f]{6}$` → copy: *"Mã màu hex phải dạng `#rrggbb` (6 ký tự hex chữ thường)."*

**Soft (inline warning, do NOT block):**
- `quality === "Lossless" && output_px ≥ 4K && hw_encoder !== "Software"` → copy: *"Chất lượng Lossless ở 4K với HW encoder có thể vượt bitrate cap phần cứng và khiến render chậm. Cân nhắc giảm xuống High hoặc chuyển sang Software (libx264)."*
- `output_w > capture_w || output_h > capture_h` (either axis) → copy: *"Nguồn ghi nhỏ hơn kích thước output — video sẽ giữ nguyên kích thước nguồn và thêm viền thay vì phóng to (không làm mờ text)."*

All copy verbatim from CONTEXT.md `<specifics>` block; planner may polish but NOT change meaning.

---

## Persistence schema + migration

### Schema (locked by CONTEXT.md `<specifics>`)

```jsonc
// Store file: output-prefs.json (plugin-store manages path — goes under app data dir)
// Store key: "output-prefs.v1"
{
  "activePreset": "Standard",
  "recordingKnobs": {
    "resolution": { "kind": "P1080" },
    "fps": 30,
    "fit": "letterbox",
    "pad": { "kind": "black" },
    "quality": "med"
  },
  "exportKnobs": {
    "container": "mp4",
    "codec": "h264",
    "rateControl": "auto",
    "hwEncoder": "auto",
    "x264Preset": "medium",
    "keyframeSec": 2,
    "downscaleAlgo": "lanczos",
    "audio": { "codec": "aac", "bitrateKbps": 160, "channels": 2, "sampleRate": 48000 }
  },
  "version": 1
}
```

Per-project override at `<project>/.storycapture/output.json`: same shape minus `version`. Any missing field falls through to global. Precedence: **project > global > Phase 12 seed**.

### Migration approach (userland)

`tauri-plugin-store` has NO migration primitive. The migrator is a pure TypeScript function:

```ts
// lib/output-prefs-persist.ts
const LATEST_VERSION = 1;

export function migrate(raw: unknown): PersistShape {
  // v0 / null / missing → seed with Phase 12 defaults (D-13-06 silent migration).
  if (raw == null || typeof raw !== "object" || !("version" in raw)) {
    return {
      activePreset: "Standard",
      recordingKnobs: PRESET_BUNDLES.Standard, // 1080p / 30 / Letterbox / Black / Med
      exportKnobs: DEFAULT_EXPORT_KNOBS,
      version: LATEST_VERSION,
    };
  }
  // v1 → current — no migration needed.
  // (Future v1→v2 migrators go here, chained via switch on version.)
  return raw as PersistShape;
}
```

**Key properties:**
- **Silent:** no UI prompt, no toast — D-13-06.
- **Idempotent:** calling `migrate(migrate(x))` returns the same shape.
- **Forward-compatible:** adding a `v2` migrator only adds a case; the `LATEST_VERSION` bump + a `v1→v2` function.
- **Failure mode:** if JSON parse fails (corrupted store), return seeded default and log via `toast.error` + `tauri-plugin-log`. Do NOT throw — that would block app startup.

### Per-project override read/write

```ts
// ipc/output-prefs.ts
import { readTextFile, writeTextFile, mkdir } from "@tauri-apps/plugin-fs";
import { join } from "@tauri-apps/api/path";

export async function readProjectOverride(projectFolder: string): Promise<Partial<PersistShape> | null> {
  const path = await join(projectFolder, ".storycapture", "output.json");
  try {
    const text = await readTextFile(path);
    return JSON.parse(text) as Partial<PersistShape>;
  } catch {
    return null; // ENOENT / parse error → no override
  }
}
```

**Capability:** the `fs` plugin requires the `<project>/.storycapture/**` path in the allowlist. Planner must update `apps/desktop/src-tauri/capabilities/*.json` to include scope; this is a small additive permission change.

---

## Preset bundle tuning (CD-13-02)

Starter values from CONTEXT.md `<specifics>` are reasonable but can be refined. Observed industry conventions (MEDIUM confidence, not re-verified this session):

| Preset | Screen Studio export default | OBS "Rendering" default | CONTEXT.md starter | Recommendation |
|---|---|---|---|---|
| Quick | — (no direct analog) | N/A | 720p / 30 / Letterbox / Black / Low | **Keep.** 720p/30 is the universal "smaller file" default. |
| Standard | 1080p / 60 | 1080p / 30-60 | 1080p / 30 / Letterbox / Black / Med | **Consider 60 fps** if the audience is demo videos (60 fps is Screen Studio's default; 30 fps is closer to OBS streaming default). Operator-facing decision; keep 30 for Phase 13 since it matches the Phase 12 hard-coded seed exactly (D-13-06 silent migration requires no behavioural change). `[CITED: 13-CONTEXT.md D-13-03 + D-13-06 require behavioural parity on seed]` |
| High Quality | 4K / 60 | 1080p/4K / 60 + high bitrate | 1080p / 60 / Letterbox / Black / High | **Keep at 1080p/60/High.** 4K/60 would change the default fps from 30, violating D-13-06 if a user upgrades and first opens the preset select. 1080p/60 is the safe upgrade path. |

**Recommendation:** Keep starter values as-is. If the operator wants to adjust during review, it's a single-file change to `PRESET_BUNDLES` in `state/output-prefs.ts`.

---

## Testing strategy

`workflow.nyquist_validation` is `false` in `.planning/config.json`, so the Validation Architecture section is skipped. However, testing conventions still apply per `docs/CONVENTIONS.md` + `CLAUDE.md`:

### Vitest (happy-dom) — per-component

- `video-output-section.test.tsx` — renders all 6 sub-controls, disabled state gating, preset-to-custom flip on knob change.
- `preset-select.test.tsx` — applying a preset sets `recordingKnobs` to the bundle; activePreset is correct.
- `resolution-control.test.tsx` — Custom reveals W/H inputs; invalid values show inline error; valid values update state.
- `pad-color-control.test.tsx` — segmented selection; Custom reveals `<input type="color">` + hex sync.
- `bitrate-preview.test.tsx` — pure formula test against known cases (1080p/Med → ~6.2 Mbps; 4K/Lossless → ~37 Mbps).
- `warnings.test.tsx` — hard/soft matrix table-driven test.
- `output-prefs-persist.test.ts` — migrator: null→seed, v1→passthrough, corrupted→seed.
- `advanced-output-options.test.tsx` — per-encoder field conditional rendering.

### `mockIPC` integration tests

- `start_recording` receives all 5 optional DTOs with user-selected values (assert `args.output_resolution === { kind: "Custom", w: 1280, h: 720 }`).
- `export_run` receives the extended `ExportOutput` with `encoder_options` populated.
- `probe_hw_encoders` result filters the HW encoder picker correctly (mock with `[{encoder: "VideoToolboxH264", ok: true}, {encoder: "Nvenc", ok: false}]`).

### No Rust tests needed

Phase 12 already covers backend via `insta` snapshots (`filters.rs`), `QualityResolver` unit tests, and `real-ffmpeg` integration tests. Phase 13 adds no Rust logic — if `start_recording` or `export_run` gain a new *code path*, add a Rust test. But simply threading new optional fields does not require new backend tests beyond "it compiles".

---

## Common Pitfalls

### Pitfall 1: Silent migration drift
**What goes wrong:** A user's stored preset no longer matches any bundle (e.g. `{ resolution: P1080, fps: 30, fit: Letterbox, pad: Black, quality: Med }` matches Standard — but after a refactor adds a 6th knob, the match fails and `activePreset` becomes `Custom` unexpectedly).
**Why it happens:** `matchBundle()` compares all 5 knobs; adding a knob forces re-matching.
**How to avoid:** When adding a new knob, bump `LATEST_VERSION` and write a `v1→v2` migrator that re-derives `activePreset` from the match, OR set the new knob to the Standard bundle value for all stored profiles.
**Warning signs:** QA opens the app after an update and sees "Custom" instead of "Standard" in the preset select, despite never changing knobs.

### Pitfall 2: Plugin-store write storm on slider drag
**What goes wrong:** Each slider `onChange` event writes to disk → 60+ writes/second during drag.
**Why it happens:** Zustand subscribe fires on every state change; without debounce, every state update hits `store.set` + `store.save`.
**How to avoid:** Debounce the subscribe write (250ms). Keep the reactive Zustand store as the UI source-of-truth; disk is eventually consistent.
**Warning signs:** UI stutter on slider drag, disk I/O spike in Activity Monitor / Resource Monitor.

### Pitfall 3: HW encoder availability drift
**What goes wrong:** User opens the export modal with NVENC selected; a driver update later disables NVENC; user hits Export → FFmpeg fails.
**Why it happens:** Stored `hw_encoder: "nvenc"` but probe at render time no longer includes it.
**How to avoid:** At Export modal open, re-run probe (cached via TanStack Query with short `staleTime`). If stored encoder is not in the probe result, fall back to `Auto` + emit a soft warning ("Encoder X no longer available; using Auto").
**Warning signs:** Support tickets citing "Export failed: encoder not found" after a driver/OS update.

### Pitfall 4: Per-project override loss on rename
**What goes wrong:** User renames their project folder → `<new-path>/.storycapture/output.json` doesn't exist → silently falls back to global.
**Why it happens:** Override is path-based, not project-id-based. Rename detaches the override from the project.
**How to avoid:** Accept the tradeoff (CONTEXT.md path is explicit). Optionally log a `console.info` on override-not-found so QA can distinguish "no override" from "lost override". Document in user-facing docs (deferred for Phase 13).
**Warning signs:** Users report "my settings reset" after moving projects.

### Pitfall 5: Specta regen forgetting
**What goes wrong:** Rust `ExportOutputDto` extended with `encoder_options`; TS not regenerated; frontend type-check passes because TS type is stale; runtime IPC fails with "missing field" on serde deserialize.
**Why it happens:** `packages/shared-types/src/ipc.ts` is auto-generated only at `pnpm tauri dev` startup (not on `cargo check`).
**How to avoid:** Plan 13-02 MUST include explicit regen step + verification grep (matching Plan 12-04 acceptance criteria pattern at line 287-288). Commit the regenerated file in the same commit as the Rust change.
**Warning signs:** Export modal in dev mode silently drops `encoder_options`; backend sees `None` for all fields.

### Pitfall 6: Base UI Select value must be non-null string
**What goes wrong:** Encoding `{ kind: "P1080" }` into a Select value fails because Base UI requires `string`, not object.
**Why it happens:** Base UI Select restriction.
**How to avoid:** Use the `kind:payload` round-trip pattern already proven in `AudioDevicePicker.tsx:49-82`. E.g. `"p1080"` or `"custom:1280x720"` string forms, parsed/serialized via helpers.
**Warning signs:** `onValueChange` receives objects; TS complains about types; runtime warning about Select value shape.

### Pitfall 7: Blur option accidentally shipped
**What goes wrong:** `PadColor::Blur` backend variant exists (deferred in Phase 12). Phase 13 UI might enumerate `PadColorDto` variants and render Blur as an available choice.
**Why it happens:** Iterating over enum exhaustively.
**How to avoid:** Explicit allowlist in UI: `const PAD_OPTIONS = ["black", "white", "custom"] as const`. Never iterate all `PadColorDto` variants. D-13-10 locks this.
**Warning signs:** Pad color segmented control shows a 4th option; selecting it crashes because backend has no Blur filter yet.

---

## Code Examples

### Preset match helper

```ts
// Source: derived from CONTEXT.md <specifics> table.
import isEqual from "fast-deep-equal"; // or a tiny in-house deep-eq

const PRESET_BUNDLES: Record<Exclude<PresetName, "Custom">, RecordingKnobs> = {
  Quick:          { resolution: { kind: "P720" },  fps: 30, fit: "letterbox", pad: { kind: "black" }, quality: "low"  },
  Standard:       { resolution: { kind: "P1080" }, fps: 30, fit: "letterbox", pad: { kind: "black" }, quality: "med"  },
  "High Quality": { resolution: { kind: "P1080" }, fps: 60, fit: "letterbox", pad: { kind: "black" }, quality: "high" },
};

export function matchBundle(knobs: RecordingKnobs): Exclude<PresetName, "Custom"> | null {
  for (const [name, bundle] of Object.entries(PRESET_BUNDLES)) {
    if (isEqual(knobs, bundle)) return name as Exclude<PresetName, "Custom">;
  }
  return null;
}
```

### Summary badge format

```ts
// Source: CONTEXT.md <specifics> summary badge copy format.
function formatSummaryBadge(k: RecordingKnobs): string {
  const res = k.resolution.kind === "Custom"
    ? `${k.resolution.w}×${k.resolution.h}`
    : k.resolution.kind === "MatchSource"
    ? "Nguồn"
    : k.resolution.kind.toLowerCase(); // "p1080"
  const parts = [res, `${k.fps}fps`, fitLabel(k.fit), qualityLabel(k.quality)];
  if (k.pad.kind !== "black") parts.splice(3, 0, padLabel(k.pad));
  return parts.join(" • ");
}
```

### Bitrate preview (exact CONTEXT.md formula)

```ts
// Source: 13-CONTEXT.md D-13-11 <specifics> block.
export function previewBitrate(w: number, h: number, q: QualityPresetDto): {
  kbps: number; mbPerMinute: number;
} {
  const pixelBasedKbps = (w * h * 3) / 1000;
  const qMul: Record<QualityPresetDto, number> = {
    low: 0.75, med: 1.0, high: 1.25, lossless: 1.5,
  };
  const bitrateKbps = pixelBasedKbps * qMul[q];
  const mbPerMinute = (bitrateKbps * 60) / 8 / 1024;
  return { kbps: bitrateKbps, mbPerMinute };
}
```

---

## State of the Art

Nothing in the frontend landscape shifted for Phase 13 specifically. The stack is stable:

- React 19 + Zustand 5 + TanStack Query 5 are current canonical 2026 choices `[CITED: CLAUDE.md]`
- Base UI 1.x beta.6 is the active shadcn-blessed non-Radix path `[VERIFIED: apps/desktop/package.json]`
- `motion/react` is the Framer Motion successor; already in use `[CITED: CLAUDE.md]`
- `@tauri-apps/plugin-store` v2.x is the current store plugin; no migration API (userland migrators are the norm) `[CITED: context7 lookup of tauri-apps/plugins-workspace]`

| Old Approach | Current Approach | When Changed | Impact |
|---|---|---|---|
| Hand-rolled `fs::write` for prefs (like `app_settings.rs`) | `tauri-plugin-store` | Phase 13 baseline | Phase 13 is the documented first production use. |
| Radix UI | Base UI (`base-vega`) | Pre-Phase 1 (D-32) | Phase 13 consumes Accordion / ToggleGroup from Base UI, not Radix. |
| Stronghold for any persistence | plugin-store (non-secret) + plugin-keyring (secret) | CLAUDE.md stack | No secrets in Phase 13 → plugin-store is correct. |

---

## Environment Availability

Phase 13 is purely code/config; its runtime dependencies are dev-only npm packages + Cargo crates installed from lockfiles. No external tools.

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node 20+ / pnpm 9.x | Building + typecheck | ✓ (project baseline) | pinned via `packageManager` | — |
| Rust toolchain | Building the Tauri shell after Cargo.toml change | ✓ | pinned via `rust-toolchain.toml` | — |
| `tauri-plugin-store` crate (npm + Cargo) | D-13-05 persistence | **Not yet installed** | Add 2.4.x (Cargo) / latest 2.x (npm) | None — must install; no fallback (falling back to hand-rolled fs would violate D-13-05 and regress from the validated stack) |

No missing tooling blocks execution. The single new dep is validated in `CLAUDE.md` stack tables.

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `@tauri-apps/plugin-store` latest version is in the 2.3.x–2.4.x range as of April 2026 | Standard Stack, Supporting | LOW — planner should run `npm view @tauri-apps/plugin-store version` at planning time to pin exact version; risk is only cosmetic (wrong version number in plan frontmatter). |
| A2 | The `ExportOutputDto` extension approach (nested `encoder_options`) is preferable to flattening | IPC surface — Export command extension | MEDIUM — if operator prefers flat, it's a rewrite of one struct + call-site updates. Flag as an early question in Plan 13-02. |
| A3 | Preset bundles should stay at CONTEXT.md starter values (Quick=720p/30/Low, Standard=1080p/30/Med, HQ=1080p/60/High) rather than adjust to Screen Studio conventions (HQ=4K/60) | Preset bundle tuning | LOW — keeping starter values guarantees D-13-06 silent migration parity; changing them would violate D-13-06. |
| A4 | UI primitives `accordion`, `segmented`, `radio-group`, `slider`, `input` scaffold cleanly via `pnpm dlx shadcn add` with the existing `base-vega` registry configuration | Recommended Project Structure | MEDIUM — if registry lacks a primitive, planner authors a thin Base UI wrapper following the existing `select.tsx` pattern (~60 LOC each). |
| A5 | The `apps/desktop/src-tauri/capabilities/*.json` file(s) permit adding `$PROJECT/.storycapture/**` scope without architectural review | Persistence schema + migration | LOW — adding a path to an existing allowlist is a routine additive permission change; if capability is missing entirely, Plan 13-01 adds it. |
| A6 | Debouncing plugin-store writes at 250ms is sufficient for UX (no stutter during slider drag) | Anti-Patterns | LOW — if 250ms is too slow for perceived responsiveness, lower to 100ms. If too aggressive, raise. Pure numeric tuning. |
| A7 | No new Rust tests needed because Phase 13 does not introduce new backend code paths — only threads existing DTO values | Testing strategy | LOW — if the `ExportOutputDto` extension introduces new validation logic in `export_validate_config`, add Rust unit tests for those branches. Planner decides during Plan 13-02. |
| A8 | The Phase 13 schema proposed (`output-prefs.v1` key with nested recordingKnobs/exportKnobs + version field) matches CONTEXT.md `<specifics>` intent | Persistence schema + migration | LOW — schema is directly copied from CONTEXT.md `<specifics>`. |

**User confirmation needed for:** A2 (IPC extension shape — nested vs flat) during Plan 13-02 kickoff. Everything else is either low-risk or a verifiable-at-plan-time fact.

---

## Open Questions (RESOLVED)

1. **Nested `encoder_options` vs flat `ExportOutputDto` extension.**
   - What we know: CD-13-04 lists the 8 export-only knobs. The current `ExportOutputDto` has 4 fields. A nested `encoder_options` sub-struct keeps the DTO readable; flat adds 8 optional fields.
   - What's unclear: Operator preference for IPC readability vs simplicity.
   - Recommendation: Planner defaults to nested (Option (b) in "IPC surface — Export command extension" section). If operator dislikes during review of Plan 13-02, switch to flat — small refactor.
   - **RESOLVED: Nested `encoder_options: Option<EncoderOptionsDto>` (Option (b)). Implemented in Plan 13-01 Task 1.**

2. **Per-project override scope.**
   - What we know: D-13-05 locked the `<project>/.storycapture/output.json` path.
   - What's unclear: Should per-project override be "additive" (missing fields fall through to global) or "replace" (if present, ignore global entirely)? CONTEXT.md says additive ("any missing field falls through to the global store").
   - Recommendation: Additive (CONTEXT.md explicit). Document in Plan 13-03 acceptance criteria.
   - **RESOLVED: Additive — per-project override deep-merges into global; missing fields fall through. Implemented as `resolveOverride()` in Plan 13-03 Task 2.**

3. **Where should `initOutputPrefs()` run at app startup?**
   - What we know: Must run before any component reads `useOutputPrefsStore` as populated.
   - What's unclear: `main.tsx` bootstrap vs inside an `AppProviders` wrapper vs a top-level `useEffect` in `App.tsx`.
   - Recommendation: Run in `main.tsx` before `createRoot().render()` (await the migrator). This guarantees hydration is complete before first render. Fallback: a suspense boundary + `useSuspenseQuery` wrapping the initialization.
   - **RESOLVED: `await initOutputPrefs()` in `main.tsx` BEFORE `createRoot().render()`. Wrap in async bootstrap fn so the await is legal at module scope. This guarantees hydration completes before any component reads `useOutputPrefsStore`. Implemented in Plan 13-03 Task 2 Step D.**

4. **FPS knob — only 24 / 30 / 60, or also Custom?**
   - What we know: CONTEXT.md does not explicitly list FPS as supporting Custom; D-12-09 defers FPS split; Phase 12 hard-codes `fps_advisory` as a plain u32.
   - What's unclear: Whether the UI exposes FPS as a radio group (24/30/60) or a number input.
   - Recommendation: Radio group with 24/30/60 (matches existing Export modal FPS control at `export-modal.tsx:261-280`). Custom FPS is a Phase 14+ concern tied to D-12-09 FPS split. Flag for quick operator confirmation in Plan 13-04.
   - **RESOLVED: Radio group with 24 / 30 / 60 only. No Custom FPS in Phase 13 (deferred to D-12-09 FPS split work). Implemented in Plan 13-04 Task 2 Step C.**

5. **Preset change animation / scroll behavior.**
   - What we know: D-13-02 "clicking the badge scrolls/focuses the section".
   - What's unclear: `scrollIntoView({ behavior: "smooth" })` vs instant; focus ring vs highlight pulse; `useReducedMotion()` respect (already imported at `recording-view.tsx:15`).
   - Recommendation: Smooth scroll + focus first control + respect `useReducedMotion()` (fall back to instant scroll + focus). This is pure UX polish — planner decides during Plan 13-04.
   - **RESOLVED: `scrollIntoView({ behavior: prefersReducedMotion ? "auto" : "smooth", block: "center" })` — gated on existing `useReducedMotion()` hook. Implemented in Plan 13-04 Task 3 Step B.**


---

## Sources

### Primary (HIGH confidence)

- `/Users/locvotuan/git/StoryCapture/.planning/phases/13-video-output-customization-knobs-recording-export-ui/13-CONTEXT.md` — all locked decisions D-13-01..13 and CD-13-01..04.
- `/Users/locvotuan/git/StoryCapture/.planning/phases/13-video-output-customization-knobs-recording-export-ui/13-DISCUSSION-LOG.md` — decision audit trail.
- `/Users/locvotuan/git/StoryCapture/.planning/phases/12-fix-video-output-resolution-lock-letterbox/12-CONTEXT.md` — Phase 12 D-12-01..12 locked enums, quality maps, filter chain.
- `/Users/locvotuan/git/StoryCapture/.planning/phases/12-fix-video-output-resolution-lock-letterbox/12-RESEARCH.md` — FFmpeg filter chain + per-encoder mapping rationale.
- `/Users/locvotuan/git/StoryCapture/.planning/phases/12-fix-video-output-resolution-lock-letterbox/12-04-PLAN.md` — IPC DTO scaffold Phase 13 consumes.
- `/Users/locvotuan/git/StoryCapture/apps/desktop/src-tauri/src/ipc_spec.rs` — current IPC surface (lines 171-177 = Phase 12 DTO block).
- `/Users/locvotuan/git/StoryCapture/apps/desktop/src-tauri/src/commands/encode.rs` — Phase 12 `StartRecordingArgs` + DTO definitions.
- `/Users/locvotuan/git/StoryCapture/apps/desktop/src-tauri/src/commands/app_settings.rs` — reference pattern for legacy JSON persistence (and reason to graduate to plugin-store).
- `/Users/locvotuan/git/StoryCapture/apps/desktop/src/features/recorder/{recording-view.tsx,AudioDevicePicker.tsx,CursorToggle.tsx}` — Recording Setup panel pattern Phase 13 mirrors.
- `/Users/locvotuan/git/StoryCapture/apps/desktop/src/features/post-production/export-modal/{export-modal.tsx,resolution-picker.tsx}` — Export modal scaffold Phase 13 extends.
- `/Users/locvotuan/git/StoryCapture/apps/desktop/src/features/post-production/state/export-slice.ts` — current export slice shape.
- `/Users/locvotuan/git/StoryCapture/apps/desktop/src/components/ui/select.tsx` — project Select wrapper primitive.
- `/Users/locvotuan/git/StoryCapture/apps/desktop/package.json` — verified dep list (plugin-store NOT present).
- `/Users/locvotuan/git/StoryCapture/CLAUDE.md` — project constraints, stack table, Agent Working Rules.
- `/Users/locvotuan/git/StoryCapture/.planning/REQUIREMENTS.md` — ENC-01..11 baseline.
- `/Users/locvotuan/git/StoryCapture/.planning/config.json` — `nyquist_validation: false` confirmed.

### Secondary (MEDIUM confidence)

- context7 lookup of `/tauri-apps/plugins-workspace` — confirmed `tauri-plugin-store` has no migration primitive (contrasting with `tauri-plugin-sql` which exposes `Migration` / `MigrationKind`). This drives the "userland migrator" pattern.

### Tertiary (LOW confidence)

- Industry convention observations (Screen Studio, OBS defaults in "Preset bundle tuning" table) — not re-verified this session; used only to argue *against* changing the CONTEXT.md starter bundles, not to drive new decisions.

---

## Project Constraints (from CLAUDE.md)

Extracted directives relevant to Phase 13 execution:

- **Agent Working Rules → No Workarounds** — If the tauri-specta regen step fails, STOP and report; never hand-edit `packages/shared-types/src/ipc.ts`. Likewise, if `pnpm dlx shadcn add <primitive>` fails to emit a Base UI variant, author a bespoke Base UI wrapper rather than falling back to Radix.
- **Agent Working Rules → No Co-Author in Commits** — All Phase 13 commits must omit `Co-Authored-By:` trailers.
- **Agent Working Rules → Match User's Language** — Agent responses to the operator are Vietnamese-mirrored; **file contents and technical artifacts remain English** (this RESEARCH.md, PLAN.md files). User-facing UI strings (CD-13-03) are Vietnamese.
- **Agent Working Rules → Concise Code Comments** — No essay comments. One-line "why" only when non-obvious.
- **Agent Working Rules → Plan Before Big Changes** — Adding `tauri-plugin-store` crosses into "dependency version bump" territory. Plan 13-01 must enter plan mode and seek approval before executing.
- **Agent Working Rules → Keep Docs In Sync** — Adding the second "shared slice across features" exception (after post-production) requires a short update to `docs/CONVENTIONS.md` (one line). Adding `tauri-plugin-store` requires a CLAUDE.md stack-table verification pass. Doc updates committed alongside code.
- **Technology Stack (CLAUDE.md)** — `tauri-plugin-store` 2.4.x and `@tauri-apps/plugin-store` 2.x are validated stack; use them. Do NOT fall back to hand-rolled JSON or to deprecated Stronghold. Base UI (not Radix). `motion/react` (not `framer-motion`). Biome for lint.
- **Conventions (CLAUDE.md + docs/CONVENTIONS.md)** — Plain `useState` forms (no react-hook-form/zod). Zustand feature-monolithic rule with a documented exception for cross-feature slices. Kebab-case filenames. Feature-folder layout. Vitest + happy-dom + `mockIPC`. No `@ts-ignore` / `any` casts to silence type errors.
- **Project → Performance** — <2s cold start, <300MB idle. Phase 13 must not regress: plugin-store hydration must be fast (<50ms typical for a ~1KB store); debounced writes must not spike memory.

---

## Metadata

**Confidence breakdown:**
- Locked decisions + phase boundary: HIGH — CONTEXT.md is exhaustive and operator-confirmed.
- IPC surface (recording): HIGH — Phase 12 Plan 12-04 already documents the exact DTOs and serde-default approach.
- IPC surface (export): MEDIUM — the extension approach is inferred; planner must confirm nested vs flat before Plan 13-02 begins.
- Persistence schema + migration: HIGH (schema) / MEDIUM (migration implementation) — schema is from CONTEXT.md; plugin-store has no migration API, so the userland migrator pattern is derived from ecosystem conventions.
- UI patterns + placement: HIGH — existing `recording-view.tsx` and `export-modal.tsx` patterns are concrete and well-structured for extension.
- Testing strategy: HIGH — matches existing `AudioDevicePicker` + Phase 12 conventions.
- Preset bundle values: MEDIUM — starter values are CONTEXT.md defaults with D-13-06 silent migration parity as the primary constraint.

**Research date:** 2026-04-19
**Valid until:** 2026-05-19 (30 days for a stack-stable UI phase; re-check before execution if `tauri-plugin-store` or `@base-ui-components/react` bump majors in that window).
