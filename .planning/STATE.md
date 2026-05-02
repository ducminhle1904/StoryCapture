---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: milestone
status: executing
last_updated: "2026-05-02T00:00:00.000+07:00"
progress:
  total_phases: 25
  completed_phases: 19
  total_plans: null
  completed_plans: null
  percent: null
---

# State: StoryCapture

**Last updated:** 2026-05-02

This file is the compact live snapshot. Older long-form context lives in
per-phase summaries under `.planning/phases/`, quick task summaries under
`.planning/quick/`, and the active post-production ledger in
`.planning/POST-PROD-ROADMAP.md`.

## Project Reference

- **Name:** StoryCapture
- **Core Value:** Turn a written `.story` script into a polished, shareable demo
  video automatically.
- **Stack:** Tauri 2.10 + React 19 + Vite 8 desktop; Next.js 16 + tRPC 11 +
  Prisma 6 web companion; Rust domain crates for parser, automation, capture,
  encoder, effects, storage, intelligence, and util.

## Current Position

- Core v1 phases through recording, semantic picking, live preview, simulator,
  output customization, dependency refresh, and recording lifecycle hardening
  are code-complete, with several operator-gated verification items still open.
- Post-production functional gap work advanced beyond the older Phase 17 ledger:
  Phase 18 shipped real-video preview wiring and computeGraph plumbing; Phase 19
  shipped typed timeline clips, recording sidecar IPC, and Story → Timeline
  auto-population.
- Current active push is post-production E2E readiness. See
  `.planning/POST-PROD-ROADMAP.md` for the live Phase 20-25 breakdown.
- Latest quick work (2026-05-01) shipped hybrid Editor UI / Code mode,
  `<story>.polish.json`, `Record & Polish`, and polish-driven post-production
  defaults for zoom/callout/highlight/transition/cursor intent. Follow-up quick
  work added accurate `.steps.json` timing sidecars, low-confidence partial
  timing flushes, actionable post-production review fix-list items, and pruning
  for stale polish entries.

## Latest Shipped Highlights

- **Desktop IPC:** `apps/desktop/src-tauri/src/ipc_spec.rs` exports 28 IPC
  modules, 122 commands, and 145 Specta types. Newer surfaces include
  `actions`, `trajectory`, and `frontend_log`.
- **Recording sidecars:** recording runs can produce `<recording>.actions.json`,
  `<recording>.trajectory.json`, and `<recording>.steps.json`; post-production
  consumes these for cursor/zoom/callout defaults.
- **Post-production:** latest-recording preview, typed 5-track Clip union,
  computeGraph → Effects Graph JSON, cursor sidecar preprocessing, and
  Story → Timeline auto-population are in source.
- **Cursor export path:** export preprocessing now renders cursor overlay JSON
  sidecars into PNG sequences before FFmpeg receives the graph. Real E2E UAT is
  still required before calling the flow production-verified.
- **Editor:** UI mode writes canonical DSL back to the source buffer; polish
  controls write only after user edits, so opening a project does not create a
  default polish sidecar.
- **Design system:** `packages/ui` exposes the `claude-design` namespace and 15
  Sc* primitive families over Base UI and Tailwind v4 tokens.

## Active Blockers / Operator-Gated Work

- **01-07 capture soak:** real macOS Screen Recording TCC host required for the
  30-minute capture soak workflow.
- **01-10 release signing:** requires Apple/Windows signing secrets and clean
  release verification on macOS arm64, macOS x64, and Windows x64.
- **02-08 audio curation:** committed sound library files are placeholders.
  Human curation of 20 CC0/CC-BY-4.0 assets plus listen-test is still required.
- **02-12b / Phase 21 post-production UAT:** real record → timeline → export
  walkthrough still needs operator execution.
- **03-20 accounts / AI disclosure UAT:** Settings → Accounts and disclosure
  walkthrough still needs operator verification.
- **04-10 web integration UAT:** OAuth, desktop upload, share page, invites,
  analytics, and sync walkthrough still needs operator verification.
- **Licensing:** resolve FFmpeg LGPL/GPL packaging posture before public beta.

## Deferred Version / Dependency Work

- Prisma 7 upgrade is deferred.
- `windows-rs` 0.62 unification is deferred until Windows WGC verification is
  available.
- `tauri-specta` / `specta` rc.24 is deferred because the newer rc requires
  nightly Rust features; current pinned line stays on stable Rust 1.88.

## Planning Pointers

- `.planning/POST-PROD-ROADMAP.md` — active post-production E2E roadmap.
- `.planning/phases/18-post-prod-review-real-video-compute-graph/18-SUMMARY.md`
  — real video + computeGraph context.
- `.planning/phases/19-story-to-timeline-typed-clips/19-PLAN.md` — original
  Phase 19 plan; source now reflects the shipped work even though this artifact
  remains plan-shaped.
- `.planning/phases/20-cursor-overlay-render-fix/20-PLAN.md` through
  `.planning/phases/25-post-prod-polish/25-PLAN.md` — current follow-up plans.
- `.planning/PROJECT.md`, `.planning/REQUIREMENTS.md`, and
  `.planning/ROADMAP.md` are historical unless explicitly refreshed.
