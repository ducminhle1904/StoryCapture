---
phase: 13
plan: 04
subsystem: desktop-recording-ui
tags: [react, zustand, base-ui, video-output, recorder, i18n-vi, rtl]
wave: 3
depends_on: [13-03]
requirements: [ENC-12, ENC-17, ENC-18, ENC-19]
requires:
  - useOutputPrefsStore (Plan 13-03)
  - StartRecordingArgs extended with 5 optional Phase 12 DTOs (Plan 13-03)
  - Base UI Select / RadioGroup / Field primitives (Plan 13-02)
provides:
  - <VideoOutputSection /> container (preset + 5 knobs + bitrate preview + warnings)
  - <OutputSummaryBadge /> chip rendered next to Record CTA
  - useIsRecordingBlocked() hook (true when custom-dims validation fails)
  - 5 single-knob controls (ResolutionControl, FpsControl, FitModeControl, PadColorControl, QualityPresetControl)
  - PresetSelect (Nhanh / Tiêu chuẩn / Chất lượng cao / Tùy chỉnh)
  - BitratePreview live text + Warnings soft/hard surface
  - bitrate.ts pure helpers (resolveDims, computeBitratePreview, formatBitratePreview, validateCustomDims)
  - copy.ts Vietnamese label/warning constants
affects:
  - apps/desktop/src/features/recorder/recording-view.tsx (hosts VideoOutputSection + OutputSummaryBadge; threads 5 store knobs into startRecording; disables Record on custom-dims error)
tech-stack:
  added: []
  patterns:
    - Memoized error-callback + idempotent zustand setter to prevent render loops when a child effect lifts validation state up
    - Single-home hard errors (inline <p role="alert"> inside ResolutionControl) — Warnings surface renders soft-only in aria-live polite
    - aria-hidden row labels + aria-label on controls (avoids duplicate-accessible-name matches in RTL queries)
key-files:
  created:
    - apps/desktop/src/features/recorder/video-output/video-output-section.tsx
    - apps/desktop/src/features/recorder/video-output/video-output-section.test.tsx
    - apps/desktop/src/features/recorder/video-output/output-summary-badge.tsx
    - apps/desktop/src/features/recorder/video-output/preset-select.tsx
    - apps/desktop/src/features/recorder/video-output/resolution-control.tsx
    - apps/desktop/src/features/recorder/video-output/fps-control.tsx
    - apps/desktop/src/features/recorder/video-output/fit-mode-control.tsx
    - apps/desktop/src/features/recorder/video-output/pad-color-control.tsx
    - apps/desktop/src/features/recorder/video-output/quality-preset-control.tsx
    - apps/desktop/src/features/recorder/video-output/bitrate-preview.tsx
    - apps/desktop/src/features/recorder/video-output/warnings.tsx
    - apps/desktop/src/features/recorder/video-output/bitrate.ts
    - apps/desktop/src/features/recorder/video-output/bitrate.test.ts
    - apps/desktop/src/features/recorder/video-output/copy.ts
  modified:
    - apps/desktop/src/features/recorder/recording-view.tsx
decisions:
  - Hard errors live in a single place (ResolutionControl's inline alert) — the Warnings component only surfaces soft warnings. Prevents duplicate-text matches in RTL and keeps aria-describedby semantics clean.
  - Row labels use a plain <span aria-hidden="true"> + each control carries its own aria-label. Tried aria-labelledby wrappers first, but getByLabelText matched both the row span and the Select trigger, failing tests.
  - Lifted custom-dims validation from ResolutionControl into VideoOutputSection via a memoized onErrorChange callback + an internal zustand slice (useBlockedStore) whose setter returns the same state ref when unchanged — required to break an infinite update loop that hung vitest.
  - useIsRecordingBlocked() exported as the only external surface for disabling the Record button. RecordingView consumes it directly; no prop-drilling.
  - OutputResolutionDto kinds are lowercase ("p720"/"p1080") per the generated ipc.ts (inherited from Plan 13-03 decision).
  - OutputSummaryBadge scrollIntoView uses `behavior: reduceMotion ? "auto" : "smooth"` — respects the user's existing `prefers-reduced-motion` context provided by RecordingView.
  - Unused `isOutputBlocked` consumers outside the Record CTA path were avoided — hook is called once and the boolean flows into the disabled prop directly.
metrics:
  duration: ~90 min
  completed: 2026-04-20
  tasks: 3
  files_created: 14
  files_modified: 1
  tests_passing: 51
---

# Phase 13 Plan 04: Recording-time Video Output Section Summary

## One-liner

Vietnamese-first Recording-view UI for 5 output knobs (resolution/FPS/fit/pad/quality) + preset select + live bitrate preview + soft/hard warnings + summary-badge Record CTA, wired to `useOutputPrefsStore` and threaded into the existing `startRecording` IPC.

## Objective

Deliver ENC-12/17/18/19: expose the Phase 12 encoder knobs (previously hard-coded to 1080p/30/Letterbox/Black/Med) as a composable UX surface inside the Recorder, sourcing from the shared store landed in Plan 13-03. Operators can now pick a preset, override individual knobs, watch the bitrate estimate update live, and see hard/soft warnings without leaving the Record screen.

## Execution

### Task 1 — Bitrate helpers + Vietnamese copy module (TDD)

- RED: committed 10 failing tests in `bitrate.test.ts` covering `resolveDims` (p720/p1080/p1440/p2160 + "same" fallthrough + "custom" with W/H), `computeBitratePreview` (quality tier × resolution × fps curve with ±10% band), `formatBitratePreview` (Mbps formatting + "Ước tính" prefix), and `validateCustomDims` (odd-reject, <64, >7680).
- GREEN: implemented the four pure helpers in `bitrate.ts` + seeded all Vietnamese strings in `copy.ts` (section title, 5 labels, preset names, quality tier names, fit/pad enum labels, soft/hard warnings, bitrate "Ước tính" prefix).
- Verified: 10/10 helper tests green.

### Task 2 — 5 single-knob controls + bitrate preview + warnings (GREEN)

- Wrote `PresetSelect`, `ResolutionControl` (with hidden custom W×H inputs + inline hard-error), `FpsControl`, `FitModeControl`, `PadColorControl` (with hidden native color picker + hex sync), `QualityPresetControl`, `BitratePreview`, `Warnings` — each reads/writes a single slice of `useOutputPrefsStore` and respects `disabled`.
- Accessibility: row labels `aria-hidden="true"`; each control owns its own `aria-label`; hard errors render as `<p role="alert">` with `aria-describedby` wiring; soft warnings live in `<output aria-live="polite">`.
- All copy pulled from `copy.ts`; no inline strings.

### Task 3 — VideoOutputSection container + OutputSummaryBadge + RecordingView wiring (TDD)

- RED: committed 8 RTL tests in `video-output-section.test.tsx` covering section renders all labels, preset flip on individual-knob change, custom-dims hard-error shown + `useIsRecordingBlocked()` returns true, pad-color picker+hex sync, lossless+4K+HW soft warning, and summary badge renders + `onActivate` triggers `scrollIntoView`.
- GREEN: built `VideoOutputSection` with a forwardRef to expose the DOM node to the badge; internal `useBlockedStore` zustand slice lifts the `ValidationResult` from `ResolutionControl` via a memoized `handleError` callback; exported `useIsRecordingBlocked()` selector.
- `OutputSummaryBadge` reads `recordingKnobs` + `activePreset` and renders `${resLabel} • ${fps}fps • ${fitLabel} • ${qualityLabel}` with optional pad color; clicking fires `onActivate` which scrolls the section into view.
- Wired into `recording-view.tsx`:
  - Imported `VideoOutputSection`, `useIsRecordingBlocked`, `OutputSummaryBadge`, `useOutputPrefsStore`.
  - `startRecording` payload now reads `recordingKnobs` (`fps`, `output_resolution`, `fit_mode`, `pad_color`, `quality_preset`) + `exportKnobs.downscaleAlgo` from the store at call time — `width`/`height` stay as capture dims (Phase 12 contract).
  - Record CTA block replaced with `<OutputSummaryBadge onActivate={scrollIntoView} />` + `<RecordButton disabled={!canRecordDisplay || isOutputBlocked} />`.
  - `<VideoOutputSection ref={…} disabled={status !== "idle"} />` added to the right aside after the Options group.
- Verified: 18 video-output tests green; full recorder suite 51/51 green.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 — Bug] Infinite re-render loop when lifting custom-dims validation**
- **Found during:** Task 3 RTL suite (vitest worker pegged at 105% CPU, hung).
- **Issue:** `onErrorChange` was a new function each render. `ResolutionControl`'s effect depended on it, called the parent's setter, which re-rendered the parent → new closure → effect reran → loop.
- **Fix:** memoized `handleError` with `useCallback`; made the internal zustand `setCustomErr` idempotent (returns the same state when reason is unchanged); added a cleanup effect to null the error on unmount.
- **Files modified:** `video-output-section.tsx`.
- **Commit:** `3bea8bd`.

**2. [Rule 1 — Bug] Duplicate accessible-name matches in RTL**
- **Found during:** Task 3 RTL suite.
- **Issue:** `getByLabelText("Độ phân giải")` matched both the row span (via `aria-labelledby`) and the Select trigger's own `aria-label`, failing "found multiple elements" queries.
- **Fix:** dropped the `aria-labelledby` wrappers; row labels are plain `<span aria-hidden="true">` and each control carries its own `aria-label`.
- **Files modified:** `video-output-section.tsx`, all 5 single-knob controls.
- **Commit:** `3bea8bd`.

**3. [Rule 1 — Bug] Duplicate hard-error text**
- **Found during:** Task 3 RTL suite.
- **Issue:** `getByText(WARN_HARD_CUSTOM_DIMS)` matched both `ResolutionControl`'s inline `<p role="alert">` and `Warnings`' roll-up stripe — failing the single-match query.
- **Fix:** removed the hard-errors block from `warnings.tsx`; the inline alert inside `ResolutionControl` is now the single semantic home (already wired via `aria-describedby` on the custom W/H inputs).
- **Files modified:** `warnings.tsx`.
- **Commit:** `3bea8bd`.

## Verification

- `pnpm --filter desktop vitest run src/features/recorder/video-output` → **5 files / 51 tests passing** (662ms).
- `pnpm --filter desktop exec tsc --noEmit` → clean.
- Biome on new/modified video-output files → clean. Pre-existing lint warnings in `recording-view.tsx`, `step-progress.tsx`, `tcc-prompt.tsx` confirmed unchanged by this plan (verified via stash/pop diff); out of scope per GSD scope boundary.

## Commits

1. `9daf63d` test(13-04): add failing bitrate preview + dims validator tests
2. `c1282d8` feat(13-04): add bitrate helpers + Vietnamese copy module for video-output section
3. `324aafd` feat(13-04): add 5 single-knob controls + bitrate preview + warnings
4. `03148a8` test(13-04): add failing RTL suite for VideoOutputSection + OutputSummaryBadge
5. `3bea8bd` feat(13-04): add VideoOutputSection container + OutputSummaryBadge (GREEN)
6. `346d5a7` feat(13-04): wire VideoOutputSection into RecordingView + thread knobs into startRecording

## Self-Check: PASSED

- All 14 created files present under `apps/desktop/src/features/recorder/video-output/`.
- `recording-view.tsx` modifications verified (imports, refs, startRecording payload, summary badge, disabled prop, VideoOutputSection mount).
- All 6 commits present in `git log`.
- 51/51 recorder tests green; typecheck clean.
