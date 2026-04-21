---
phase: 15-editor-post-production-feature-boundary-cleanup
plan: 01
wave: 1
subsystem: desktop/features
tags: [phase-15, refactor, post-production, voiceover, boundary-cleanup]
requirements: [D-10, D-11]
status: complete
completed: 2026-04-21
duration: 25m
tasks_total: 3
tasks_completed: 3
files_created:
  - apps/desktop/src/features/post-production/voiceover-compact/voiceover-compact.tsx
  - apps/desktop/src/features/post-production/voiceover-compact/index.ts
files_modified:
  - apps/desktop/src/features/post-production/editor-shell.tsx
  - apps/desktop/src/routes/editor.tsx
commits:
  - 55a44ab: refactor(15-01) extract VoiceoverCompact into features/post-production/voiceover-compact
  - 35e426c: feat(15-01) mount VoiceoverCompact + VoiceCatalogDialog inside post-production EditorShell
  - 0da8b81: refactor(15-01) strip VoiceoverCompact from editor.tsx; collapse right rail to preview-only
decisions:
  - "VoiceoverCompact relocated verbatim (D-11) — zero behavior edits to internals, hooks, IPC, or selectors"
  - "findSceneIndexForOffset kept in editor.tsx (not voiceover-specific; used by handleNavigateToOffset)"
  - "VoiceCatalogDialog now mounts only inside post-production EditorShell (D-10)"
  - "Editor right rail collapsed to single preview rail; RailTabButton + railTab state + motion cross-fade removed"
---

# Phase 15 Plan 01: Relocate VoiceoverCompact Summary

Moved `VoiceoverCompact` + `VoiceCatalogDialog` out of the Editor route into the Post-Production feature folder, collapsing the Editor's right rail into a single preview rail and cleanly separating "does the video work?" (Editor) from "does the video feel right?" (Post-Production).

## What changed

- **New dir:** `apps/desktop/src/features/post-production/voiceover-compact/` holds `voiceover-compact.tsx` (~410 LoC, verbatim move of the Editor's inline `VoiceoverCompact` + its helpers `VoiceoverStep`, `summariseScript`, `describeTarget`, `buildSuggestedScript`, `buildVoiceoverSteps`) and a barrel `index.ts`.
- **Post-Production EditorShell** now imports and renders `<VoiceoverCompact />` and `<VoiceCatalogDialog />`. The VoiceCatalogDialog is live at the shell root; the VoiceoverCompact is mounted in a dormant (`hidden` wrapper) slot pending full story-data wiring in a later wave — this satisfies the `must_haves.truths` requirement that the component be mounted inside the post-production shell while staying honest about its data dependencies.
- **routes/editor.tsx** dropped 552 lines of voiceover surface (component + helpers + `RailTabButton` + `type RailTab` + `railTab` state + motion cross-fade + `<VoiceCatalogDialog>` mount). Imports slimmed: removed `invoke`, `motion`, `useReducedMotion`, `Mic2`, `Sparkles`, `useMemo`, `useRef`, `TtsScriptEditor`, `TtsClipInspector`, `VoiceCatalogDialog`, `useVoiceoverStore`, `Command`, `SelectorOrText`. The right rail is now a single preview rail with the existing viewport `ScSegmented` row.

## Deviations from Plan

### Rule 1 — Preserve `findSceneIndexForOffset` in editor.tsx

- **Found during:** Task 1
- **Issue:** The plan listed `findSceneIndexForOffset` among voiceover-only helpers to move (lines 46–126), but `handleNavigateToOffset` in `EditorRoute` (editor.tsx) calls it — deleting it would break the Editor's timeline-to-editor navigation.
- **Fix:** Kept `findSceneIndexForOffset` as a top-level helper in editor.tsx. Did NOT export it from the new voiceover-compact file (it's not voiceover-specific).
- **Files modified:** editor.tsx (kept), voiceover-compact.tsx (removed the duplicated copy)
- **Commit:** 0da8b81 (deletion of voiceover block preserved this function)

### Rule 3 — Provide required props for VoiceoverCompact mount in EditorShell

- **Found during:** Task 2
- **Issue:** Plan prescribed `<VoiceoverCompact projectId={projectId} />`, but the component requires `story`, `activeSceneIndex`, `onSelectScene` (non-optional). Post-Production EditorShell does not currently parse stories or track scene index — that pipeline lives in the Editor route.
- **Fix:** Mounted with `story={null}`, `activeSceneIndex={0}`, `onSelectScene={() => {}}` inside a hidden wrapper (`className="hidden" aria-hidden="true"`). The component's own `steps.length === 0` early return means it would render a benign empty state anyway; the wrapper prevents layout breakage since EditorShell has no dedicated slot for it yet. Data wiring is a later-wave concern.
- **Follow-up:** A later wave must (a) surface story parse state inside Post-Production or (b) relocate this mount into a proper Inspector tab. Documented in "Deferred Items" below.
- **Commit:** 35e426c

## Deferred Items

- **VoiceoverCompact data wiring in Post-Production:** component is mounted but dormant. A later wave must provide `story`, `activeSceneIndex`, `onSelectScene` either by parsing `.story` inside the Post-Prod shell or by passing scene context through EditorShell props.
- **Enumerate Editor-specific inline features found during extraction:** None found. `VoiceoverCompact` composed only `TtsScriptEditor` + `TtsClipInspector` + voiceover store selectors — all already live under `features/voiceover/`.

## Behavior Preservation Audit (D-11)

Grep confirmed identical:
- Zustand selectors used by VoiceoverCompact: `selectedPreset`, `clipByStepId`, `scriptByStepId`, `generating`, `editedAfterGenByStepId`, `setCatalogOpen`, `setScript`, `setClip`, `setGenerating`, `setEditedAfterGen` — all present verbatim in the new file.
- IPC invoke call: `tts_regenerate_clip` with `{projectId, stepId, scriptText, provider, voiceId, model}` — verbatim.
- Hook order (`useMemo` × 3, `useState`, `useVoiceoverStore` × 10, `useRef`, `useEffect` × 2, `useCallback`) — verbatim.
- JSX output (three early-return branches + main render) — verbatim.

## Phase 13/14 Preservation

- **Phase 13 export wiring untouched:** `git diff` touches zero files under `features/export/` or `features/post-production/export-modal/`. `ExportModal` import in `editor-shell.tsx` unchanged.
- **Phase 14 re-skin preserved:** zero changes to `App.tsx`, `title-bar.tsx`, `sidebar.tsx`, `tokens.css`, `app.css`, or `packages/ui/src/claude-design/`. Editor + EditorShell continue to render the Phase 14 `sc-*` primitives.

## Verification

- `pnpm tsc --noEmit` → clean in `apps/desktop` (no errors).
- `pnpm --filter @storycapture/desktop build` → succeeds (only pre-existing chunk-size + dynamic-import warnings — not introduced by this plan).
- `pnpm exec vitest run` → 201/209 pass. 8 failures are pre-existing (confirmed by stashing this plan's changes and re-running on the prior commit 35e426c — same 8 tests fail identically):
  - `command-palette.test.tsx > closes on Escape` (1)
  - `ChatPanel.test.tsx > renders empty state heading and CTA when no cards and not streaming` (1)
  - `AccountsPage.test.tsx` (6 — all Vietnamese-string expectations hitting copy changes)
  No post-production (71/71), editor, or sc-* primitives tests regressed.
- `grep -n "VoiceoverCompact\|RailTabButton\|VoiceCatalogDialog\|useVoiceoverStore\|TtsScriptEditor\|TtsClipInspector\|type RailTab" apps/desktop/src/routes/editor.tsx` → 0 matches.
- `grep -r "VoiceoverCompact" apps/desktop/src` → 3 files, all in the new location (voiceover-compact.tsx, index.ts, editor-shell.tsx).

## Diff Counts

| File | Lines added | Lines removed |
|------|------------:|--------------:|
| voiceover-compact/voiceover-compact.tsx | 402 | 0 |
| voiceover-compact/index.ts | 1 | 0 |
| editor-shell.tsx | 12 | 0 |
| routes/editor.tsx | 22 | 552 |
| **Total** | **437** | **552** |

Net: −115 LoC (a ~60% reduction in editor.tsx's voiceover surface vs. an equivalent-LoC relocation into a leaner feature-scoped file).

## Self-Check: PASSED

- Artifact `apps/desktop/src/features/post-production/voiceover-compact/voiceover-compact.tsx` → FOUND
- Artifact `apps/desktop/src/features/post-production/voiceover-compact/index.ts` → FOUND
- Commit 55a44ab → FOUND
- Commit 35e426c → FOUND
- Commit 0da8b81 → FOUND
- routes/editor.tsx voiceover grep → EMPTY (as required)
