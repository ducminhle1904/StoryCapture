---
phase: 13
plan: 05
subsystem: apps/desktop/post-production/export-modal
tags: [ui, export, encoder-options, accordion, zustand, tanstack-query, i18n-vn]
requires:
  - 13-01 (EncoderOptionsDto + ExportOutput.encoder_options IPC field)
  - 13-03 (useOutputPrefsStore.exportKnobs + setExportKnob + persist v1)
  - 13-02 (Base UI primitives: Accordion, Select, RadioGroup, Slider, NumberField)
provides:
  - "<AdvancedOutputOptions /> accordion body with 8 export-only knobs"
  - "deriveQualityControls(encoder, codec) pure helper for UI-SPEC decision table"
  - "Vietnamese copy constants for the export advanced disclosure"
  - "encoder_options threaded into every ExportOutput sent to export_run"
affects:
  - apps/desktop/src/features/post-production/export-modal/export-modal.tsx
tech-stack:
  added: []
  patterns:
    - "TanStack Query lazy-on-mount probe (queryKey: ['hw-encoders'], staleTime=Infinity)"
    - "Pure decision-table helper discriminated by encoder kind"
    - "Camel→snake DTO mapping at modal boundary; UI keeps kebab identifiers"
key-files:
  created:
    - apps/desktop/src/features/post-production/export-modal/advanced-copy.ts
    - apps/desktop/src/features/post-production/export-modal/encoder-options-table.ts
    - apps/desktop/src/features/post-production/export-modal/encoder-options-table.test.ts
    - apps/desktop/src/features/post-production/export-modal/advanced-output-options.tsx
    - apps/desktop/src/features/post-production/export-modal/advanced-output-options.test.tsx
  modified:
    - apps/desktop/src/features/post-production/export-modal/export-modal.tsx
decisions:
  - "HardwareEncoderDto emits shapes like 'nvenc-h264' / 'video-toolbox-h264'; the store uses UI-friendly kebab names ('h264-nvenc'). Mapping lives in export-modal.tsx (buildEncoderOptions + HW_UI_TO_DTO) and advanced-output-options.tsx (PROBE_TO_UI) so the store stays ergonomic for UI code while IPC receives canonical DTO values."
  - "qualityValue reset to null on hwEncoder change — the new control's default renders immediately; user-committed values persist as real numbers (CD-13-04 Phase 12 default behavior)."
  - "Base UI's a11y lint rule disallows bare <label> wrapping custom radios. Switched the inline label wrappers to <span>; the RadioGroup item itself carries the role/value semantics."
  - "Warning row uses <output aria-live='polite'> to satisfy useSemanticElements while preserving getByRole('status') test ergonomics (output has implicit role=status)."
metrics:
  duration: ~35m
  tasks: 3
  files: 6
  completed: 2026-04-20
---

# Phase 13 Plan 05: Export Modal Advanced Encoder Options Accordion Summary

JWT-replacement equivalent: a collapsed-by-default Base UI Accordion inside the Export modal exposes 8 export-only encoder knobs (Container, Codec, HW encoder, Rate control, Quality slider/bitrate, Preset, Keyframe, Downscale, Audio) grouped into 3 visual sub-groups; a pure decision-table (`deriveQualityControls`) drives conditional field rendering per encoder kind; the selected knobs flow through `buildEncoderOptions()` into every `ExportOutput.encoder_options` field sent to `export_run`.

## What Shipped

- `advanced-copy.ts` — centralised Vietnamese labels (13 field labels + warnings/notes) per CD-13-03.
- `encoder-options-table.ts` — pure `deriveQualityControls(encoder, codec)` returning `{ rateControlOptions, qualityControl, presetOptions, note? }`. 8 encoder arms + default fallback.
- `encoder-options-table.test.ts` — 6 vitest cases covering software, h264-nvenc, h264-videotoolbox, auto, libopenh264, h264-qsv.
- `advanced-output-options.tsx` — the accordion body with 3 sub-groups:
  - Group 1 — Container & Codec (2 Selects; WebM/Opus disabled).
  - Group 2 — HW encoder Select (Auto + probe-driven list + Software fallback) + conditional Rate control RadioGroup / Quality Slider (CRF or CQ) / Bitrate NumberField / Preset Select — driven entirely by `deriveQualityControls()`.
  - Group 3 — Keyframe NumberField / Downscale RadioGroup / Audio codec Select / Audio bitrate Slider / Audio channels RadioGroup.
- `advanced-output-options.test.tsx` — 7 RTL cases covering sub-group labels, auto-hide behaviour, software CRF rendering, unavailable-encoder warning, VN copy, probe invocation, slider aria-valuenow reflecting the store.
- `export-modal.tsx` — hosts the Accordion between the existing Basic sections and the graph-pending gate; threads `encoder_options` into every output via a memoised `buildEncoderOptions(exportKnobs)` and maps UI kebab hwEncoder strings to `HardwareEncoderDto` serialized shapes (`'h264-nvenc'` → `'nvenc-h264'`, `'software'`/`'libx264'` → `'openh-264-software'`, etc.).

## Commits

| Hash | Message |
|------|---------|
| `706332a` | feat(13-05): advanced-copy VN constants + encoder-options-table decision table |
| `1ef1627` | feat(13-05): AdvancedOutputOptions component + 7-case RTL suite |
| `4dbb356` | feat(13-05): host AdvancedOutputOptions accordion in export modal + thread encoder_options into exportRun |

## Verification

- `pnpm vitest run src/features/post-production` — 10 test files, 71 tests, all green (13 new tests from this plan + pre-existing suites).
- `pnpm typecheck` — clean for all Plan 05 files (only pre-existing unrelated `bitrate.test.ts` error remains; see Deferred).
- `pnpm biome check` — clean for all Plan 05 files.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] `HardwareEncoderDto` enum values differ from plan assumption**
- **Found during:** Task 1 read-first of `packages/shared-types/src/ipc.ts`.
- **Issue:** The plan sketch assumed kebab form `"h264-nvenc"` / `"h264-videotoolbox"`, but the actual tauri-specta emission is `"nvenc-h264"` / `"video-toolbox-h264"` / `"openh-264-software"`.
- **Fix:** UI layer keeps the ergonomic kebab names (store doc comment says `hwEncoder` is free-form at UI layer); added `HW_UI_TO_DTO` map in `export-modal.tsx` (camel→DTO) and `PROBE_TO_UI` in `advanced-output-options.tsx` (probe DTO→UI) so the store stays UI-friendly while IPC receives the correct canonical values.
- **Files modified:** `export-modal.tsx`, `advanced-output-options.tsx`.
- **Commits:** `1ef1627`, `4dbb356`.

**2. [Rule 3 - Blocking] Biome a11y lint rejected `<label>` wrapping custom RadioGroupItem**
- **Found during:** Task 2 biome check.
- **Issue:** `lint/a11y/noLabelWithoutControl` cannot detect that RadioGroupItem is a form control.
- **Fix:** Replaced three `<label>` wrappers with `<span>` (the Base UI Radio.Root already carries the correct semantics).
- **Commit:** `1ef1627`.

**3. [Rule 3 - Blocking] `lint/a11y/useSemanticElements` required `<output>` over `<div role="status">`**
- **Found during:** Task 2 biome check.
- **Fix:** Switched warning row to `<output aria-live="polite">` — HTML `<output>` has implicit role=status, so the test's `getByRole('status')` continues to work.
- **Commit:** `1ef1627`.

## Deferred Issues

None introduced by this plan. Pre-existing untracked `apps/desktop/src/features/recorder/video-output/bitrate.test.ts` (missing its `./bitrate` sibling) is logged in the phase's `deferred-items.md` and belongs to a different wave.

## Self-Check: PASSED

- `apps/desktop/src/features/post-production/export-modal/advanced-copy.ts` — FOUND
- `apps/desktop/src/features/post-production/export-modal/encoder-options-table.ts` — FOUND
- `apps/desktop/src/features/post-production/export-modal/encoder-options-table.test.ts` — FOUND
- `apps/desktop/src/features/post-production/export-modal/advanced-output-options.tsx` — FOUND
- `apps/desktop/src/features/post-production/export-modal/advanced-output-options.test.tsx` — FOUND
- `apps/desktop/src/features/post-production/export-modal/export-modal.tsx` — MODIFIED
- Commit `706332a` — FOUND
- Commit `1ef1627` — FOUND
- Commit `4dbb356` — FOUND
