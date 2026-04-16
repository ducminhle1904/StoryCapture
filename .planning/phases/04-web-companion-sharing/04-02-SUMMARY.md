---
phase: 04-web-companion-sharing
plan: 02
subsystem: auth
tags: [next-auth, oauth, github, google, prisma-adapter, jwt, jose, trpc, protected-procedure]

# Dependency graph
requires:
  - phase: 04-01
    provides: "Next.js 15 scaffold, Prisma schema (User/Account/Session/Workspace models), tRPC 11 with placeholder protectedProcedure"
provides:
  - NextAuth v5 config with GitHub + Google OAuth and Prisma adapter
  - Database sessions (revocable) with user.id exposed on session object
  - Personal workspace auto-creation on first sign-in
  - Desktop token exchange endpoint (session -> 30-day JWT)
  - Short-lived JWT minting/verification (15 min) for SSE auth
  - Auth-gated dashboard layout with session redirect
  - protectedProcedure with real session check
  - user.me and user.workspaces tRPC queries
  - Sign-in page with GitHub and Google OAuth buttons
affects: [04-03-upload, 04-04-viewer, 04-05-workspaces, 04-07-analytics, 04-08-sync]

# Tech tracking
tech-stack:
  added: []
  patterns: [NextAuth v5 database sessions with Prisma adapter, server action OAuth sign-in, auth-gated route group layout, desktop token exchange via session validation, jose JWT with HS256 for desktop/SSE tokens]

key-files:
  created:
    - apps/web/src/lib/auth.ts
    - apps/web/src/lib/jwt.ts
    - apps/web/src/app/api/auth/[...nextauth]/route.ts
    - apps/web/src/app/api/auth/desktop-token/route.ts
    - apps/web/src/trpc/routers/user.ts
    - apps/web/src/app/(auth)/sign-in/page.tsx
    - apps/web/src/app/(dashboard)/layout.tsx
    - apps/web/src/app/(dashboard)/page.tsx
  modified:
    - apps/web/src/trpc/init.ts
    - apps/web/src/trpc/routers/_app.ts
    - apps/web/src/trpc/server.tsx

key-decisions:
  - "Used database session strategy (not JWT sessions) for revocable sessions per D-07 and RESEARCH.md"
  - "PrismaAdapter cast to ReturnType<typeof PrismaAdapter> for generated client compatibility"
  - "Dashboard page uses direct Prisma queries (RSC) instead of tRPC for initial load simplicity"
  - "Sign-in uses server actions (not client-side signIn) for progressive enhancement"

patterns-established:
  - "Auth-gated route groups: (dashboard) layout checks auth() and redirects to /sign-in"
  - "protectedProcedure middleware: checks ctx.session.user, narrows context type for downstream"
  - "Desktop auth flow: OAuth -> session token -> POST /api/auth/desktop-token -> long-lived JWT"
  - "JWT token types: 'desktop' (30d) for API auth, 'sse' (15m) for subscription auth"

requirements-completed: [WEB-02]

# Metrics
duration: 3min
completed: 2026-04-16
---

# Phase 4 Plan 02: NextAuth v5 Authentication Summary

**NextAuth v5 with GitHub + Google OAuth, Prisma adapter database sessions, desktop token exchange (30-day JWT), SSE JWT (15 min), and auth-gated dashboard layout**

## Performance

- **Duration:** 3 min
- **Started:** 2026-04-16T06:42:50Z
- **Completed:** 2026-04-16T06:45:57Z
- **Tasks:** 2
- **Files modified:** 11

## Accomplishments
- Full OAuth sign-in flow with GitHub and Google via NextAuth v5, with personal workspace auto-created on first login
- Desktop token exchange endpoint validates database session and issues 30-day JWT for persistent desktop auth
- Auth-gated dashboard layout with sidebar, user avatar, sign-out, and workspace card grid
- protectedProcedure wired with real session check replacing the placeholder from Plan 04-01

## Task Commits

Each task was committed atomically:

1. **Task 1: NextAuth v5 config + JWT utilities + desktop token exchange** - `045dac3` (feat)
2. **Task 2: Auth-gated dashboard + protectedProcedure + user router + sign-in page** - `e98201f` (feat)

## Files Created/Modified
- `apps/web/src/lib/auth.ts` - NextAuth v5 config with GitHub + Google providers, Prisma adapter, personal workspace auto-creation
- `apps/web/src/lib/jwt.ts` - JWT utilities using jose: mintDesktopToken, verifyDesktopToken, mintJwt, verifyJwt
- `apps/web/src/app/api/auth/[...nextauth]/route.ts` - NextAuth route handler (GET + POST)
- `apps/web/src/app/api/auth/desktop-token/route.ts` - Desktop token exchange endpoint (session -> JWT)
- `apps/web/src/trpc/init.ts` - Updated: auth() session in context, protectedProcedure with real session check
- `apps/web/src/trpc/routers/user.ts` - New: user.me and user.workspaces queries
- `apps/web/src/trpc/routers/_app.ts` - Updated: merged userRouter
- `apps/web/src/trpc/server.tsx` - Updated: uses full auth context instead of null placeholders
- `apps/web/src/app/(auth)/sign-in/page.tsx` - Sign-in page with GitHub + Google buttons (server actions)
- `apps/web/src/app/(dashboard)/layout.tsx` - Auth-gated layout with sidebar, user section, sign-out
- `apps/web/src/app/(dashboard)/page.tsx` - Dashboard home with welcome message and workspace cards

## Decisions Made
- Used database session strategy (not JWT sessions) for revocable sessions per D-07 and RESEARCH.md
- PrismaAdapter cast to ReturnType<typeof PrismaAdapter> for generated client compatibility (Prisma generates to `src/generated/prisma`)
- Dashboard page uses direct Prisma queries in RSC instead of tRPC for straightforward initial data loading
- Sign-in uses Next.js server actions for progressive enhancement (no client-side JS required for OAuth redirect)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed server.tsx caller using hardcoded null context**
- **Found during:** Task 2 (updating trpc/init.ts)
- **Issue:** server.tsx manually constructed context with `session: null, user: null` instead of using createTRPCContext which now includes auth
- **Fix:** Changed caller factory to use `createTRPCContext()` directly, which calls `auth()` internally
- **Files modified:** apps/web/src/trpc/server.tsx
- **Verification:** TypeScript compiles, context types match
- **Committed in:** e98201f (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (1 bug)
**Impact on plan:** Necessary fix to ensure server-side tRPC calls have auth context. No scope creep.

## Issues Encountered
None.

## Threat Surface Scan
No new threat surface beyond what is documented in the plan's threat model. All mitigations implemented:
- T-04-04 (Spoofing): NextAuth handles PKCE + CSRF automatically
- T-04-05 (Elevation): protectedProcedure checks session, throws UNAUTHORIZED
- T-04-06 (Info Disclosure): Desktop tokens intended for OS keychain storage
- T-04-07 (Tampering): JWTs signed with HS256 + JWT_SECRET, short expiry for SSE
- T-04-08 (Repudiation): Desktop token endpoint validates session exists in DB before issuing

## User Setup Required
OAuth providers require configuration before sign-in will work:
- Set `AUTH_SECRET` (generate with `openssl rand -base64 32`)
- Set `AUTH_GITHUB_ID` and `AUTH_GITHUB_SECRET` from GitHub OAuth App settings
- Set `AUTH_GOOGLE_ID` and `AUTH_GOOGLE_SECRET` from Google Cloud Console
- Set `JWT_SECRET` for desktop/SSE token signing
- Set `DATABASE_URL` for Prisma (Neon PostgreSQL)
- Run `pnpm db:migrate` to apply schema

## Next Phase Readiness
- Auth foundation complete: all protected routes and tRPC procedures can use `protectedProcedure`
- Desktop token exchange ready for Plan 04-08 (sync) to use
- Workspace model populated on first sign-in, ready for Plan 04-05 (workspaces)
- User session available in all server components and tRPC context

---
*Phase: 04-web-companion-sharing*
*Completed: 2026-04-16*
