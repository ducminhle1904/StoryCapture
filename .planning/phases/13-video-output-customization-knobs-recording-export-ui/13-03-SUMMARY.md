---
phase: 13
plan: 03
subsystem: desktop-state-persistence
tags: [zustand, tauri-plugin-store, ipc, persistence, output-prefs]
wave: 2
depends_on: [13-01, 13-02]
requires:
  - EncoderOptionsDto + 5 output DTOs (Plan 12-04 + 13-01)
  - tauri-plugin-store registered (Plan 13-02)
  - shadcn Base UI primitives (Plan 13-02 — not consumed here, reserved for Wave 3)
provides:
  - useOutputPrefsStore (cross-feature Zustand slice)
  - PRESET_BUNDLES (Quick / Standard / High Quality) + matchPreset()
  - DEFAULT_EXPORT_KNOBS (CD-13-04 anchor)
  - initOutputPrefs() (boot-time hydrator + debounced write-back)
  - migrate() + resolveOverride() (silent seed + project > global precedence)
  - loadProjectOverride() / saveProjectOverride() (per-project .storycapture/output.json IO)
  - STORE_FILE / STORE_KEY / LATEST_VERSION + getStore() singleton
  - StartRecordingArgs extended with 5 optional Phase 12 DTOs
  - ExportOutput extended with encoder_options?: EncoderOptionsDto
affects:
  - apps/desktop/src/main.tsx (bootstrap now awaits initOutputPrefs)
  - docs/CONVENTIONS.md (output-prefs listed as second slice-composition exception)
tech-stack:
  added:
    - zustand subscribe-based persistence pattern (first in repo)
  patterns:
    - Boot-time async hydrate before createRoot().render()
    - Debounced (250ms) subscribe → plugin-store write-back
    - Silent seed migrator with version bump (D-13-06)
key-files:
  created:
    - apps/desktop/src/state/output-prefs.ts
    - apps/desktop/src/state/output-prefs.test.ts
    - apps/desktop/src/lib/output-prefs-persist.ts
    - apps/desktop/src/lib/output-prefs-persist.test.ts
    - apps/desktop/src/ipc/output-prefs.ts
  modified:
    - apps/desktop/src/ipc/encode.ts
    - apps/desktop/src/ipc/export.ts
    - apps/desktop/src/main.tsx
    - docs/CONVENTIONS.md
decisions:
  - OutputResolutionDto kinds are lowercase ("p720" / "p1080") in the generated ipc.ts, not the "P720" shown in the plan — codebase follows the generated DTO.
  - Export container enum is "webm" (not "web-m" as written in the plan draft); matches ContainerDto from shared-types.
  - hwEncoder kept as free-form string at the UI layer — Plan 13-05 maps it to HardwareEncoderDto enum values when building the IPC payload. Keeps "auto" / "software" / probed-name UX simple without a translation table at the store.
  - downscaleAlgo narrowed to "lanczos" | "bicubic" | "bilinear" per plan; ScaleAlgoDto also exposes "area" but Phase 13 UX does not offer it.
  - main.tsx bootstraps via `root = createRoot(container); async function bootstrap() { await initOutputPrefs(); root.render(…) }` — avoids the biome noNonNullAssertion lint while keeping a single createRoot call (strict-mode safe).
  - Persistence uses `Store.load(STORE_FILE)` cached once per module; subscribe writes the full PersistShape (not diffed) every 250ms — simple + sufficient for the tiny payload.
metrics:
  duration: ~45 min
  completed: 2026-04-20
  tasks: 3
  files_created: 5
  files_modified: 4
  tests_passing: 17
---

# Phase 13 Plan 03: Shared Output-Prefs Store + Persistence + IPC Extensions Summary

## One-liner

Cross-feature Zustand store with plugin-store global persistence, per-project override file, silent-seed migrator, and extended StartRecordingArgs/ExportOutput IPC types — the single shared contract Wave 3 (13-04, 13-05) consumes.

## Objective

Build the cohesive data contract (D-13-03 preset model + D-13-04 shared pool + D-13-05 global+project persistence + D-13-06 silent migration) in one plan so the Recording View and Export Modal can both pull from a single typed source of truth without coordinating around half-defined shapes.

## Execution

### Task 1 — Zustand store + preset matching (TDD)

- RED: committed 9 failing tests covering construction defaults, applyPreset, individual-knob-flips-to-Custom, accidental-match-named-preset, export-knob isolation, same-value-no-flip, and a `// @ts-expect-error` type-level check.
- GREEN: implemented `useOutputPrefsStore` with `PRESET_BUNDLES`, `DEFAULT_EXPORT_KNOBS`, `matchPreset()` (JSON round-trip deep equal over the 5-knob shape), and flat setters. Setters for recording knobs auto-match; setters for export knobs leave `activePreset` alone.
- Verified: 9/9 tests green, typecheck clean.

### Task 2 — Persistence layer + main.tsx bootstrap (TDD)

- RED: committed 8 failing tests for `migrate` (null → seed, valid → unchanged, missing-fields → seed-fallback, version 0 → 1, user qualityValue propagation, silent-seed qualityValue null) and `resolveOverride` (project override merges into global, null project returns global).
- GREEN:
  - `apps/desktop/src/ipc/output-prefs.ts` — `Store.load` cached once; exports `STORE_FILE`, `STORE_KEY`, `LATEST_VERSION`, `getStore()`.
  - `apps/desktop/src/lib/output-prefs-persist.ts` — `migrate()`, `resolveOverride()`, `initOutputPrefs()` (hydrate → subscribe with 250ms debounce), `loadProjectOverride()` / `saveProjectOverride()` (plugin-fs IO at `<project>/.storycapture/output.json`, Vietnamese toast on failure).
  - `apps/desktop/src/main.tsx` — wrapped the render in an async `bootstrap()` that awaits `initOutputPrefs()` before `root.render()`. Kept `createRoot(container)` single-call and strict-mode safe.
- Verified: 8/8 persistence tests green, 17/17 total 13-03 tests green, typecheck clean.

### Task 3 — IPC extensions + CONVENTIONS.md doc

- `apps/desktop/src/ipc/encode.ts` — imported 5 DTOs from `@storycapture/shared-types` and appended `output_resolution`, `fit_mode`, `pad_color`, `quality_preset`, `scale_algo` (all `?: T | null`) to `StartRecordingArgs`.
- `apps/desktop/src/ipc/export.ts` — imported `EncoderOptionsDto`, appended `encoder_options?: EncoderOptionsDto | null` to `ExportOutput`.
- `docs/CONVENTIONS.md` line 24 — replaced the single post-production exception note with a 2-item list documenting `state/output-prefs.ts` as the second slice-composition / cross-feature-shared exception.
- Verified: typecheck clean, biome clean on all 8 touched files.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 — Bug] Plan sample DTOs used uppercase "P720" / "P1080" but the generated ipc.ts emits lowercase kinds ("p720", "p1080").**
- Found during: Task 1 GREEN, when building `PRESET_BUNDLES`.
- Issue: Using the plan's literal would have produced a type error against the regenerated `OutputResolutionDto`.
- Fix: Used the actual DTO variants — `{ kind: "p720" }`, `{ kind: "p1080" }`. No `as any` / cast; pure type-driven fix.
- Files: apps/desktop/src/state/output-prefs.ts, apps/desktop/src/state/output-prefs.test.ts
- Commit: `cb634d6`

**2. [Rule 1 — Bug] Plan sample "web-m" container literal does not exist in the DTO.**
- Found during: Task 1 design.
- Issue: `ContainerDto = "mp4" | "mov" | "webm"`.
- Fix: `ExportContainer = "mp4" | "mov" | "webm"` (contiguous string).
- Files: apps/desktop/src/state/output-prefs.ts
- Commit: `cb634d6`

**3. [Rule 1 — Lint] biome noNonNullAssertion on `createRoot(container!)`.**
- Found during: Task 3 biome sweep.
- Issue: CLAUDE.md "no workarounds" forbids `!` assertions; the plan draft used one.
- Fix: Moved `createRoot(container)` outside the async bootstrap fn (after the existence guard), and saved the `Root` handle for `bootstrap()` to render into.
- Files: apps/desktop/src/main.tsx
- Commit: `20efc05`

**4. [Rule 3 — Blocking] Worktree base mismatch at startup.**
- Found during: worktree_branch_check step.
- Issue: HEAD sat on main (`7fff8cc`) rather than the expected Wave 2 base `199207f`. Running the plan on main would have produced the wrong merge base and lost the Wave 1 context.
- Fix: `git reset --hard 199207f744f6acd9e20161fafdd7a47e358abf62` per the worktree protocol.
- Commit: (reset, no commit).

**5. [Rule 3 — Blocking] node_modules missing in worktree.**
- Found during: Task 1 RED — vitest could not resolve imports because pnpm had never run in this worktree.
- Fix: `pnpm install` at workspace root.
- Commit: (runtime-only, no commit).

### Style sweep

Biome `organizeImports` rewrote import order across all 5 created/modified TS files. Consolidated into a single follow-up commit `20efc05` per CONVENTIONS.md workflow rule (lint-clean diffs before landing).

## Acceptance Criteria

Task 1:
- ✅ `useOutputPrefsStore` exported from output-prefs.ts
- ✅ `PRESET_BUNDLES`, `DEFAULT_EXPORT_KNOBS`, `matchPreset` exported
- ✅ 9 tests pass (7 behavior + 2 matchPreset)
- ✅ `pnpm typecheck` clean — single `// @ts-expect-error` in tests only, no source-side casts

Task 2:
- ✅ `STORE_KEY` in ipc/output-prefs.ts
- ✅ `initOutputPrefs`, `migrate`, `resolveOverride`, `loadProjectOverride`, `saveProjectOverride` exported
- ✅ `initOutputPrefs` called from main.tsx before `root.render()`
- ✅ 8 persistence tests pass
- ✅ typecheck clean, no `@ts-ignore` / `as any` in source

Task 3:
- ✅ 5 DTO types referenced in ipc/encode.ts
- ✅ `encoder_options` + `EncoderOptionsDto` in ipc/export.ts
- ✅ `Phase 13 output-prefs` string present in docs/CONVENTIONS.md
- ✅ `Slice-composed` heading preserved
- ✅ desktop typecheck exits 0
- ✅ biome check on all 8 touched files exits 0

## Commits

- `5ad597b` test(13-03): add failing output-prefs store tests
- `cb634d6` feat(13-03): implement output-prefs Zustand store with preset matching
- `9fe0105` test(13-03): add failing output-prefs persistence tests
- `315c768` feat(13-03): add output-prefs persistence (plugin-store + per-project + debounced write-back)
- `b9e1887` feat(13-03): extend encode/export IPC DTOs + document output-prefs exception
- `20efc05` style(13-03): apply biome organize-imports sweep + drop non-null assertion

## TDD Gate Compliance

RED and GREEN commits present for both TDD tasks:
- Task 1 RED `5ad597b` → GREEN `cb634d6`
- Task 2 RED `9fe0105` → GREEN `315c768`

No REFACTOR commit was needed — GREEN implementations stayed tight.

## Follow-ups for Downstream Plans

- **13-04 (Recording View)**: Can now `import { useOutputPrefsStore } from "@/state/output-prefs"` and read `recordingKnobs` + `activePreset`, call `applyPreset` / `setRecordingKnob`. Thread `recordingKnobs` into `startRecording(args)` via the new 5 optional fields on `StartRecordingArgs` — remember `hwEncoder` is a UI-layer string, not the HW enum (Plan 13-05 owns the mapping).
- **13-05 (Export Modal)**: Can read `exportKnobs` + `activePreset`, call `setExportKnob`. Build a `deriveQualityControls(codec, hwEncoder, rateControl)` helper that reads `qualityValue` (null → Phase 12 default). Own the HardwareEncoderDto mapping when constructing the `encoder_options` payload.
- **Per-project override UX**: `loadProjectOverride` / `saveProjectOverride` are wired but no UI consumes them yet. Wave 3 or a later polish plan needs a surface (likely in recording-view project picker) to expose per-project overrides.

## Self-Check: PASSED

- ✅ apps/desktop/src/state/output-prefs.ts exists
- ✅ apps/desktop/src/state/output-prefs.test.ts exists
- ✅ apps/desktop/src/lib/output-prefs-persist.ts exists
- ✅ apps/desktop/src/lib/output-prefs-persist.test.ts exists
- ✅ apps/desktop/src/ipc/output-prefs.ts exists
- ✅ Commit 5ad597b in git log
- ✅ Commit cb634d6 in git log
- ✅ Commit 9fe0105 in git log
- ✅ Commit 315c768 in git log
- ✅ Commit b9e1887 in git log
- ✅ Commit 20efc05 in git log
- ✅ 17/17 vitest tests pass
- ✅ desktop typecheck exits 0
- ✅ biome check clean on all 8 touched files
