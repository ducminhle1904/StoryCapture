# StoryCapture Agent Guide

Lean entrypoint for coding agents. Keep this file short and push detail into
read-on-demand docs.

## Project

StoryCapture turns a written `.story` script into a polished demo video.

- Desktop app: Tauri v2 + React 19 + Vite 8 on macOS and Windows.
- Core loop: author DSL → automate a real browser → capture native pixels →
  encode → apply cinematic post-production → optionally upload/share via the
  web companion.
- Web companion: Next.js 16 + tRPC 11 + Prisma 6 + R2/S3 for sharing,
  workspaces, analytics, and desktop sync.

## Current Repo Reality

- Desktop routes now include `/`, `/settings`, `/editor/:projectId`,
  `/recorder/:projectId`, `/post-production`, `/post-production/:storyId`, and
  `/region-overlay`.
- Tauri IPC already includes live preview, author preview, simulator,
  author-time snapshot validation, picker flows, output prefs, upload, web
  account, and web sync surfaces.
- Domain crates are active and non-trivial: `story-parser`, `automation`,
  `capture`, `encoder`, `effects`, `storage`, `intelligence`, `util`.
- `packages/ui` already ships both shared tokens and the `claude-design`
  namespace; it is not just future scaffolding.
- The live project status is tracked in `.planning/STATE.md`. Treat
  `.planning/PROJECT.md` and `.planning/REQUIREMENTS.md` as historical planning
  artifacts unless they are explicitly refreshed.

## Source Of Truth

Read only what the task needs.

1. `docs/ARCHITECTURE.md`
   Use for repo layout, crate ownership, IPC, route surfaces, web APIs, CI and
   release topology.
2. `docs/DOMAIN.md`
   Use for DSL semantics, pipeline behavior, self-healing targets, post-prod
   graph model, intelligence layer, and live roadmap summary.
3. `docs/CONVENTIONS.md`
   Use for code style, testing, state management, file layout, commit format,
   and workflow conventions.
4. `docs/CREDENTIALS.md`
   Use for signing, notarization, updater, OAuth, R2, JWT, cron, and email
   secrets.
5. `.planning/STATE.md`
   Use for current milestone, live progress, operator-gated blockers, and
   latest shipped phases.

## Load-On-Demand Map

- Changing structure, IPC, crates, routing, release flows:
  read `docs/ARCHITECTURE.md`
- Changing DSL, automation behavior, capture/render pipeline, roadmap-facing
  capability notes:
  read `docs/DOMAIN.md`
- Changing code style, tests, state patterns, workflow rules:
  read `docs/CONVENTIONS.md`
- Changing signing, auth, R2, email, cron, or release secrets:
  read `docs/CREDENTIALS.md`

## Working Rules

- No workarounds. Fix root cause or stop with evidence.
- Plan first for breaking or big changes: public API, IPC, DSL, schema,
  security, build/release, or broad cross-cutting refactors.
- Use GSD workflow entrypoints before repo edits unless the user explicitly
  asks to bypass.
- Keep docs token-efficient: put detail in `docs/*.md`, keep this file lean,
  and add read-on-demand pointers instead of duplicating long explanations.
- When code changes invalidate agent guidance, update this file only at the
  headline level and put the full refresh in the relevant doc.
- **Sidecar placeholder gotcha**: if you run
  `bash scripts/dev/install-sidecar-placeholders.sh` to unblock
  `cargo check`, the stubs left in `apps/desktop/src-tauri/binaries/` will
  hang Live Preview / author preview at runtime ("Starting preview…")
  unless the SEA build replaces them. `build-sea.mjs` now auto-detects
  ≤ 10 KB outputs as stubs and forces rebuild — if you ever bypass that,
  `rm` the `playwright-sidecar-<triple>` placeholder before running
  `pnpm tauri:dev`. Full context: `docs/CONVENTIONS.md` → "Local sidecar
  binaries".
