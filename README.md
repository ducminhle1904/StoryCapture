# StoryCapture

StoryCapture turns a written `.story` script into a polished, shareable demo
video automatically.

## What It Does

- Authors write UI stories in a small DSL.
- The desktop app automates a real browser against that story.
- Native capture and encode pipelines record the run.
- Post-production adds zooms, cursor effects, backgrounds, sound, annotations,
  and export fanout.
- A Next.js web companion handles upload, sharing, workspaces, analytics, and
  desktop sync.

## Stack

- Desktop: Electron, React 19, Vite 8, Tailwind v4, Base UI, Zustand, TanStack
  Query, Motion
- Web: Next.js 16, tRPC 11, Prisma 6, NextAuth v5 beta, Cloudflare R2

## Repo Layout

```text
apps/
  desktop/   Electron desktop app
  web/       Next.js web companion
packages/    Shared TS packages
scripts/     Build, release, notarize, and CI helpers
docs/        Read-on-demand technical docs
.planning/   GSD roadmap, phase artifacts, live state
```

## Read First

- [`AGENTS.md`](./AGENTS.md) or [`CLAUDE.md`](./CLAUDE.md): lean agent entrypoint
- [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md): structure, IPC, routes, CI,
  release topology
- [`docs/DOMAIN.md`](./docs/DOMAIN.md): DSL, pipeline, post-production,
  intelligence, roadmap summary
- [`docs/CONVENTIONS.md`](./docs/CONVENTIONS.md): patterns, testing, workflow
- [`docs/CREDENTIALS.md`](./docs/CREDENTIALS.md): signing and service secrets
- [`.planning/STATE.md`](./.planning/STATE.md): live project status

## Status

This repo moves quickly. Do not treat `README.md` as the live project tracker.
For current milestone, completed phases, and operator-gated blockers, read
[`./.planning/STATE.md`](./.planning/STATE.md).
