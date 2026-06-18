# Contributing to StoryCapture

StoryCapture is an Electron desktop app plus a Next.js web companion that turns
DSL stories into polished demo videos.

## Prerequisites

| Tool | Version | Why |
|---|---|---|
| Node.js | `20.x` | Runs Electron, Vite, Next.js, and tooling |
| pnpm | `9.15.0` | Workspace package manager |
| Apple Developer ID Application certificate | optional | Required only for signed macOS distribution builds |

## Build Commands

From the repo root:

```bash
pnpm install
pnpm dev
pnpm typecheck
pnpm --dir apps/desktop exec vitest run
pnpm --dir packages/ui test
pnpm --dir apps/web test
pnpm --dir apps/desktop run build
```

## PR Expectations

- CI must pass in `.github/workflows/ci.yml`.
- Desktop package builds are unsigned locally unless signing credentials are
  configured.
- Squash-merge is preferred; one commit per logical change in the squashed
  message.
- Do not add `Co-Authored-By` trailers.

## Repo Layout

```text
apps/
  desktop/        Electron + React desktop app
  web/            Next.js companion
packages/
  shared-types/   shared DTO/type surfaces
  story-dsl/      DSL editor language support
  ui/             shared UI primitives and tokens
  config/         shared TypeScript config
scripts/          release/signing helpers and runbooks
docs/             read-on-demand technical docs
```

## Getting Help

Check `docs/` for current technical references and `.planning/` for historical
phase artifacts.
