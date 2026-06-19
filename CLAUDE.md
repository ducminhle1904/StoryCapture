# StoryCapture Agent Guide

Lean entrypoint for coding agents. Keep this file short and push detail into
read-on-demand docs.

## Project

StoryCapture turns a written `.story` script into a polished, shareable demo
video.

- Desktop app: Electron + React 19 + Vite 8 on macOS and Windows.
- Core loop: author DSL -> automate a browser -> capture pixels -> encode ->
  post-produce -> optionally upload/share through the web companion.
- Web companion: Next.js 16 + tRPC 11 + Prisma 6 + R2/S3 for sharing,
  workspaces, analytics, templates, and desktop sync.

## Current Repo Reality

- Desktop routes: `/`, `/onboarding`, `/settings`, `/editor/:projectId`,
  `/recorder/:projectId`, `/post-production`, `/post-production/:storyId`,
  plus wildcard redirect to `/`.
- Electron owns the desktop host in `apps/desktop/electron`. There is no
  packaged Rust/Tauri runtime, no `src-tauri`, and no Rust crate workspace in
  the current source tree.
- The renderer still imports `@tauri-apps/api` and selected Tauri plugin
  packages as a compatibility API surface. Electron preload/IPC shims implement
  those calls.
- Electron IPC is modular: `apps/desktop/electron/ipc.ts` registers the
  `tauri-invoke` bridge, `ipc/handlers.ts` is the registry, grouped modules live
  in `ipc/*`, and `ipc/legacy.ts` still owns many host operations.
- `packages/story-dsl` is AST/vocabulary plus CodeMirror support. Runtime parse
  and simulator behavior is desktop IPC/host code, not a shared parser package.
- `packages/shared-types` publicly exports browser presets and the checked-in
  IPC compatibility surface. `src/generated/effects.ts` is a checked-in
  generated file in the package tree, but it is not currently exported through
  the package export map.
- `packages/ui` ships shared tokens plus the `claude-design` namespace and
  `Sc*` primitive families.
- Current manifest pins: desktop Electron `^42.4.1`, Electron Builder
  `^26.15.3`, React `^19.2.5`, Vite `^8.0.9`, Tailwind `^4.2.4`; web Next
  `^16.2.4`, tRPC `^11.16.0`, Prisma `^6.0.0`, NextAuth
  `5.0.0-beta.31`.

## Source Of Truth

Read only what the task needs.

1. `docs/ARCHITECTURE.md`
   Repo layout, Electron host ownership, IPC registry, routes, web APIs,
   package boundaries, CI, and release topology.
2. `docs/DOMAIN.md`
   DSL semantics, sidecars, authoring/recording/export flows, post-production
   graph model, AI/NL/TTS boundaries, and web business flows.
3. `docs/CONVENTIONS.md`
   Code style, state patterns, IPC patterns, test commands, UI rules, commit
   format, and agent workflow.
4. `docs/CREDENTIALS.md`
   Signing, auth, R2, email, cron, desktop runtime env, and service secrets.
There is no `.planning/` directory in the current checkout. If planning
artifacts are restored later, treat them as historical unless a current state
file explicitly says otherwise.

## Load-On-Demand Map

- Changing structure, IPC, routing, CI, release, or package boundaries:
  read `docs/ARCHITECTURE.md`.
- Changing DSL, automation behavior, capture/render/export, post-production,
  AI/NL/TTS, templates, or web sync behavior:
  read `docs/DOMAIN.md`.
- Changing code style, tests, state patterns, UI, IPC implementation patterns,
  or workflow rules:
  read `docs/CONVENTIONS.md`.
- Changing signing, auth, R2, email, cron, desktop-web token exchange, provider
  keys, or runtime env:
  read `docs/CREDENTIALS.md`.
- Reading restored planning artifacts:
  treat old roadmap/research/phase docs as historical unless a current state
  file explicitly names them as live.

## Working Rules

- No workarounds. Fix root cause or stop with evidence.
- Plan first for breaking or big changes: public API, IPC, DSL, schema,
  security, build/release, or broad cross-cutting refactors.
- Keep docs token-efficient: put detail in `docs/*.md` or package READMEs and
  keep this file as the routing layer.
- Never revive removed Tauri/Rust assumptions from historical planning docs.
- When code changes invalidate agent guidance, update this file only at the
  headline level and put the full refresh in the relevant read-on-demand doc.
