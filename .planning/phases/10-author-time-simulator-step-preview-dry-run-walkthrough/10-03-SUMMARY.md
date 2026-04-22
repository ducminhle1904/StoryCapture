---
phase: 10
plan: 03
wave: 3
subsystem: editor-ui
tags: [simulator, codemirror, zustand, timeline, promote-fallback]
dependency-graph:
  requires:
    - "10-02 (simulator command surface + SimulatorEvent union + TS IPC facade)"
    - "10-01 (StepFrame.match_kind discriminator)"
    - "09-04 (author Live Preview stream + previewEnabled gating)"
  provides:
    - "useSimulatorStore Zustand slice"
    - "SimulatorTimeline filmstrip + scrubber + Promote-to-fallback (fuzzy-gated) + error bar"
    - "simulator-decoration: setActiveFrame StateEffect, simulatorDecorationField, simulatorDecorationTheme, caretLineToOrdinal, buildOrdinalLineMap"
    - "simulator-keymap: Cmd-./Cmd-Shift-./Esc bindings + 'Preview to here' contextmenu overlay"
    - "Editor readOnly + running-only banner on story-editor.tsx (D-08)"
    - "SimulatorFrameView component: static StepFrame image + bbox + cursor overlay"
  affects:
    - "apps/desktop/src/routes/editor.tsx (SimulatorTimeline mounted, Live Preview slot gated on simulatorActiveFrame)"
tech-stack:
  patterns:
    - "StateField + StateEffect line decoration synced to simulatorStore.currentFrameOrdinal"
    - "Extension context closure: createSimulatorKeymap captures ref-getter closures so run-time values stay fresh without re-mounting the editor"
    - "Dead Live Preview swap via conditional render — LivePreview remounts cleanly on return to idle"
key-files:
  created:
    - "apps/desktop/src/state/simulatorStore.ts"
    - "apps/desktop/src/features/editor/simulatorStore.test.ts"
    - "apps/desktop/src/features/editor/simulator-decoration.ts"
    - "apps/desktop/src/features/editor/simulator-decoration.test.ts"
    - "apps/desktop/src/features/editor/simulator-keymap.ts"
    - "apps/desktop/src/features/editor/SimulatorTimeline.tsx"
    - "apps/desktop/src/features/editor/SimulatorTimeline.test.tsx"
    - ".planning/phases/10-author-time-simulator-step-preview-dry-run-walkthrough/10-03-SUMMARY.md"
    - ".planning/phases/10-author-time-simulator-step-preview-dry-run-walkthrough/10-03-SMOKE.md"
  modified:
    - "apps/desktop/src/features/editor/codemirror-setup.ts"
    - "apps/desktop/src/features/editor/story-editor.tsx"
    - "apps/desktop/src/features/editor/preview-panel.tsx"
    - "apps/desktop/src/routes/editor.tsx"
decisions:
  - "D-00: zero dryrun/DryRun references in new code"
  - "D-07: Promote button rendered strictly when frame.match_kind === 'fuzzy'"
  - "D-08: banner rendered ONLY on runState==='running'; failed-run UX lives in SimulatorTimeline error bar (§7)"
  - "D-09: simulatorStore owns its reducer; not shared with dryRunStore"
metrics:
  duration: "~55min"
  completed: "2026-04-22"
---

# Phase 10 Plan 03: Editor UI — SimulatorTimeline + Preview-to-here (Wave 3) Summary

One-liner: Editor-side author UI for the simulator — Zustand store + reducer, CodeMirror line decoration, 80x56 filmstrip with match_kind-gated Promote button, running-only banner + readOnly, Cmd-. / Cmd-Shift-. keymap, Preview-to-here context menu, and Preview-panel static-frame swap with bbox + cursor overlay.

## Scope

- `useSimulatorStore` Zustand slice (frames, currentFrameOrdinal, runState, sessionId, totalSteps, error, dismissedCoexistenceHint, handleEvent over 6-variant SimulatorEvent union, setCurrentFrameOrdinal clamp, resetToIdle, dismissCoexistenceHint persisted via localStorage).
- `simulator-decoration.ts` — StateEffect + StateField + theme (accent-primary 2px left stripe + 10% alpha line bg), plus `caretLineToOrdinal` (plan-spec shape) and `buildOrdinalLineMap` (parse.ts shape) helpers.
- `simulator-keymap.ts` — Mod-. / Mod-Shift-. / Escape bindings routing via simulatorStart / simulatorStepTo / simulatorCancel; right-click context menu with "Preview to here" + ⌘. kbd hint, disabled with suffix during running.
- `SimulatorTimeline.tsx` — Run/Cancel, 80x56 frame cards with match chip + Promote icon (strictly `match_kind === "fuzzy"` gate), scrubber, selector strip with click-to-copy, failed-state error bar + selector copy, dismissible co-existence hint, preview-off inline error.
- `story-editor.tsx` — `EditorState.readOnly.of(runState === "running")`, motion banner in running state only (D-08 verbatim), setActiveFrame dispatched when currentFrameOrdinal changes.
- `preview-panel.tsx` — `SimulatorFrameView` component (convertFileSrc img + bbox overlay scaled to natural resolution + 8px cursor dot + motion crossfade 100ms).
- `editor.tsx` — Mount SimulatorTimeline sibling of ConsolePane; Live Preview slot checks simulatorActiveFrame first, falls back to LivePreview or PreviewSurface.

## Commits

| # | Hash     | Subject |
|---|----------|---------|
| 1 | d5fcc44  | `feat(10-03): add simulatorStore zustand slice + reducer tests` |
| 2 | 199f335  | `feat(10-03): add CodeMirror simulator line decoration + theme` |
| 3 | 65df041  | `feat(10-03): SimulatorTimeline filmstrip + scrubber + promote gate + error bar` |
| 4 | 1daf3b3  | `feat(10-03): editor banner + readOnly + Cmd-. keymap + ctx menu + timeline mount` |
| 5 | bc0df39  | `feat(10-03): preview panel swaps live canvas for static StepFrame during simulator runs` |

## Test Coverage

| Suite | Result |
|-------|--------|
| `simulatorStore.test.ts` | 7/7 — all 6 SimulatorEvent variants + clamp + hint persistence |
| `simulator-decoration.test.ts` | 3/3 — setActiveFrame adds decoration, null clears, `caretLineToOrdinal` walks AST |
| `SimulatorTimeline.test.tsx` | 7/7 — idle state, running→Cancel, N frames render, scrubber updates ordinal, **Promote gated strictly on match_kind==='fuzzy' (1 button on 3 frames: primary+fuzzy+none)**, preview-off disables Run, failed error bar |
| Full `src/features/editor + src/features/recorder` | 112/112 (baseline preserved) |

## Regression Gates

- `pnpm exec tsc --noEmit` → clean
- `pnpm exec vitest run src/features/editor src/features/recorder` → 112/112
- `git diff --name-only apps/desktop/src-tauri/ crates/` → **empty** (Wave 3 is frontend-only)
- `git status packages/shared-types/src/ipc.ts` → clean (no regeneration)
- `grep -rn "dryRun\|DryRun\|intelligence::dryrun" <all new files>` → 0 matches (D-00 isolation)
- `grep -n "match_kind === \"fuzzy\"" apps/desktop/src/features/editor/SimulatorTimeline.tsx` → 1 match (Promote gate)
- `grep -n "runState === \"failed\"" apps/desktop/src/features/editor/story-editor.tsx` → 0 matches (D-08: banner NEVER on failed)

## Deviations from Plan

### 1. [Rule 3 - Correctness] AST span shape differs between plan spec and parse.ts

**Found during:** Task 2 wiring.
**Issue:** Plan's `caretLineToOrdinal` assumes `span: { start_line, end_line }` but `parse.ts` ships commands with `span: { start, end, line, col }` (single-line position, no range). Kept `caretLineToOrdinal` verbatim for the unit test fixture, added a parallel `buildOrdinalLineMap` that maps the real Command shape to both `ordinalToLine` and `lineToOrdinal` — used by the keymap and story-editor's decoration effect dispatch.
**Files:** `simulator-decoration.ts`.
**Commit:** 199f335.

### 2. [Rule 3 - Correctness] Keymap built via closure-factory, not static array

**Found during:** Task 4a.
**Issue:** The Cmd-. binding needs access to projectFolder/storyPath/streamId which are route-level props and change over lifecycle. A static `keymap.of([...])` in `codemirror-setup.ts` can't see them. Refactored `storyEditorExtensions(simulatorCtx?)` to accept a `SimulatorKeymapContext` with three getter closures; StoryEditor captures those via refs. Extension array is built once; closures read latest ref values at bind time.
**Files:** `codemirror-setup.ts`, `simulator-keymap.ts`, `story-editor.tsx`.
**Commit:** 1daf3b3.

### 3. [Rule 2 - Correctness] Right-click context menu implemented as DOM overlay

**Found during:** Task 4a.
**Issue:** Plan specified "context menu overlay" but CM6 has no built-in menu primitive. Implemented a plain `document.createElement` menu at `event.clientX/Y` attached to body with 1-item button + ⌘. kbd hint; auto-dismissed on outside mousedown. Disabled with copy "Preview to here — run in progress" when runState==='running'. Satisfies UI-SPEC §5 and the ARIA `aria-keyshortcuts="Meta+Period"` requirement.
**Files:** `simulator-keymap.ts`.
**Commit:** 1daf3b3.

### 4. [Rule 3 - Plan-fidelity vs functional reality] SimulatorFrameView exported from preview-panel.tsx

**Found during:** Task 4b.
**Issue:** Plan specified modifying `preview-panel.tsx` for the live/static swap, but that file is not currently rendered in `editor.tsx` (the Live Preview slot is inlined). To satisfy the plan's acceptance greps AND make the feature actually work, the swap logic lives as an exported `SimulatorFrameView` component in `preview-panel.tsx`; `editor.tsx` imports and composes it ahead of LivePreview in the Live Preview slot. Both surfaces agree: PreviewPanel's own render path and editor.tsx's Live Preview slot honour simulatorActiveFrame.
**Files:** `preview-panel.tsx`, `routes/editor.tsx`.
**Commit:** bc0df39.

## Authentication Gates

None — all commands go through `simulator_*` Tauri IPC that reuses the 9-04 author-session Chromium. No keychain/OAuth interaction in Wave 3.

## Known Stubs

None. All visible UI is wired to live state or the 10-02 IPC. No placeholder copy, no hardcoded empty arrays flowing to UI, no TODO/FIXME markers in new code.

## What Wave-and-beyond Can Consume

- **`SimulatorFrameView`** is a standalone export — picker/relocation (Phase 11) can reuse it for element picker overlays.
- **`buildOrdinalLineMap`** is the canonical ordinal↔line mapper for Story AST; Phase 11-05 (picker-in-preview click-to-select) can reuse it for reverse lookup.
- **Context menu pattern** demonstrates a clean CM6 domEventHandler overlay — reusable for Phase 11's picker right-click.

## Self-Check: PASSED

- [x] `apps/desktop/src/state/simulatorStore.ts` exists, exports `useSimulatorStore`.
- [x] `apps/desktop/src/features/editor/simulator-decoration.ts` exists; exports `setActiveFrame`, `simulatorDecorationField`, `simulatorDecorationTheme`, `caretLineToOrdinal`, `buildOrdinalLineMap`.
- [x] `apps/desktop/src/features/editor/SimulatorTimeline.tsx` exists; `grep match_kind === "fuzzy"` → 1 hit.
- [x] `apps/desktop/src/features/editor/simulator-keymap.ts` exists; 3 key bindings + contextmenu handler.
- [x] `apps/desktop/src/features/editor/story-editor.tsx` renders banner only on `runState === "running"`; `grep runState === "failed"` → 0.
- [x] `apps/desktop/src/features/editor/preview-panel.tsx` exports `SimulatorFrameView`; `convertFileSrc` + `matched_bbox` + `cursor_xy` all present.
- [x] `apps/desktop/src/routes/editor.tsx` mounts SimulatorTimeline and gates Live Preview slot on `simulatorActiveFrame`.
- [x] All 5 commits present in git log: `d5fcc44`, `199f335`, `65df041`, `1daf3b3`, `bc0df39`.
- [x] `git diff --name-only apps/desktop/src-tauri/ crates/` → empty (no backend changes).
- [x] `git status packages/shared-types/src/ipc.ts` → clean (no regeneration).
- [x] Typecheck clean; 112/112 vitest baseline preserved.
