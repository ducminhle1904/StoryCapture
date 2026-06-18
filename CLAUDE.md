# StoryCapture Agent Guide

Lean entrypoint for coding agents. Keep this file short and push detail into
read-on-demand docs.

## Project

StoryCapture turns a written `.story` script into a polished demo video.

- Desktop app: Electron + React 19 + Vite 8 on macOS and Windows.
- Core loop: author DSL -> automate a browser -> capture pixels -> encode ->
  apply post-production -> optionally upload/share via the web companion.
- Web companion: Next.js 16 + tRPC 11 + Prisma 6 + R2/S3 for sharing,
  workspaces, analytics, and desktop sync.

## Current Repo Reality

- Desktop routes: `/`, `/onboarding`, `/settings`, `/editor/:projectId`,
  `/recorder/:projectId`, `/post-production`, `/post-production/:storyId`.
- Electron owns the desktop host in `apps/desktop/electron`.
- The renderer still uses `@tauri-apps/api` and selected plugin packages as a
  compatibility API surface. The Electron preload/IPC layer implements those
  calls; there is no Rust/Tauri runtime in the packaged app.
- `packages/ui` ships shared tokens plus the `claude-design` namespace and
  `Sc*` primitive families.
- Current manifest pins: desktop Electron `^42.4.1`, Electron Builder
  `^26.15.3`, React `^19.2.5`, Vite `^8.0.9`, Tailwind `^4.2.4`; web Next
  `^16.2.4`, tRPC `^11.16.0`, Prisma `^6.0.0`, NextAuth
  `5.0.0-beta.31`.
- Web companion has public/watch/embed/invite pages, dashboard workspace/video
  surfaces, tRPC routers, NextAuth v5 GitHub + Google OAuth, R2 multipart
  upload, Resend invites, Vercel cron analytics aggregation, and desktop sync.

## Source Of Truth

Read only what the task needs.

1. `docs/ARCHITECTURE.md`
   Use for repo layout, Electron host ownership, IPC, routes, web APIs, CI and
   release topology.
2. `docs/DOMAIN.md`
   Use for DSL semantics, recording/export behavior, sidecars, post-production
   graph model, and AI/TTS feature boundaries.
3. `docs/CONVENTIONS.md`
   Use for code style, testing, state management, file layout, commit format,
   and workflow conventions.
4. `docs/CREDENTIALS.md`
   Use for signing, auth, R2, email, cron, and service secrets.
5. `.planning/STATE.md`
   Use for current milestone snapshot, operator-gated blockers, and latest
   shipped highlights.

## Load-On-Demand Map

- Changing structure, IPC, routing, CI, or release flows:
  read `docs/ARCHITECTURE.md`
- Changing DSL, automation behavior, capture/render pipeline, or roadmap-facing
  capability notes:
  read `docs/DOMAIN.md`
- Changing code style, tests, state patterns, or workflow rules:
  read `docs/CONVENTIONS.md`
- Changing signing, auth, R2, email, cron, or release secrets:
  read `docs/CREDENTIALS.md`

## Working Rules

- No workarounds. Fix root cause or stop with evidence.
- Plan first for breaking or big changes: public API, IPC, DSL, schema,
  security, build/release, or broad cross-cutting refactors.
- Keep docs token-efficient: put detail in `docs/*.md`, keep this file lean,
  and add read-on-demand pointers instead of duplicating long explanations.
- When code changes invalidate agent guidance, update this file only at the
  headline level and put the full refresh in the relevant doc.
