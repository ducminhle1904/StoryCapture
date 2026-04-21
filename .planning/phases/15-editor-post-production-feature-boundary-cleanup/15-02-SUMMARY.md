---
phase: 15-editor-post-production-feature-boundary-cleanup
plan: 02
subsystem: desktop-ui
tags: [phase-15, preview-surface, shared-component, webgpu]
requirements: [D-04, D-11, D-12]
dependency_graph:
  requires: [15-01]
  provides: [shared-preview-surface]
  affects: [editor-right-rail, post-production-preview-pane]
tech_stack:
  added: []
  patterns:
    - "Mode-aware shared component: delegates to existing implementation in one branch, renders inert placeholder in the other"
    - "TanStack Query one-shot read for empty-state gate (no new IPC, no Zustand slice)"
key_files:
  created:
    - apps/desktop/src/components/preview-surface/preview-surface.tsx
    - apps/desktop/src/components/preview-surface/index.ts
  modified:
    - apps/desktop/src/features/post-production/editor-shell.tsx
    - apps/desktop/src/routes/editor.tsx
decisions:
  - "Recording mode ships as empty-state only this phase — scrubbable playback deferred; no latest-recording IPC signal exists in ProjectFolderInfo (only session_count)"
  - "Composited branch delegates verbatim to PreviewPlayer; WebGPU init/dispose lifecycle untouched (D-11)"
metrics:
  duration_min: ~10
  completed: 2026-04-21
---

# Phase 15 Plan 02: Shared PreviewSurface Summary

Consolidated the Editor and Post-Production preview surfaces behind a single mode-aware `PreviewSurface` component. Composited mode delegates to the existing `PreviewPlayer` (WebGPU engine lifecycle preserved verbatim). Recording mode renders an empty-state only — gated on `ProjectFolderInfo.session_count` — because no latest-recording IPC signal exists this phase.

## Tasks Executed

| # | Name | Commit | Files |
|---|------|--------|-------|
| 1 | Author PreviewSurface component | `c29d622` | `components/preview-surface/{preview-surface.tsx,index.ts}` |
| 2 | Swap Post-Production + Editor consumers | `6db0412` | `features/post-production/editor-shell.tsx`, `routes/editor.tsx` |

## Behavior

- **Composited (`mode="composited"`)** — thin wrapper around `PreviewPlayer`. All props (`storyId`, `videoSrc`, `width`, `height`) forwarded verbatim. WebGPU init/dispose stays inside `PreviewPlayer` (D-11). No change to Zustand slices, transport controls, or rAF loop.
- **Recording (`mode="recording"`)** — reads `ProjectFolderInfo.session_count` via existing `fetchProjectFolder` through TanStack Query (key `["projects", projectId, "folder"]`). Renders the `sc-*` tokenized empty-state stage with `motion/react` fade-in:
  - `session_count === 0` (or loading): headline **"No recording yet"** + body **"Record a story to see the preview."**
  - `session_count > 0`: headline **"Recording available"** + body **"Scrubbable preview coming soon."**
  - No `<video>`, no `convertFileSrc`, no filesystem inference, no new IPC, no WebGPU references.

## Before / After — editor right rail preview JSX

Before:
```tsx
<div className="relative min-h-0 flex-1 overflow-hidden">
  <PreviewPanel
    thumbnailPath={previewBackdrop}
    sceneName={selectedSceneName}
    sceneMeta={selectedSceneMeta}
  />
</div>
```

After:
```tsx
<div className="relative min-h-0 flex-1 overflow-hidden">
  {projectId ? (
    <PreviewSurface mode="recording" projectId={projectId} />
  ) : null}
</div>
```

## Verification

- `pnpm tsc --noEmit` → clean (exit 0).
- `pnpm build` → clean (exit 0, 2.16s bundle).
- `pnpm vitest run` → 201 passed / 8 failed (29 files: 26 passed / 3 failed). The 8 failures (`nl-mode/ChatPanel`, `command-palette`, `settings/AccountsPage`) are pre-existing at commit `c29d622^` (verified via `git stash` baseline run) and unrelated to preview-surface. Post-production suite fully green.
- Negative greps on `preview-surface.tsx`: no `PreviewEngine`, `navigator.gpu`, `requestDevice`, `<video`, `convertFileSrc`, `list_recordings` (only `PreviewPlayer` re-export which isolates WebGPU in its own module).
- `session_count` referenced: ✅.
- Phase 13 export wiring: 0 diff (`features/export/`, `features/post-production/export-modal/`).
- Phase 14 chrome: `App.tsx`, `title-bar.tsx`, `sidebar.tsx`, `tokens.css`, `app.css`, `Sc*` primitives all 0 diff.

## Route-change WebGPU leak spot-check

Composited preview's init/dispose was not touched — `PreviewSurface` composited branch is an import-site swap only. The existing `<PageContentTransition>` route wrapper remounts the component on navigation, triggering `PreviewPlayer`'s existing `useEffect` cleanup (`engineRef.current?.dispose()` at L90-94 of `preview-player.tsx`). No new cleanup hooks needed.

## Deviations from Plan

None — plan executed exactly as written (recording mode amended to empty-state only per the amendment log in 15-CONTEXT.md).

## Deferred

- **Scrubbable playback of the latest recording in Editor's right rail** — deferred to a future phase. Requires an IPC that surfaces a playable path (none today: `ProjectFolderInfo` exposes only `session_count`, `exports_dir`, `story_path`). When added, the `RecordingPreview` subcomponent becomes the integration point.

## Self-Check: PASSED

- `apps/desktop/src/components/preview-surface/preview-surface.tsx` — FOUND
- `apps/desktop/src/components/preview-surface/index.ts` — FOUND
- Commit `c29d622` — FOUND
- Commit `6db0412` — FOUND
