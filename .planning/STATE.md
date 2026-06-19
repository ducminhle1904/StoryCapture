---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: milestone
status: executing
last_updated: "2026-06-19T00:00:00.000+07:00"
progress:
  total_phases: 25
  completed_phases: 19
  total_plans: null
  completed_plans: null
  percent: null
---

# State: StoryCapture

**Last updated:** 2026-06-19

This file is the compact live snapshot. Older long-form context lives in
per-phase summaries under `.planning/phases/`, quick task summaries under
`.planning/quick/`, and the active post-production ledger in
`.planning/POST-PROD-ROADMAP.md`.

Treat `.planning/PROJECT.md`, `.planning/REQUIREMENTS.md`,
`.planning/ROADMAP.md`, `.planning/research/*`, phase plans, and old handoffs
as historical unless this file explicitly points to them as current. Many of
those artifacts predate the Electron cleanup and still mention Tauri/Rust paths.

## Project Reference

- **Name:** StoryCapture
- **Core Value:** Turn a written `.story` script into a polished, shareable demo
  video automatically.
- **Current Stack:** Electron 42 + React 19 + Vite 8 desktop; Next.js 16 +
  tRPC 11 + Prisma 6 web companion; TypeScript shared packages for UI, Story
  DSL editor support, shared types, and config.
- **Removed Assumption:** The current repo has no packaged Rust/Tauri runtime,
  no `apps/desktop/src-tauri`, no root `Cargo.toml`, and no Rust crate
  workspace. Do not use historical Rust/Tauri planning docs as implementation
  guidance.

## Current Position

- Core v1 phases through recording, semantic picking, live preview, simulator,
  output customization, dependency refresh, and recording lifecycle hardening
  are code-complete enough for source-level continuation, with operator-gated
  verification items still open.
- Desktop host work now lives in Electron. The current IPC shape is
  `apps/desktop/electron/ipc.ts` bridge -> `ipc/handlers.ts` registry ->
  grouped `ipc/*` modules -> `ipc/legacy.ts` fallback.
- Post-production functional gap work advanced beyond the older Phase 17
  ledger: real-video preview wiring, computeGraph plumbing, typed timeline
  clips, recording sidecar IPC, and Story -> Timeline auto-population are in
  source.
- Current active push is post-production E2E readiness. See
  `.planning/POST-PROD-ROADMAP.md` for the live Phase 20-25 breakdown.
- Latest source reality includes hybrid Editor UI / Code mode,
  `<story>.polish.json`, Record & Polish defaults, `.steps.json` timing
  sidecars, export backend boundary, interrupted-render cancellation, stabilized
  render progress, match-source dimension hardening, direct MP4 color/fps fixes,
  and highlight overlay preprocessing.
- Remaining Phase 21 work is primarily operator UAT rather than an obvious
  source gap.

## Latest Shipped Highlights

- **Desktop IPC:** Electron owns host behavior. Modular handlers cover
  app/settings/logs/secrets, projects, post-production, capture, export,
  web-sync, AI, updates, recording, render, picker, preview, simulator, and
  Tauri-compatible plugin shims. `ipc/legacy.ts` still carries much of the host
  implementation.
- **Renderer compatibility:** The renderer still imports `@tauri-apps/api` and
  Tauri plugin packages. Electron preload implements the compatibility bridge.
- **Recording sidecars:** recording runs can produce `<recording>.actions.json`,
  `<recording>.trajectory.json`, and `<recording>.steps.json`; post-production
  consumes these for cursor/zoom/callout defaults.
- **Post-production:** latest-recording preview, typed timeline clips,
  computeGraph -> Effects Graph JSON, cursor/highlight preprocessing, and Story
  -> Timeline auto-population are in source.
- **Export path:** preprocessing can render cursor sidecars and highlight
  overlays into temp PNG assets before FFmpeg receives the graph. Real E2E UAT
  is still required before calling the flow production-verified. Current host
  export still has hardcoded codec choices in the legacy FFmpeg path.
- **Editor:** UI mode writes canonical DSL back to the source buffer; polish
  controls write only after user edits, so opening a project does not create a
  default polish sidecar.
- **Web companion:** Next.js 16 App Router with public watch/embed/invite
  surfaces, dashboard workspace/video/templates/analytics/sync surfaces,
  NextAuth v5 GitHub + Google OAuth, Prisma 6, R2 multipart upload, Resend
  invites, analytics ingestion/cron aggregation, and metadata-only desktop sync.
- **Design system:** `packages/ui` exposes shared tokens, `claude-design`, and
  15 `Sc*` primitive families over Base UI/Tailwind v4.

## Current-Source Caveats

- `apps/web/src/app/page.tsx` redirects authenticated users to `/dashboard`,
  while dashboard pages live under the `(dashboard)` route group. Verify route
  behavior before relying on `/dashboard` in product links or docs.
- Web test coverage is narrow around workflow helpers, template metadata, and
  sync metadata; auth callbacks, upload APIs, invite/RBAC, analytics cron,
  watch/embed/oEmbed, and route availability need dedicated verification.
- Desktop Electron host behavior is concentrated in `ipc/legacy.ts` with
  limited direct host tests. Renderer/editor/post-production component and state
  coverage is stronger than host IPC coverage.

## Active Blockers / Operator-Gated Work

- **01-07 capture soak:** real macOS Screen Recording TCC host required for the
  30-minute capture soak workflow.
- **01-10 release signing:** requires Apple/Windows signing secrets and clean
  release verification on macOS arm64, macOS x64, and Windows x64.
- **02-08 audio curation:** committed sound library files are placeholders.
  Human curation of 20 CC0/CC-BY-4.0 assets plus listen-test is still required.
- **02-12b / Phase 21 post-production UAT:** real record -> timeline -> export
  walkthrough still needs operator execution; source fixes for export backend,
  progress, cancellation, match-source, and color/fps are present.
- **03-20 accounts / AI disclosure UAT:** Settings -> Accounts and disclosure
  walkthrough still needs operator verification.
- **04-10 web integration UAT:** OAuth, desktop upload, share page, invites,
  analytics, and sync walkthrough still needs operator verification.
- **Licensing:** resolve FFmpeg LGPL/GPL packaging posture before public beta.

## Deferred Version / Dependency Work

- Prisma 7 upgrade is deferred.
- Windows capture verification remains operator/platform gated.
- Historical `tauri-specta` / `specta` and Rust dependency notes are obsolete
  for the current Electron source tree unless a future migration reintroduces
  Rust.

## Planning Pointers

- `.planning/POST-PROD-ROADMAP.md` — active post-production E2E roadmap.
- `.planning/phases/18-post-prod-review-real-video-compute-graph/18-SUMMARY.md`
  — historical but still useful real-video + computeGraph context.
- `.planning/phases/19-story-to-timeline-typed-clips/19-PLAN.md` — historical
  original Phase 19 plan; source now reflects the shipped work even though this
  artifact remains plan-shaped.
- `.planning/phases/20-cursor-overlay-render-fix/20-PLAN.md` through
  `.planning/phases/25-post-prod-polish/25-PLAN.md` — current follow-up plan
  context, but validate paths against current Electron source before acting.
- `.planning/PROJECT.md`, `.planning/REQUIREMENTS.md`, `.planning/ROADMAP.md`,
  `.planning/research/*`, and `.planning/SIMPLIFY-HANDOFF.md` are historical
  unless explicitly refreshed.
