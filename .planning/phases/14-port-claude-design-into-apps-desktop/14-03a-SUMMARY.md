---
phase: 14
plan: 03a
subsystem: desktop-ui
tags: [dashboard, claude-design, gap-closure]
requires: [14-03]
provides: [dashboard-mock-structure]
affects:
  - apps/desktop/src/routes/dashboard.tsx
  - apps/desktop/src/features/dashboard/*
  - apps/desktop/src/components/page-content-transition.tsx
created: ["apps/desktop/src/features/dashboard/hash-accent.ts"]
modified:
  - apps/desktop/src/routes/dashboard.tsx
  - apps/desktop/src/features/dashboard/project-card.tsx
  - apps/desktop/src/features/dashboard/project-grid.tsx
  - apps/desktop/src/components/page-content-transition.tsx
deleted:
  - apps/desktop/src/features/dashboard/project-filters.tsx
decisions:
  - Defer status Segmented filter (no status field in Project model)
  - Defer RecentRenderRail (no render-history data source)
  - Defer Import .story + Browse templates CTAs (not wired — shown disabled)
  - Simplify: project-filters.tsx removed; search lives in the sc-toolbar per mock
metrics:
  commits: 4
  completed: 2026-04-21
---

# Phase 14 Plan 03a: Dashboard Mock Structure Gap Closure Summary

One-liner: Port Claude Design `dashboard.jsx` structure into the desktop dashboard — sc-toolbar with search + New Story, Active-section grid with dashed New Story tile, gradient ThumbMock cards, empty-state hero — preserving all existing IPC wiring per D-09.

## What Changed

- **`hash-accent.ts`** (new): 2-function helper — deterministic accent hue (0–359) + 3-char hex badge from project id.
- **`project-card.tsx`**: Rewritten to the mock's shape.
  - Gradient ThumbMock (radial + linear oklch gradients keyed off hue), simulated browser + `#hash` badge, falls back to `convertFileSrc(thumbnail_path)` when a thumbnail exists.
  - Title + subtitle (`N sessions` / `No sessions yet`).
  - Footer: `Clock` icon + `relativeTime(last_opened_at)`, ghost `Play` button, ghost `⋯` more button.
  - Card is `role="button"` + keyboard activation (Enter/Space). Inner action buttons stop propagation.
- **`project-grid.tsx`**: Rewritten. `grid-template-columns: repeat(auto-fill, minmax(240px, 1fr))`, `gap: 14px`, appends a dashed `New Story` ScCard tile that calls `onNewStory`.
- **`dashboard.tsx`** (route): Rewritten to the mock's `DashboardScreen` shape.
  - `sc-toolbar` with title `Projects`, meta line (`N stories · last opened X ago` or `No stories yet`), `ScInput` with search icon + `⌘F`, primary `New Story` button with `⌘N`.
  - Content body: `PageContentTransition.sc-scroll`. Shows loading card, error alert, `EmptyDashboard` (stacked film-strip hero + CTAs), or `Active` section header + `ProjectGrid`.
  - `useHotkeys("mod+n")` → open dialog; `useHotkeys("mod+f", { enableOnFormTags: true })` → focus search input.
  - `useProjects`, `useDashboardStore`, `NewProjectDialog`, `useNavigate`, `PageContentTransition` all preserved.
- **`page-content-transition.tsx`**: Extended to accept a `style` prop (needed to apply `flex: 1; padding: 20` from mock layout). Backward-compatible.
- **`project-filters.tsx`**: Deleted. The mock places search in the toolbar; the Segmented status filter is deferred (see below). The Sort (recent/name) segmented control was a local 14-01 addition not in the mock — dropped.

## Verification

- `pnpm --filter @storycapture/desktop typecheck` — pass
- `pnpm --filter @storycapture/desktop build` — pass (1 pre-existing vite warning about `ipc/capture.ts` dynamic import — unrelated to this plan)
- Visual parity: toolbar, Active heading, grid with dashed slot, empty-state hero all match mock lines 140–195 within primitive constraints.

## Deferred Items (per D-09 — preserve wiring, don't invent data)

| Feature                   | Reason                                                              | Blocking plan                    |
| ------------------------- | ------------------------------------------------------------------- | -------------------------------- |
| Status badge on card      | `Project` has no `status` field (ready/rendering/draft/failed)      | Future: render/status tracking   |
| Scene count + duration    | No scene/duration metadata on `Project` (e.g., `"7 scenes · 1m 24s"`) | DSL parsing + index persistence  |
| Rendering progress bar    | No per-project render-in-flight state surfaced                       | Export/render job registry       |
| Segmented status filter   | Depends on status field; shipping with non-functional options would mislead | Same as status badge     |
| RecentRenderRail          | No render-history data source                                        | Render job log + index           |
| Import `.story` CTA       | Handler not implemented; button rendered disabled with tooltip       | Import workflow plan             |
| Browse templates CTA      | Template registry not implemented; button rendered disabled          | Template library plan            |
| `session_count` in subtitle | `Project` list endpoint returns projects only; `ProjectFolderInfo.session_count` requires `open_project` call — not fetched in list view to avoid N+1. Subtitle falls back to `"No sessions yet"`. | Batch endpoint or denormalize count |
| `⋯` more-menu actions     | Stub `onMore?` handler on card; dashboard route does not wire it yet. Button still renders for visual parity. | Context-menu plan |
| "12 rendered this week" meta | No render counter; meta line uses "last opened" instead         | Render metrics                   |

## Deviations from Plan

### Rule 2 — auto-added

- **Extended `PageContentTransition` to accept `style`**: needed `flex: 1; padding: 20` on the scroll container to match mock layout. Kept backward-compatible. (Commit: d44af91)
- **Keyboard activation on card + dashed tile**: cards are `role="button"` so Enter/Space must work; stops-propagation on nested Play/More buttons so the wrapping click still navigates. Not spelled out in plan but required for accessibility (CLAUDE.md WCAG AA). (Commit: 7527758, 188ec37)
- **Disabled CTAs for Import / Browse templates**: mock renders them active, but wiring doesn't exist. Per CLAUDE.md "no workarounds" — rendered `disabled` with `title` tooltip rather than letting them silently no-op.

### Hotkey audit

- `⌘K` — command palette (existing). Not touched.
- `⌘N` — not previously bound. Safe.
- `⌘F` — not previously bound. Safe.
- `⌘,` — settings (via command palette entry), `⌘E` — export. No collisions.

## Preservation Check (D-09)

- No edit to: `App.tsx`, `title-bar.tsx`, `sidebar.tsx`, `editor.tsx`, `post-production.tsx`, `editor-shell.tsx`, `settings.tsx`, `recorder.tsx`, any `features/post-production/*`, any `features/export/*`.
- No references to `sc-shell`, `ScShell`, `ScTitleBar`, `ScSideNav` introduced.
- IPC surface unchanged. `useProjects`, `useCreateProject`, `useOpenProject`, `useRemoveProject` still exported and still used via `NewProjectDialog`.
- `useDashboardStore` API unchanged (search/sort/filter-tags). `sortMode` still drives `filterAndSort`; the UI toggle for sort was removed, but the store defaults to `"recent"` which matches user expectations and the mock.

## Commits

- `8fa12f8` feat(14-03a): add project-hash helper for accent hue + id badge
- `7527758` refactor(14-03a): rewrite ProjectCard to match dashboard.jsx mock structure
- `188ec37` refactor(14-03a): port ProjectGrid with dashed New Story empty-slot tile
- `d44af91` refactor(14-03a): port dashboard toolbar + Active section + empty state

## Self-Check: PASSED

- [x] `apps/desktop/src/features/dashboard/hash-accent.ts` FOUND
- [x] `apps/desktop/src/features/dashboard/project-card.tsx` FOUND (rewritten)
- [x] `apps/desktop/src/features/dashboard/project-grid.tsx` FOUND (rewritten)
- [x] `apps/desktop/src/routes/dashboard.tsx` FOUND (rewritten)
- [x] `apps/desktop/src/components/page-content-transition.tsx` FOUND (extended)
- [x] `apps/desktop/src/features/dashboard/project-filters.tsx` DELETED (intentional)
- [x] Commits 8fa12f8, 7527758, 188ec37, d44af91 present in `git log`
- [x] typecheck passes, build passes
