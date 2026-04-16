---
phase: 04-web-companion-sharing
plan: 06
subsystem: workspace
tags: [workspace, rbac, invite, resend, email, role-management, team-collaboration]

# Dependency graph
requires:
  - phase: 04-01
    provides: "Prisma schema with Workspace, WorkspaceMember, WorkspaceInvite models, Role enum"
  - phase: 04-02
    provides: "NextAuth v5 auth, protectedProcedure, tRPC init"
  - phase: 04-05
    provides: "Video router with list/getById procedures, viewer pages"
provides:
  - Workspace tRPC router with full CRUD (create, list, getById, update, delete)
  - 3-tier RBAC middleware (workspaceMemberProcedure, workspaceEditorProcedure, workspaceOwnerProcedure)
  - Invite flow with CUID token, 7-day expiry, single-use consumption
  - Resend email integration for invite notifications (graceful degradation)
  - Workspace UI pages (home, settings, members)
  - Workspace switcher dropdown with inline create
  - Invite acceptance page with auth-gated flow
  - Member list with role management (owner only)
affects: [04-08-analytics, 04-07-templates]

# Tech tracking
tech-stack:
  added: []
  patterns: [3-tier RBAC middleware chain extending protectedProcedure, Resend email with graceful degradation, workspace-scoped data access pattern]

key-files:
  created:
    - apps/web/src/trpc/routers/workspace.ts
    - apps/web/src/lib/email.ts
    - apps/web/src/components/workspace-switcher.tsx
    - apps/web/src/components/invite-form.tsx
    - apps/web/src/components/member-list.tsx
    - apps/web/src/app/(dashboard)/workspace/[workspaceId]/page.tsx
    - apps/web/src/app/(dashboard)/workspace/[workspaceId]/settings/page.tsx
    - apps/web/src/app/(dashboard)/workspace/[workspaceId]/members/page.tsx
    - apps/web/src/app/invite/[token]/page.tsx
  modified:
    - apps/web/src/trpc/routers/_app.ts
    - apps/web/src/app/(dashboard)/page.tsx

key-decisions:
  - "RBAC middleware uses tRPC middleware chaining: member -> editor -> owner, each extending the prior"
  - "Invite email uses dynamic import to avoid bundling Resend on client; gracefully returns {sent: false} when RESEND_API_KEY missing"
  - "Workspace pages use mixed rendering: home is Server Component (Prisma), settings/members are Client Components (mutations)"
  - "Invite acceptance page is a standalone client page outside dashboard layout for unauthenticated access"

patterns-established:
  - "3-tier RBAC middleware: workspaceMemberProcedure > workspaceEditorProcedure > workspaceOwnerProcedure"
  - "Graceful email degradation: try Resend, fall back to invite link copy"
  - "Workspace-scoped queries via membership verification in middleware"

requirements-completed: [WEB-05]

# Metrics
duration: 6min
completed: 2026-04-16
---

# Phase 4 Plan 06: Workspaces + 3-role RBAC + Invite Flow Summary

**Team workspaces with 3-tier RBAC middleware (owner/editor/viewer), email invitations via Resend with graceful degradation, workspace CRUD, member management UI, and workspace switcher**

## Performance

- **Duration:** 6 min
- **Started:** 2026-04-16T07:06:28Z
- **Completed:** 2026-04-16T07:12:00Z
- **Tasks:** 2
- **Files created:** 9
- **Files modified:** 2

## Accomplishments

- 3-tier RBAC middleware chain (member/editor/owner) enforcing D-04 role hierarchy on every workspace procedure (T-04-21)
- Complete workspace CRUD: create with auto-slug, list with role/counts, update name/slug (owner), delete with personal workspace protection
- Invite flow: CUID token with 7-day expiry, single-use consumption in transaction, editor cannot assign owner role (T-04-22)
- Resend email integration with graceful degradation when API key not configured
- Workspace UI: home page with video grid, settings with name/slug editor + danger zone delete, members page with invite form + role management
- Workspace switcher dropdown with inline workspace creation
- Invite acceptance page with auth-gated flow (sign-in redirect for unauthenticated users)
- Dashboard page updated with workspace card links

## Task Commits

1. **Task 1: Workspace tRPC router with RBAC middleware** - `b909a0f` (feat)
2. **Task 2: Workspace UI pages + invite acceptance + switcher** - `ec5ce96` (feat)

## Files Created/Modified

- `apps/web/src/trpc/routers/workspace.ts` - Workspace CRUD + RBAC middleware + invite/accept/leave/removeMember/updateMemberRole procedures
- `apps/web/src/lib/email.ts` - Resend email utility with sendInviteEmail and graceful degradation
- `apps/web/src/components/workspace-switcher.tsx` - Dropdown with workspace list, role badges, inline create form
- `apps/web/src/components/invite-form.tsx` - Email + role selector + copy invite link
- `apps/web/src/components/member-list.tsx` - Member cards with avatar, role badges, edit/remove actions (owner only)
- `apps/web/src/app/(dashboard)/workspace/[workspaceId]/page.tsx` - Workspace home with video grid and quick links
- `apps/web/src/app/(dashboard)/workspace/[workspaceId]/settings/page.tsx` - Name/slug editor + delete (owner only)
- `apps/web/src/app/(dashboard)/workspace/[workspaceId]/members/page.tsx` - Members page with invite form and member list
- `apps/web/src/app/invite/[token]/page.tsx` - Invite acceptance with auth gate and error handling
- `apps/web/src/trpc/routers/_app.ts` - Added workspaceRouter to app router
- `apps/web/src/app/(dashboard)/page.tsx` - Updated workspace cards to be navigable links

## Decisions Made

- RBAC middleware uses tRPC middleware chaining pattern: each tier extends the prior, adding stricter checks
- Invite email uses dynamic import to avoid bundling Resend on client side; returns `{sent: false}` when RESEND_API_KEY is missing
- Workspace home page is a Server Component (direct Prisma) while settings/members are Client Components (need mutations)
- Invite acceptance page sits outside the dashboard layout group so unauthenticated users can view it

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Created lib/email.ts in Task 1 instead of Task 2**
- **Found during:** Task 1 (workspace router)
- **Issue:** Workspace router imports `@/lib/email` which doesn't exist yet; tsc fails
- **Fix:** Created `lib/email.ts` alongside the router to unblock compilation
- **Files modified:** apps/web/src/lib/email.ts
- **Committed in:** b909a0f (Task 1 commit)

**2. [Rule 1 - Bug] Fixed SVG title attribute TypeScript error**
- **Found during:** Task 2 (workspace page)
- **Issue:** `title` prop on `<svg>` element not in React SVGProps type definition
- **Fix:** Changed to `aria-label` for accessibility-correct alternative
- **Files modified:** apps/web/src/app/(dashboard)/workspace/[workspaceId]/page.tsx
- **Committed in:** ec5ce96 (Task 2 commit)

---

**Total deviations:** 2 auto-fixed (1 blocking, 1 bug)
**Impact on plan:** Both fixes necessary for compilation. No scope creep.

## Threat Surface Scan

All mitigations from the plan's threat model implemented:
- T-04-21 (Elevation / RBAC bypass): 3-tier middleware checked on every procedure; editor cannot assign owner role
- T-04-22 (Spoofing / invite token): Random CUID token, 7-day expiry, consumed on use in transaction
- T-04-23 (DoS / invite spam): Accepted per plan — link-based invites with low abuse vector

No new threat surface beyond what is documented in the plan's threat model.

## Self-Check: PASSED

All 9 created files and 2 modified files verified present. Both commit hashes verified in git log.

---
*Phase: 04-web-companion-sharing*
*Completed: 2026-04-16*
