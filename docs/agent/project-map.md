# Project Map

Use this as the first repo map before opening broad source files. `CLAUDE.md`
is the root agent guide; `AGENTS.md` and `GEMINI.md` symlink to it.

## Workspace

- `package.json`: pnpm workspace root and root scripts.
- `pnpm-workspace.yaml`: workspace packages are `apps/*` and `packages/*`.
- `turbo.json`: root `dev`, `build`, `typecheck`, and `lint` task graph.
- `biome.json`: formatter/linter config; generated/build directories are
  excluded.

## Apps

- `apps/desktop`: Electron host plus React/Vite renderer.
  - Renderer entrypoints: `apps/desktop/src/main.tsx`,
    `apps/desktop/src/App.tsx`, `apps/desktop/src/routes/index.tsx`.
  - Electron host entrypoints: `apps/desktop/electron/main.ts`,
    `apps/desktop/electron/preload.ts`, `apps/desktop/electron/runtime.ts`.
  - IPC bridge/registry: `apps/desktop/electron/ipc.ts`,
    `apps/desktop/electron/ipc/handlers.ts`,
    `apps/desktop/electron/ipc/*.ts`.
- `apps/web`: Next.js web companion with App Router, tRPC, Prisma, auth, R2,
  analytics, templates, and desktop sync.
  - Routes/pages: `apps/web/src/app`.
  - REST handlers: `apps/web/src/app/api`.
  - tRPC: `apps/web/src/trpc`.
  - Data: `apps/web/prisma/schema.prisma`,
    `apps/web/prisma/migrations/`, `apps/web/src/generated/prisma/`.

## Packages

- `packages/story-dsl`: `.story` AST vocabulary and CodeMirror language support.
  Runtime parsing/simulation still lives in desktop IPC/host code.
- `packages/shared-types`: browser presets, IPC compatibility types, web account
  types, and checked-in generated effect types.
- `packages/ui`: shared tokens, `claude-design` CSS, and `Sc*` primitives.
- `packages/config`: shared TypeScript base config.

## Source Docs

- `docs/ARCHITECTURE.md`: repo layout, Electron ownership, IPC registry,
  routes, web APIs, package boundaries, CI, release topology.
- `docs/DOMAIN.md`: DSL, sidecars, authoring, automation, recording, export,
  post-production, AI/NL/TTS, templates, web sync.
- `docs/CONVENTIONS.md`: TypeScript/React style, state, IPC, UI, tests, CI,
  commit and agent workflow.
- `docs/CREDENTIALS.md`: signing, auth, R2/S3, email, cron, desktop runtime env,
  provider keys, and missing-secret behavior.

## Avoid By Default

- Generated/build/cache/artifacts: `node_modules/`, `.turbo/`, `.next/`,
  `dist/`, `release-electron/`, `output/`, `tmp/`.
- Generated Prisma client: `apps/web/src/generated/prisma/**`.
- Checked-in generated effect types:
  `packages/shared-types/src/generated/effects.ts`.
- Benchmark fixtures: `scripts/benchmark/fixtures/`.
- Vendored or build outputs under helper scripts unless the task is directly
  about those scripts.
