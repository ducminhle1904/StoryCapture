---
phase: 04-web-companion-sharing
plan: 08
subsystem: analytics
tags: [analytics, maxmind, geoip, session-tracking, heatmap, cron, vercel, gdpr]

# Dependency graph
requires:
  - phase: 04-01
    provides: "Prisma schema with ViewEvent, DailyVideoStats models"
  - phase: 04-05
    provides: "VideoPlayer with onAnalyticsEvent callback, WatchViewer component, watch page"
  - phase: 04-06
    provides: "Workspace RBAC, protectedProcedure"
  - phase: 04-07
    provides: "Template router pattern, _app.ts router registration"
provides:
  - POST /api/analytics/ingest endpoint with rate limiting and GeoIP lookup
  - GET /api/analytics/session for GDPR-safe session cookie
  - MaxMind GeoLite2 singleton reader (lib/geo.ts)
  - Analytics tRPC router with dashboard, dailyStats, aggregateDaily procedures
  - Vercel cron for daily aggregation + 90-day retention cleanup
  - Analytics dashboard page with 4 metric cards, drop-off heatmap, geo breakdown
  - Viewer page event wiring (play/pause/seek/scene_enter/ended)
affects: []

# Tech tracking
tech-stack:
  added: []
  patterns: [MaxMind GeoLite2 singleton reader with graceful fallback, in-memory rate limiting per IP, sendBeacon for page-unload analytics, scene boundary crossing detection from chapter timestamps]

key-files:
  created:
    - apps/web/src/app/api/analytics/ingest/route.ts
    - apps/web/src/app/api/analytics/session/route.ts
    - apps/web/src/app/api/cron/aggregate-analytics/route.ts
    - apps/web/src/lib/geo.ts
    - apps/web/src/lib/constants.ts
    - apps/web/src/trpc/routers/analytics.ts
    - apps/web/src/components/analytics-dashboard.tsx
    - apps/web/src/components/dropoff-heatmap.tsx
    - apps/web/src/components/geo-breakdown.tsx
    - apps/web/src/app/(dashboard)/analytics/[videoId]/page.tsx
    - apps/web/vercel.json
    - apps/web/scripts/download-geolite2.sh
  modified:
    - apps/web/src/trpc/routers/_app.ts
    - apps/web/src/components/watch-viewer.tsx
    - apps/web/src/app/watch/[slug]/page.tsx

key-decisions:
  - "Used direct fetch to tRPC endpoint in analytics-dashboard.tsx instead of tRPC hooks to avoid provider dependency at component level"
  - "sendBeacon used for ended event to ensure delivery on page unload (T-04-28 best-effort)"
  - "Scene boundary detection via chapter timestamp comparison on timeUpdate events"
  - "GeoLite2 reader uses graceful fallback returning XX when database file is missing"

patterns-established:
  - "GeoIP singleton: lazy-load Reader.open() with readerFailed flag to avoid repeated fs checks"
  - "In-memory rate limiting: Map-based per-IP throttle with periodic cleanup interval"
  - "Analytics constants centralized in lib/constants.ts"

requirements-completed: [WEB-07]

# Metrics
duration: 6min
completed: 2026-04-16
---

# Phase 4 Plan 08: Analytics Pipeline Summary

**Event ingestion with GeoIP country lookup, GDPR-safe session tracking, 4-metric dashboard (play count, duration, drop-off heatmap, geo breakdown), and Vercel cron aggregation**

## Performance

- **Duration:** 6 min
- **Started:** 2026-04-16T07:20:55Z
- **Completed:** 2026-04-16T07:27:20Z
- **Tasks:** 2
- **Files created:** 12
- **Files modified:** 3

## Accomplishments

- Complete analytics pipeline from viewer event capture through dashboard visualization
- GDPR-safe session tracking via httpOnly/secure/SameSite=Lax cookie with random UUID (D-06)
- MaxMind GeoLite2 country-level IP lookup with graceful degradation when database unavailable
- Analytics dashboard with 4 stat cards, per-scene drop-off heatmap, and country breakdown table
- Vercel cron job for daily aggregation with 90-day raw event retention cleanup (D-06)
- Rate-limited public ingest endpoint (10 events/sec per IP) with event type validation (T-04-26)

## Task Commits

1. **Task 1: Event ingestion + session cookie + GeoIP + analytics tRPC router** - `9ba90f4` (feat)
2. **Task 2: Analytics dashboard UI + viewer page event wiring** - `78188d3` (feat)

## Files Created/Modified

- `apps/web/src/app/api/analytics/ingest/route.ts` - POST endpoint for view event ingestion with rate limiting and GeoIP
- `apps/web/src/app/api/analytics/session/route.ts` - GET endpoint for GDPR-safe session cookie
- `apps/web/src/app/api/cron/aggregate-analytics/route.ts` - Vercel cron for daily rollup + retention cleanup
- `apps/web/src/lib/geo.ts` - MaxMind GeoLite2 singleton reader with graceful fallback
- `apps/web/src/lib/constants.ts` - Analytics constants (events, retention days, cookie config)
- `apps/web/src/trpc/routers/analytics.ts` - Dashboard, dailyStats, aggregateDaily tRPC procedures
- `apps/web/src/trpc/routers/_app.ts` - Added analyticsRouter
- `apps/web/src/components/analytics-dashboard.tsx` - 4 stat cards + time range selector + heatmap/geo sections
- `apps/web/src/components/dropoff-heatmap.tsx` - Per-scene horizontal bar chart with retention color gradient
- `apps/web/src/components/geo-breakdown.tsx` - Country flag + name table with top 10 + Other grouping
- `apps/web/src/app/(dashboard)/analytics/[videoId]/page.tsx` - Auth-gated analytics page with workspace membership check
- `apps/web/src/components/watch-viewer.tsx` - Wired analytics event sending to ingest endpoint
- `apps/web/src/app/watch/[slug]/page.tsx` - Pass videoId to WatchViewer for analytics
- `apps/web/vercel.json` - Cron declaration for aggregate-analytics (every minute)
- `apps/web/scripts/download-geolite2.sh` - GeoLite2 database download script for CI/deploy

## Decisions Made

- Used direct fetch to tRPC batch endpoint in analytics-dashboard instead of tRPC React hooks to avoid requiring TRPCProvider at the component level
- sendBeacon for the 'ended' event ensures delivery even during page unload (analytics are best-effort per T-04-28)
- Scene boundary crossing detection uses chapter timestamps compared against video currentTime on timeUpdate
- GeoLite2 reader uses a `readerFailed` flag to avoid repeated filesystem checks after first failure

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed MaxMind GeoIP2 import types**
- **Found during:** Task 1 (GeoIP integration)
- **Issue:** `CountryResponse` is not a direct export from `@maxmind/geoip2-node`; `Reader.open()` returns `ReaderModel` not `Reader`
- **Fix:** Changed import to use `ReaderModel` type and removed `CountryResponse` type annotation
- **Files modified:** apps/web/src/lib/geo.ts
- **Committed in:** 9ba90f4 (Task 1 commit)

---

**Total deviations:** 1 auto-fixed (1 bug)
**Impact on plan:** Minor type correction for correct MaxMind API usage. No scope creep.

## Threat Surface Scan

All mitigations from the plan's threat model implemented:
- T-04-26 (Tampering / fake events): Rate limiting (10/sec per IP), videoId existence check, event type enum validation
- T-04-27 (Info Disclosure / viewer privacy): No PII stored, session cookie is random UUID, country-level only, no fingerprinting
- T-04-28 (Repudiation / analytics accuracy): Accepted -- client-side events are best-effort
- T-04-29 (Info Disclosure / analytics data): protectedProcedure + workspace membership check on all analytics queries

No new threat surface beyond what is documented in the plan's threat model.

## Issues Encountered

None

## User Setup Required

For GeoIP to work in production:
- Set `MAXMIND_LICENSE_KEY` environment variable in Vercel (free GeoLite2 account at maxmind.com)
- Run `scripts/download-geolite2.sh` during build or add to Vercel build command
- Set `CRON_SECRET` environment variable for Vercel cron authentication
- Without MaxMind key, country lookups gracefully degrade to 'XX' (Unknown)

## Next Phase Readiness

- Analytics pipeline complete from ingestion through dashboard visualization
- All D-06 requirements satisfied: GDPR-safe, country-level, 30-day dashboard, 90-day retention
- Ready for desktop-web sync (04-09) or any remaining phase 4 plans

## Self-Check: PASSED

All 12 created files and 3 modified files verified present. Both commit hashes (9ba90f4, 78188d3) verified in git log.

---
*Phase: 04-web-companion-sharing*
*Completed: 2026-04-16*
