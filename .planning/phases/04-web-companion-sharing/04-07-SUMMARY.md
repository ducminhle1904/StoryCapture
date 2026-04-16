---
phase: 04-web-companion-sharing
plan: 07
subsystem: ui
tags: [templates, marketplace, trpc, fork, seed-data, category-grid, prisma]

# Dependency graph
requires:
  - phase: 04-01
    provides: "Prisma schema with Template model, TemplateCategory enum"
  - phase: 04-02
    provides: "NextAuth v5 auth, protectedProcedure, publicProcedure, tRPC init"
  - phase: 04-06
    provides: "Workspace RBAC middleware, workspaceEditorProcedure"
provides:
  - Template tRPC router with listByCategory, getById, fork procedures
  - 12 curated seed templates across all 9 categories
  - Template marketplace page with category filter tabs and responsive grid
  - Fork-to-download flow (Blob download + clipboard copy)
affects: []

# Tech tracking
tech-stack:
  added: []
  patterns: [publicProcedure for read-only template browsing, atomic Prisma increment for fork count, Blob download for client-side file generation]

key-files:
  created:
    - apps/web/src/trpc/routers/template.ts
    - apps/web/prisma/seed.ts
    - apps/web/src/components/template-card.tsx
    - apps/web/src/components/template-grid.tsx
    - apps/web/src/app/(dashboard)/templates/page.tsx
  modified:
    - apps/web/src/trpc/routers/_app.ts
    - apps/web/package.json
    - apps/web/src/app/(dashboard)/layout.tsx

key-decisions:
  - "Fork returns storySource as downloadable .story file content rather than creating a new model -- cleanest v1 approach per D-05"
  - "Templates are public (publicProcedure) for browsing; fork requires auth (protectedProcedure)"
  - "Seed uses upsert with deterministic IDs for idempotent re-runs"

patterns-established:
  - "Category color mapping: shared constant for badge and gradient colors per TemplateCategory"
  - "Fork-as-download: Blob-based client-side file download for .story content"

requirements-completed: [WEB-06]

# Metrics
duration: 4min
completed: 2026-04-16
---

# Phase 4 Plan 07: Template Marketplace Summary

**12 curated seed templates across 9 categories with category-grid browse UI, fork-to-download .story files, and atomic fork count tracking**

## Performance

- **Duration:** 4 min
- **Started:** 2026-04-16T07:14:15Z
- **Completed:** 2026-04-16T07:18:27Z
- **Tasks:** 2
- **Files created:** 5
- **Files modified:** 3

## Accomplishments

- Template tRPC router with listByCategory (grouped results), getById (with 500-char preview), and fork (atomic forkCount increment + storySource return)
- 12 curated seed templates covering all 9 TemplateCategory values with realistic .story DSL content
- Template marketplace page with category filter pills, responsive 3/2/1 column grid, and fork dialog with download + clipboard copy
- Category-colored badges and gradient thumbnails for visual differentiation
- Templates nav link added to dashboard sidebar for discoverability

## Task Commits

1. **Task 1: Template tRPC router + seed script** - `4fe25c4` (feat)
2. **Task 2: Template marketplace UI** - `94a7a93` (feat)

## Files Created/Modified

- `apps/web/src/trpc/routers/template.ts` - listByCategory, getById, fork procedures with public/protected access
- `apps/web/prisma/seed.ts` - 12 seed templates with upsert for idempotent seeding
- `apps/web/src/components/template-card.tsx` - Card with category badge, gradient thumbnail, fork count, hover animation
- `apps/web/src/components/template-grid.tsx` - Category filter tabs + responsive grid layout
- `apps/web/src/app/(dashboard)/templates/page.tsx` - Marketplace page with fork dialog, Blob download, clipboard copy
- `apps/web/src/trpc/routers/_app.ts` - Added templateRouter
- `apps/web/package.json` - Added prisma.seed config
- `apps/web/src/app/(dashboard)/layout.tsx` - Added Templates nav link

## Decisions Made

- Fork returns storySource as downloadable .story file content (no new model needed per D-05)
- Templates are publicly browsable; fork requires authentication (redirects to sign-in if unauthenticated)
- Seed script uses deterministic IDs (`seed-{slugified-name}`) for idempotent upsert

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed TypeScript strict null check on grouped record access**
- **Found during:** Task 1 (template router)
- **Issue:** `grouped[template.category].push()` flagged as possibly undefined by tsc
- **Fix:** Added non-null assertion after the initialization guard
- **Files modified:** apps/web/src/trpc/routers/template.ts
- **Committed in:** 4fe25c4 (Task 1 commit)

**2. [Rule 2 - Missing Critical] Added Templates link to dashboard sidebar navigation**
- **Found during:** Task 2 (marketplace UI)
- **Issue:** Templates page existed but was unreachable from dashboard navigation
- **Fix:** Added Templates nav link to dashboard layout sidebar
- **Files modified:** apps/web/src/app/(dashboard)/layout.tsx
- **Committed in:** 94a7a93 (Task 2 commit)

---

**Total deviations:** 2 auto-fixed (1 bug, 1 missing critical)
**Impact on plan:** Both fixes necessary for correctness and usability. No scope creep.

## Threat Surface Scan

All mitigations from the plan's threat model implemented:
- T-04-24 (Tampering / fork count): forkCount incremented atomically via Prisma `{ increment: 1 }`, no user input for count value
- T-04-25 (Info Disclosure / template source): storySource intentionally public for curated system templates

No new threat surface beyond what is documented in the plan's threat model.

## Issues Encountered

None

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Template marketplace complete with seed data and fork functionality
- Ready for analytics (04-08) if that plan depends on template data

## Self-Check: PASSED

All 5 created files and 3 modified files verified present. Both commit hashes verified in git log.

---
*Phase: 04-web-companion-sharing*
*Completed: 2026-04-16*
