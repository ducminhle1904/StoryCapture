---
phase: 15-editor-post-production-feature-boundary-cleanup
plan: 03
wave: 3
subsystem: desktop-routing
tags: [phase-15, routing, landing-route, post-production, empty-state]
requires:
  - 15-01
  - 15-02
provides:
  - /post-production landing route (AppLayout child)
  - Project picker entry into post-production workspace
affects:
  - apps/desktop/src/routes/index.tsx
  - apps/desktop/src/routes/post-production-landing.tsx
tech-stack:
  added: []
  patterns:
    - React Router v7 data-router: static-before-param route ordering inside AppLayout
    - ProjectGrid reuse: differ only by onOpen handler target
key-files:
  created:
    - apps/desktop/src/routes/post-production-landing.tsx
  modified:
    - apps/desktop/src/routes/index.tsx
decisions:
  - "Reused ProjectGrid + useProjects verbatim — only openProject handler differs (/post-production/:id vs dashboard's /editor/:id)."
  - "Omitted New Story creation affordance on landing (D-06): toolbar shows title + meta + search only; the grid's mandatory New Story tile routes to dashboard for creation."
  - "Empty-state CTA is 'Go to Projects' (navigate to /) — per D-06 wording 'No recordings yet — record a story to start post-production.'"
  - "Deferred session_count split (with-recordings vs without) per 15-PATTERNS.md option (b) — safe default avoids the N+1 probe until a list_project_recordings IPC exists."
  - "Zero sidebar changes: matchPattern /^\\/post-production(\\/|$)/ already covered both routes."
metrics:
  duration: ~18m
  completed: 2026-04-21
requirements: [D-03, D-06, D-12]
---

# Phase 15 Plan 03: Post-Production Landing Route Summary

Wave 3 lands the `/post-production` (no param) landing route inside `AppLayout`, reusing `ProjectGrid` + `useProjects` with a handler that navigates to `/post-production/:projectId`. Existing `/post-production/:storyId` FullscreenLayout workspace and dashboard `/editor/:id` flow are preserved verbatim (D-12).

## Commits

| # | Hash      | Message                                                                   |
| - | --------- | ------------------------------------------------------------------------- |
| 1 | 7fd93be   | feat(15-03): add post-production landing route with project picker + empty-state |
| 2 | ea10dd4   | feat(15-03): register /post-production landing under AppLayout            |

## What Shipped

### Task 1 — PostProductionLandingRoute component
`apps/desktop/src/routes/post-production-landing.tsx` (new, 182 LoC). Structural fork of `dashboard.tsx`:
- Imports + `sc-toolbar` + `PageContentTransition` + `ProjectGrid` layout copied verbatim.
- `openProject = (id) => navigate(\`/post-production/${id}\`)` (vs dashboard's `/editor/:id`).
- `filterAndSort` trimmed to single sort mode (recent) — landing has no sort segmented control.
- Toolbar omits New Story (D-06: landing is not a creation surface).
- `EmptyPostProduction`: headline "No recordings yet" + subline "Record a story to start post-production." + CTA "Go to Projects" (navigates to `/`).
- `ProjectGrid`'s mandatory `onNewStory` prop receives `goToProjects` — clicking the grid's New Story tile routes to dashboard rather than opening a dialog here.
- ⌘F search hotkey preserved; sc-* tokens + Sc* primitives throughout.

### Task 2 — Router registration
`apps/desktop/src/routes/index.tsx` (+2 lines):
- Imported `PostProductionLandingRoute`.
- Added `{ path: "/post-production", element: <PostProductionLandingRoute /> }` as AppLayout child (between `/` and `/settings`).
- `/post-production/:storyId` under FullscreenLayout untouched.

## Sidebar / Command-Palette

Zero diffs. Pre-existing wiring was already correct:
- `sidebar.tsx` L46-47: `path: "/post-production"`, `matchPattern: /^\/post-production(\/|$)/`.
- `command-palette.tsx` L39, L81: "Render & Export…" + ⌘E both navigate to `/post-production`.

## Preservation (D-12)

- `dashboard.tsx` — 0 lines diff (confirmed via git log).
- `post-production.tsx` (storyId wrapper) — untouched.
- `EditorShell`, Phase 13 export, Phase 14 chrome — 0 lines diff.

## Verification

- `pnpm tsc --noEmit` — clean.
- `pnpm build` — 2.16s, success.
- `pnpm vitest run` — 201/209 pass. 8 failures are pre-existing (command-palette + related) carried from Wave 1/2 baseline, not regressions.
- `grep "path: \"/post-production" apps/desktop/src/routes/index.tsx` → exactly 2 entries.

## Deferred (follow-up phases)

- **session_count split on landing:** Safe default (b) ships now — landing shows all projects flat. With-recordings vs no-recordings grouping waits on a batched `list_project_recordings` IPC.
- **Scrubbable latest-recording playback:** Requires a recording-manifest IPC; Phase 15 stays empty-state-only per CONTEXT.md out-of-scope list.

## Deviations from Plan

None — plan executed exactly as written.

## Self-Check: PASSED

- FOUND: `apps/desktop/src/routes/post-production-landing.tsx`
- FOUND: commit 7fd93be
- FOUND: commit ea10dd4
- FOUND: router entry `path: "/post-production"` under AppLayout
- FOUND: existing `/post-production/:storyId` still under FullscreenLayout
