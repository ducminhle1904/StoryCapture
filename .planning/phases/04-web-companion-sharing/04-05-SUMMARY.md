---
phase: 04-web-companion-sharing
plan: 05
subsystem: viewer
tags: [viewer, oembed, embed, privacy, slug, chapters, iframe]

# Dependency graph
requires:
  - phase: 04-01
    provides: "Prisma schema with Video model, VideoStatus enum, Workspace/WorkspaceMember models"
  - phase: 04-02
    provides: "NextAuth v5 auth, protectedProcedure, publicProcedure"
  - phase: 04-04
    provides: "Video tRPC router with getBySlug, R2 presigned URL helpers"
provides:
  - /watch/<slug> public viewer page with chapter navigation from DSL scene boundaries
  - /embed/<id> minimal chrome-less player for iframe embedding (D-03)
  - /api/oembed endpoint returning rich type JSON for Notion/Slack/Discord unfurl (D-03)
  - Privacy toggle switching between private (noindex) and public (indexed) (D-02)
  - Vanity slug editor with format validation and uniqueness check (D-02)
  - Embed code component with size presets and copy-to-clipboard (D-03)
  - Video detail/management page with preview, privacy, slug, embed code, delete
  - 4 new tRPC procedures: updatePrivacy, updateSlug, getById, deleteVideo
affects: [04-08-analytics]

# Tech tracking
tech-stack:
  added: []
  patterns: [Server Component Prisma fetch for public pages, Client wrapper for interactive video playback, oEmbed rich type response, accessible role=switch toggle]

key-files:
  created:
    - apps/web/src/app/watch/[slug]/page.tsx
    - apps/web/src/app/embed/[id]/page.tsx
    - apps/web/src/app/api/oembed/route.ts
    - apps/web/src/app/(dashboard)/videos/[videoId]/page.tsx
    - apps/web/src/components/video-player.tsx
    - apps/web/src/components/chapter-nav.tsx
    - apps/web/src/components/watch-viewer.tsx
    - apps/web/src/components/embed-player.tsx
    - apps/web/src/components/embed-code.tsx
    - apps/web/src/components/privacy-toggle.tsx
  modified:
    - apps/web/src/trpc/routers/video.ts

key-decisions:
  - "Watch page uses Server Component with direct Prisma query (no tRPC for public pages) for faster SSR"
  - "Embed page fetches by video ID (not slug) for stable embed URLs that survive slug changes"
  - "oEmbed only serves public videos (T-04-20) to prevent information disclosure"
  - "WatchViewer is a separate client wrapper to combine VideoPlayer + ChapterNav with shared playback state"

patterns-established:
  - "Server Component page + client viewer wrapper pattern for interactive server-fetched content"
  - "oEmbed rich type with iframe embed URL"
  - "Workspace role checks (EDITOR/OWNER required) on all mutation procedures"

requirements-completed: [WEB-04]

# Metrics
duration: 4min
completed: 2026-04-16
---

# Phase 4 Plan 05: Viewer Page + Embed + oEmbed + Privacy Controls Summary

**Public viewer page with chapter navigation from DSL scenes, iframe embed endpoint, oEmbed auto-unfurl for Notion/Slack/Discord, privacy toggle (private-by-default per D-02), vanity slug editor, and video management dashboard page**

## Performance

- **Duration:** 4 min
- **Started:** 2026-04-16T06:59:48Z
- **Completed:** 2026-04-16T07:03:59Z
- **Tasks:** 2
- **Files created:** 10
- **Files modified:** 1

## Accomplishments

- /watch/<slug> server component page fetches video via Prisma, generates presigned URLs, renders client-side VideoPlayer with ChapterNav synced to playback position
- Private videos (D-02) get noindex/nofollow meta tag but remain accessible via direct link (unlisted)
- Public videos get full SEO + Open Graph meta tags with thumbnail
- /embed/<id> minimal chrome-less player for iframe embedding, no X-Frame-Options restriction
- /api/oembed returns oEmbed 1.0 rich type response with iframe HTML, 16:9 aspect ratio, thumbnail; only for public+ready videos (T-04-20)
- Privacy toggle with accessible switch component, explanation text, workspace role check
- Slug editor with format validation (lowercase alphanum + hyphens, 3-60 chars), uniqueness check, URL preview
- Video detail page combines all management controls: preview, privacy, slug, embed code, delete with confirmation
- 4 new tRPC procedures added to video router: updatePrivacy, updateSlug, getById, deleteVideo

## Task Commits

1. **Task 1: Viewer page + embed page + video player with chapters** - `bd5bd3c` (feat)
2. **Task 2: oEmbed endpoint + privacy toggle + slug editor + embed code + video detail page** - `8b2cddf` (feat)

## Files Created/Modified

- `apps/web/src/components/video-player.tsx` - HTML5 video with poster, analytics callbacks, time tracking
- `apps/web/src/components/chapter-nav.tsx` - Horizontal pill navigation from DSL scene boundaries, active chapter highlighting
- `apps/web/src/components/watch-viewer.tsx` - Client wrapper combining player + chapters with shared playback state
- `apps/web/src/components/embed-player.tsx` - Minimal player for embed iframe
- `apps/web/src/app/watch/[slug]/page.tsx` - Server Component: Prisma fetch, metadata with noindex for private (D-02), presigned URLs
- `apps/web/src/app/embed/[id]/page.tsx` - Minimal embed page by video ID
- `apps/web/src/app/api/oembed/route.ts` - oEmbed 1.0 rich type endpoint, public videos only (T-04-20)
- `apps/web/src/components/embed-code.tsx` - Copyable iframe snippet with size presets (D-03)
- `apps/web/src/components/privacy-toggle.tsx` - Accessible switch toggle with labels (D-02)
- `apps/web/src/app/(dashboard)/videos/[videoId]/page.tsx` - Video management page with all controls
- `apps/web/src/trpc/routers/video.ts` - Added updatePrivacy, updateSlug, getById, deleteVideo procedures

## Decisions Made

- Watch page uses Server Component with direct Prisma query for public SSR (no tRPC overhead for unauthenticated pages)
- Embed page uses video ID (not slug) for stable embed URLs that survive slug renames
- oEmbed endpoint only returns data for public videos to prevent information disclosure about private content
- WatchViewer is a separate client wrapper because VideoPlayer + ChapterNav need shared mutable playback state

## Deviations from Plan

None - plan executed exactly as written.

## Threat Surface Scan

All mitigations from the plan's threat model implemented:
- T-04-17 (Info Disclosure / unlisted): Accepted per D-02 design; unlisted videos accessible via direct link
- T-04-18 (Tampering / slug squatting): Slug format validated + DB unique constraint + uniqueness check before update
- T-04-19 (Elevation / video management): updatePrivacy, updateSlug, deleteVideo all check workspace membership + EDITOR/OWNER role
- T-04-20 (Info Disclosure / oEmbed for private): oEmbed endpoint returns 404 for non-public videos

No new threat surface beyond what is documented in the plan's threat model.

## Self-Check: PASSED

All 10 created files verified present. Both commit hashes verified in git log.

---
*Phase: 04-web-companion-sharing*
*Completed: 2026-04-16*
