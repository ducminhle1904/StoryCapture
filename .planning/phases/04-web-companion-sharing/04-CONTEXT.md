---
phase: 04-web-companion-sharing
type: context
created: 2026-04-16
decisions: 8
deferred: 3
---

# Phase 4 Context: Web Companion & Sharing

## Phase Goal

Users sign in to a Next.js companion, upload polished videos from desktop, share via embeddable viewer pages, collaborate in team workspaces, and view analytics — with live desktop↔web sync.

## Requirements

WEB-01, WEB-02, WEB-03, WEB-04, WEB-05, WEB-06, WEB-07, WEB-08, UI-06, DIST-06

## Locked Decisions

### D-01: Upload trigger & flow
- **Manual upload only** — "Upload to Web" button in export-complete toast + Settings → Accounts upload section
- No auto-upload (privacy-first per project constraints; no telemetry default)
- Resumable multipart via presigned Cloudflare R2 URLs (S3-compatible API)
- Desktop shows progress bar in status bar; chunks already uploaded are skipped on resume
- No auto-retry on disconnect — user re-triggers manually

### D-02: Viewer page privacy
- **Private-by-default** (unlisted link, `noindex` meta tag)
- Owner can toggle to "public" (SEO-indexed, discoverable)
- No password protection in v1
- No link expiry in v1
- Vanity slugs: `/watch/<slug>` — defaults to project name (slugified), owner can edit
- Slug uniqueness enforced at DB level

### D-03: Embed format
- **iframe snippet** — `<iframe src="storycapture.app/embed/<id>" width="..." height="..." allowfullscreen>`
- **oEmbed endpoint** at `/api/oembed?url=...` for auto-unfurl in Notion, Slack, Discord
- Thumbnail auto-generated from first frame of video (stored alongside the MP4 in R2)
- No standalone JS player widget in v1 (iframe covers 95% of embed needs)

### D-04: Workspace & roles model
- Free tier = 1 personal workspace, unlimited uploads, no storage cap in v1
- Team workspace = invite by email
- 3 roles: **owner** (full control + billing), **editor** (upload + edit + share), **viewer** (view only)
- "Asset library" = shared effect presets (`.scpreset`) + shared recordings within workspace
- No billing, seat limits, or paid tiers in v1 — monetization deferred to v2

### D-05: Template marketplace scope
- **Curated seed set only** in v1 — 10-15 templates across categories:
  - SaaS onboarding, e-commerce checkout, API walkthrough, mobile demo, CLI tool, landing page, feature announcement, bug reproduction, internal training
- Fork = **deep copy** into user's project folder (no upstream sync, no attribution required)
- Browse by category grid; no search in v1
- Community submissions deferred to v2

### D-06: Analytics depth
- **Near-real-time** — WebSocket pushes view events; server aggregates every 30s
- Metrics per video:
  - Play count (total + unique)
  - Watch duration (median, average)
  - Drop-off heatmap (bucketed per scene from DSL scene boundaries)
  - Geographic breakdown (IP → country via MaxMind GeoLite2, no city-level)
- **GDPR-safe**: unique viewers counted via session-ID cookie (no fingerprinting, no PII stored, no third-party trackers)
- Dashboard shows last 30 days; older data aggregated to daily summaries
- No per-viewer tracking, no retention beyond 90 days for raw events

### D-07: Desktop↔web sync boundary
- **Metadata-only sync** — project name, story source text (read-only on web), recording status, export list
- NOT full recordings or video files (those go through explicit D-01 upload flow)
- **Live recording status** pushed via WebSocket — connected dashboard shows "Recording in progress… step N/M"
- Story source text is **read-only on web** (desktop is source of truth; no bidirectional text editing)
- Conflict resolution: **last-write-wins** on metadata fields (desktop always wins on story content)
- Offline queue: desktop queues metadata updates in local SQLite, flushes on reconnect
- Auth: short-lived JWT (15 min) + refresh token; WebSocket reconnects with fresh JWT on expiry

### D-08: Hosting & infrastructure
- **Vercel** for Next.js (zero-config deployment, edge functions for oEmbed + analytics ingest)
- **Cloudflare R2** for video + thumbnail storage (S3-compatible, zero egress fees — critical for video hosting)
- **Neon** for PostgreSQL (serverless, Prisma-native, generous free tier)
- All three services have free tiers sufficient for launch
- Environment config via Vercel env vars; no `.env` files in repo

## Claude's Discretion

The following are implementation details where the researcher and planner should use best judgment:

- Database schema design (tables, indexes, relations) — follow Prisma 6 conventions
- tRPC router structure — follow patterns from the committed stack (CLAUDE.md)
- WebSocket server implementation — `ws` + tRPC adapter or standalone, whichever is simpler
- Video thumbnail generation — FFmpeg first-frame extract on upload, or client-side before upload
- oEmbed response format — follow the oEmbed spec, link or rich type
- GeoLite2 integration — download DB on deploy or use a hosted API (cost-optimize)
- Session cookie implementation — httpOnly, secure, SameSite=Lax, standard NextAuth session
- R2 bucket structure — flat or hierarchical (workspace/project/video), planner decides

## Prior Phase Patterns to Reuse

- **Tauri IPC for upload** — same `Channel<T>` pattern used in Plans 01-07 (capture events), 02-10 (render progress), 03-07 (NL chat events)
- **Zustand store for upload state** — follows nlStore, voiceoverStore, dryRunStore patterns
- **Error taxonomy** — `AppError` with `From` impls pattern from Phase 1-3 commands
- **Design tokens** — `packages/ui/src/tokens.css` dark theme carries to web (shared Tailwind v4 `@theme`)
- **tRPC + Prisma** — committed stack from CLAUDE.md; follow the linked guide

## Deferred Ideas

- **Password-protected viewer links** — v2, after workspace billing is in place
- **Link expiry / auto-delete** — v2, requires scheduled cleanup worker
- **Community template submissions** — v2, needs moderation pipeline + content policy
- **Bidirectional story editing** (edit on web, sync to desktop) — v2, requires OT/CRDT
- **Video comments / annotations on viewer page** — v2, new capability
- **Custom domain for viewer pages** — v2, requires CNAME + SSL provisioning

## Discussion Log

- 2026-04-16: All 8 gray areas presented with recommendations; user approved all defaults without overrides.

---
*Context created: 2026-04-16*
