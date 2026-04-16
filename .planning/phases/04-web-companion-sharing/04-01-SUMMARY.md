---
phase: 04-web-companion-sharing
plan: 01
subsystem: api
tags: [next.js, trpc, prisma, tailwind-v4, postgresql, superjson, react-19]

# Dependency graph
requires: []
provides:
  - Next.js 15 App Router scaffold with standalone output
  - Prisma 6 schema with 12 models (User, Account, Session, VerificationToken, Workspace, WorkspaceMember, WorkspaceInvite, Video, ViewEvent, DailyVideoStats, Template, SyncedProject)
  - tRPC 11 with fetch adapter, superjson transformer, health endpoint
  - TRPCReactProvider with splitLink (httpBatchLink + httpSubscriptionLink for SSE)
  - Server-side tRPC caller via createTRPCOptionsProxy for RSC
  - Prisma singleton with server-only guard
  - Tailwind v4 with shared design tokens from @storycapture/ui
affects: [04-02-auth, 04-03-upload, 04-04-viewer, 04-05-workspaces, 04-06-templates, 04-07-analytics, 04-08-sync]

# Tech tracking
tech-stack:
  added: [next@15.5.15, "@trpc/server@11.16.0", "@trpc/client@11.16.0", "@trpc/tanstack-react-query@11.16.0", "@prisma/client@6.19.3", "prisma@6.19.3", "next-auth@5.0.0-beta.31", superjson, jose, "@aws-sdk/client-s3", "@aws-sdk/s3-request-presigner", "@maxmind/geoip2-node", pino, resend, "tailwindcss@4.x", "@tailwindcss/postcss@4.x"]
  patterns: [tRPC fetch adapter for App Router, Prisma global singleton with server-only, splitLink for SSE subscriptions, superjson transformer for Date/BigInt, createTRPCOptionsProxy for RSC]

key-files:
  created:
    - apps/web/package.json
    - apps/web/tsconfig.json
    - apps/web/next.config.ts
    - apps/web/postcss.config.mjs
    - apps/web/prisma/schema.prisma
    - apps/web/src/lib/prisma.ts
    - apps/web/src/trpc/init.ts
    - apps/web/src/trpc/client.tsx
    - apps/web/src/trpc/query-client.ts
    - apps/web/src/trpc/server.tsx
    - apps/web/src/trpc/routers/_app.ts
    - apps/web/src/trpc/routers/health.ts
    - apps/web/src/app/api/trpc/[trpc]/route.ts
    - apps/web/src/app/layout.tsx
    - apps/web/src/app/page.tsx
    - apps/web/src/styles/globals.css
    - apps/web/.env.example
    - apps/web/.gitignore
  modified: []

key-decisions:
  - "Pinned Prisma to ^6.0.0 (resolved 6.19.3) per CLAUDE.md committed stack, not 7.x latest"
  - "Pinned Next.js to ^15.3.0 (resolved 15.5.15) per CLAUDE.md committed stack, not 16.x latest"
  - "Pinned next-auth to exact 5.0.0-beta.31 per Pitfall 1"
  - "Used zod 3.x for tRPC 11 compatibility (not zod 4.x which may have breaking changes)"
  - "Used @tailwindcss/postcss instead of @tailwindcss/vite since Next.js uses PostCSS pipeline"
  - "Used createTRPCClient from @trpc/client (not TRPCProvider.createClient) per tRPC 11 API"

patterns-established:
  - "tRPC fetch adapter: fetchRequestHandler in app/api/trpc/[trpc]/route.ts with GET+POST exports"
  - "Prisma singleton: global cache pattern with import 'server-only' guard"
  - "tRPC client: splitLink with httpBatchLink (queries/mutations) + httpSubscriptionLink (SSE subscriptions)"
  - "tRPC server: createTRPCOptionsProxy + createCallerFactory for RSC direct calls"
  - "QueryClient factory: superjson serialize/deserialize in dehydrate/hydrate, 30s staleTime"

requirements-completed: [WEB-01]

# Metrics
duration: 6min
completed: 2026-04-16
---

# Phase 4 Plan 01: Next.js 15 Scaffold Summary

**Next.js 15 App Router with tRPC 11 (health endpoint verified), Prisma 6 schema (12 models, 3 enums), and Tailwind v4 using shared design tokens**

## Performance

- **Duration:** 6 min
- **Started:** 2026-04-16T06:23:10Z
- **Completed:** 2026-04-16T06:29:01Z
- **Tasks:** 3
- **Files modified:** 19

## Accomplishments
- Full Next.js 15 App Router scaffold with all Phase 4 dependencies (tRPC 11, Prisma 6, NextAuth v5, AWS SDK, MaxMind, Resend, etc.)
- Complete Prisma 6 schema covering auth (4 models), workspaces/RBAC (3 models), video/upload (1 model), analytics (2 models), templates (1 model), and desktop sync (1 model) with 3 enums
- Working tRPC 11 endpoint verified via curl: GET /api/trpc/health.ping returns {ok: true, timestamp}
- Tailwind v4 styling with shared @storycapture/ui design tokens imported via PostCSS

## Task Commits

Each task was committed atomically:

1. **Task 1a: Install dependencies + Next.js App Router scaffold** - `4eec98d` (feat)
2. **Task 1b: Prisma 6 schema (12 models) + prisma.ts singleton** - `1154f41` (feat)
3. **Task 2: tRPC 11 App Router setup with health endpoint** - `580aa94` (feat)

## Files Created/Modified
- `apps/web/package.json` - Full Phase 4 dependency manifest with scripts
- `apps/web/tsconfig.json` - TypeScript config extending monorepo base with @/* paths
- `apps/web/next.config.ts` - Standalone output, transpilePackages, serverExternalPackages
- `apps/web/postcss.config.mjs` - Tailwind v4 PostCSS plugin config
- `apps/web/prisma/schema.prisma` - 12 models, 3 enums, full database schema for Phase 4
- `apps/web/src/lib/prisma.ts` - PrismaClient singleton with server-only guard
- `apps/web/src/trpc/init.ts` - tRPC context, superjson transformer, public/protected procedures
- `apps/web/src/trpc/client.tsx` - TRPCReactProvider with splitLink (batch + SSE)
- `apps/web/src/trpc/query-client.ts` - QueryClient factory with superjson dehydration
- `apps/web/src/trpc/server.tsx` - RSC server-side caller via createTRPCOptionsProxy
- `apps/web/src/trpc/routers/_app.ts` - Root router merging health router
- `apps/web/src/trpc/routers/health.ts` - Health ping query
- `apps/web/src/app/api/trpc/[trpc]/route.ts` - tRPC HTTP handler (GET + POST)
- `apps/web/src/app/layout.tsx` - Root layout with TRPCReactProvider wrapper
- `apps/web/src/app/page.tsx` - Landing page placeholder
- `apps/web/src/styles/globals.css` - Tailwind v4 with shared design tokens
- `apps/web/.env.example` - All required env vars documented
- `apps/web/.gitignore` - .next, generated, env files excluded

## Decisions Made
- Pinned Prisma to ^6.0.0 (not 7.x) and Next.js to ^15.3.0 (not 16.x) per CLAUDE.md committed stack
- Used @tailwindcss/postcss instead of @tailwindcss/vite since Next.js uses PostCSS pipeline (not Vite)
- Used createTRPCClient from @trpc/client to create the client instance (tRPC 11 API)
- protectedProcedure is a placeholder that throws UNAUTHORIZED -- wired in Plan 04-02

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Used @tailwindcss/postcss instead of @tailwindcss/vite**
- **Found during:** Task 1a (dependency installation)
- **Issue:** Plan specified @tailwindcss/vite but Next.js uses PostCSS, not Vite, for CSS processing
- **Fix:** Used @tailwindcss/postcss with postcss.config.mjs instead
- **Files modified:** apps/web/package.json, apps/web/postcss.config.mjs
- **Verification:** Tailwind v4 classes compile correctly, dev server boots
- **Committed in:** 4eec98d (Task 1a commit)

**2. [Rule 1 - Bug] Fixed tRPC client creation API for v11**
- **Found during:** Task 2 (tRPC client setup)
- **Issue:** Initial code used TRPCProvider.createClient() which doesn't exist in tRPC 11; the provider expects a trpcClient prop created via createTRPCClient()
- **Fix:** Used createTRPCClient<AppRouter>() from @trpc/client and passed as trpcClient prop
- **Files modified:** apps/web/src/trpc/client.tsx
- **Verification:** TypeScript compiles, health endpoint responds correctly
- **Committed in:** 580aa94 (Task 2 commit)

---

**Total deviations:** 2 auto-fixed (1 blocking, 1 bug)
**Impact on plan:** Both fixes necessary for correct functionality. No scope creep.

## Issues Encountered
None beyond the auto-fixed deviations above.

## Threat Surface Scan
No new threat surface beyond what is documented in the plan's threat model. The .env.example contains no real values, prisma.ts has server-only guard, and tRPC inputs will use zod validation as procedures are added.

## User Setup Required
None - no external service configuration required for this scaffold plan. Database connection and OAuth credentials are needed for Plan 04-02 (auth).

## Next Phase Readiness
- tRPC router ready for additional routers (video, workspace, template, analytics, sync)
- Prisma schema ready for migrations once DATABASE_URL is configured
- Auth wiring (Plan 04-02) is the next dependency -- protectedProcedure placeholder is in place
- TRPCReactProvider wraps the app, ready for client-side queries

## Self-Check: PASSED

- All 19 key files exist on disk
- All 3 task commits verified (4eec98d, 1154f41, 580aa94)

---
*Phase: 04-web-companion-sharing*
*Completed: 2026-04-16*
