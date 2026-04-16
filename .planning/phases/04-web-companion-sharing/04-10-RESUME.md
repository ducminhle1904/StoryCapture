---
phase: 04-web-companion-sharing
plan: 10
checkpoint_type: human-verify
progress: 1/2 tasks complete
stopped_at: Task 2 (human-verify checkpoint)
---

# 04-10 Resume: Final Integration + Landing Page

## Completed Tasks

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Dashboard integration + landing page + global navigation + final typecheck | 2cceda9 | apps/web/src/app/(dashboard)/page.tsx, apps/web/src/app/(dashboard)/workspace-switcher-server.tsx, apps/web/src/app/(dashboard)/layout.tsx, apps/web/src/app/page.tsx, apps/web/next.config.ts |

## Current Task

**Task 2:** Human verification of complete web companion
**Type:** checkpoint:human-verify
**Status:** awaiting verification

## What Was Built

Complete Phase 4 Web Companion integration:
- **Dashboard page** with workspace switcher, video grid (with status badges), per-video quick actions (View, Analytics, Edit), and quick stats (total/published/ready counts)
- **Landing page** with hero ("Turn stories into shareable demo videos"), 3 feature cards (Record, Polish, Share), CTA button to sign-in, and footer. Authenticated users are redirected to /dashboard.
- **Sidebar navigation** updated with Sync link (Dashboard, Templates, Sync)
- **next.config.ts** hardened with security headers: X-Frame-Options DENY on non-embed pages, HSTS, nosniff, Permissions-Policy, Referrer-Policy. Embed pages (/embed/*) allow framing per D-03. R2 image domains configured.
- **Typechecks:** Web TS passes. Cargo check passes. Desktop TS has pre-existing errors (not introduced by this plan).

## How to Verify

1. Start the web app: `cd apps/web && pnpm dev` -- verify it boots at http://localhost:3000

2. Auth flow (WEB-02):
   - Visit http://localhost:3000 -- see landing page with hero, feature cards, CTA
   - Click "Get Started" -> redirected to sign-in
   - (If OAuth credentials configured) Sign in with GitHub or Google
   - Verify redirect to /dashboard
   - Verify personal workspace auto-created

3. Dashboard navigation:
   - Workspace switcher visible in top-right of dashboard
   - Sidebar navigation links to Dashboard, Templates, Sync pages work
   - Sign-out works and redirects to landing page (not /sign-in)

4. Templates (WEB-06):
   - Visit /templates -- see category grid with 9 categories
   - Template cards show name, description, category badge

5. Visual check:
   - Dark theme consistent across all pages
   - Responsive layout (resize browser window)
   - No console errors
   - All pages render without blank screens

Note: Full upload, viewer, analytics, and sync flows require deployed infrastructure (R2, Neon, Vercel).

## Resume Signal

Type "approved" to complete Phase 4, or describe any issues to fix.

## Remaining After Approval

- Write 04-10-SUMMARY.md
- Update STATE.md, ROADMAP.md, REQUIREMENTS.md
- Final metadata commit
