# StoryCapture Agent Guide

Lean entrypoint for coding agents. `AGENTS.md` is the source-of-truth guide;
`CLAUDE.md` symlinks to it, and `GEMINI.md` resolves through `CLAUDE.md`.
Edit `AGENTS.md` when updating agent guidance.

## Start Here

- Use `docs/agent/project-map.md` for the repo map, generated-file guardrails,
  and first files to read by area.
- Use `docs/agent/module-index.md` for detailed frontend, Electron, web,
  package, and asset routing.
- Use `docs/agent/workflows.md` for install, dev, build, typecheck, Prisma,
  CI, and release commands.
- Use `docs/agent/testing.md` for focused Vitest commands and test coverage
  expectations.
- Use `docs/agent/operations.md` for CI, deploy, signing, env, cron, Prisma
  migrations, and generated files.
- Keep command output token-efficient: use `context-mode` for broad output and
  `rtk` for real shell commands.

## Project

StoryCapture turns a written `.story` script into a polished, shareable demo
video.

- Desktop app: Electron + React + Vite on macOS and Windows.
- Core loop: author DSL -> automate a browser -> capture pixels -> encode ->
  post-produce -> optionally upload/share through the web companion.
- Web companion: Next.js + tRPC + Prisma + R2/S3 for sharing, workspaces,
  analytics, templates, and desktop sync.
- Check package manifests and `pnpm-lock.yaml` for current dependency pins; do
  not duplicate version inventories in this guide.

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
  `tauri-invoke` bridge, `apps/desktop/electron/ipc/handlers.ts` is the
  registry, grouped modules live in `apps/desktop/electron/ipc/*`, and
  Tauri-compatible plugin shims live in `apps/desktop/electron/ipc/plugin/*`.
  Remaining legacy host operations live under
  `apps/desktop/electron/ipc/legacy/`; `ipc/legacy.ts` is the compatibility
  dispatcher entrypoint.
- `packages/story-dsl` is AST/vocabulary plus CodeMirror support. Runtime parse
  and simulator behavior is desktop IPC/host code, not a shared parser package.
- `packages/shared-types` publicly exports browser presets, web account types,
  and the checked-in IPC compatibility surface.
  `packages/shared-types/src/generated/effects.ts` is checked-in generated
  source, but is not currently exported through the package export map.
- `packages/ui` ships shared tokens plus the `claude-design` namespace and
  `Sc*` primitive families.
- `packages/config` owns the shared TypeScript base config.
- `packages/glob-compat`, `packages/lodash-isequal-compat`, and
  `packages/rimraf-compat` are private CommonJS shims selected by
  `pnpm-workspace.yaml` overrides for legacy Electron packaging consumers.

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

## Task Routing

- Desktop renderer/routes: read `apps/desktop/src/routes/index.tsx`, then the
  matching route in `apps/desktop/src/routes/` and feature folder under
  `apps/desktop/src/features/`.
- Desktop IPC/host: read `docs/ARCHITECTURE.md`,
  `apps/desktop/electron/ipc/handlers.ts`, the matching
  `apps/desktop/electron/ipc/*.ts` module, and the renderer facade in
  `apps/desktop/src/ipc/*`.
- DSL/editor/simulator: read `docs/DOMAIN.md`,
  `packages/story-dsl/src/ast.ts`, `packages/story-dsl/src/codemirror-lang.ts`,
  `apps/desktop/electron/ipc/story-parser.ts`, and
  `apps/desktop/src/features/editor/`.
- Post-production/export: read `docs/DOMAIN.md` and
  `apps/desktop/src/features/post-production/`, especially
  `apps/desktop/src/features/post-production/state/store.ts`,
  `apps/desktop/src/features/post-production/state/compute-graph.ts`,
  `apps/desktop/src/features/post-production/state/build-timeline-from-story.ts`,
  `apps/desktop/src/features/post-production/preview/preview-engine.ts`,
  `apps/desktop/src/features/post-production/export-modal/`, and
  `apps/desktop/src/features/post-production/render-queue/`.
- Recorded action/cursor timing: read `docs/DOMAIN.md`,
  `apps/desktop/electron/ipc/action-timeline.ts`,
  `apps/desktop/electron/ipc/action-landmarks.ts`,
  `apps/desktop/electron/ipc/cursor-sync-mode.ts`,
  `apps/desktop/electron/ipc/cursor-timing.ts`,
  `apps/desktop/electron/ipc/legacy/story-runner.ts`,
  `apps/desktop/src/ipc/actions.ts`, and
  `apps/desktop/src/features/post-production/state/virtual-cursor-scheduler.ts`.
- Source/timeline synchronization and presented-media playback: read
  `apps/desktop/src/features/post-production/state/source-timeline-map.ts`,
  `apps/desktop/src/features/post-production/state/cursor-preset-reflow.ts`,
  `apps/desktop/src/features/post-production/preview/presented-media-clock.ts`,
  `apps/desktop/src/features/post-production/preview/preview-player.tsx`, and
  `apps/desktop/src/features/post-production/export-compositor/export-compositor-app.tsx`.
- Web routes/API/data: read `apps/web/src/app`, `apps/web/src/app/api`,
  `apps/web/src/trpc/routers/_app.ts`, `apps/web/src/trpc/routers/*`,
  `apps/web/src/lib/*`, and `apps/web/prisma/schema.prisma`.
- Desktop-web sync/upload/auth: read `apps/web/src/trpc/routers/sync.ts`,
  `apps/web/src/app/api/auth/*`,
  `apps/desktop/electron/ipc/legacy/web.ts`, and
  `apps/desktop/src/stores/*web*`.
- Shared UI/design system: read `docs/CONVENTIONS.md`,
  `packages/ui/src/claude-design/README.md`,
  `packages/ui/src/claude-design/tokens.css`,
  `packages/ui/src/claude-design/primitives/`, and
  `apps/desktop/src/components/ui/`.
- CI, release, signing, env, cron, Prisma migrations, and generated files:
  read `docs/agent/operations.md` and `docs/CREDENTIALS.md`.

## Common Workflows

- Package manager and Node versions: read root `package.json` (`packageManager`,
  `engines`) and `.github/actions/setup-toolchain/action.yml`; do not rely on
  this guide for version pins.
- Root commands: `pnpm dev`, `pnpm build`, `pnpm typecheck`, `pnpm lint`,
  `pnpm format`.
- There is no root `pnpm test`; run package-scoped Vitest commands from
  `docs/agent/testing.md`.
- Web Prisma commands live in `apps/web/package.json`: `db:generate`,
  `db:migrate`, `db:push`, and `db:seed`.
- CI is `.github/workflows/ci.yml` and runs typecheck, desktop tests, UI tests,
  web tests, then the desktop Electron build on macOS.

## Guardrails

- No workarounds. Fix root cause or stop with evidence.
- Plan first for breaking or big changes: public API, IPC, DSL, schema,
  security, build/release, or broad cross-cutting refactors.
- Never revive removed Tauri/Rust assumptions from historical planning docs.
- Do not hand-edit generated output:
  `apps/web/src/generated/prisma/**` or
  `packages/shared-types/src/generated/effects.ts`.
- Avoid generated/build/cache/artifact directories unless the task is
  specifically about them: `node_modules/`, `.turbo/`, `.next/`, `dist/`,
  `apps/desktop/dist-electron/`, `apps/desktop/.electron-dev/`,
  `release-electron/`, `output/`, `tmp/`, `scripts/build-ffmpeg/build/`, and
  generated Prisma output.
- After code changes, update agent docs when the change affects future agent
  routing, workflows, commands, architecture, generated-file rules, or module
  ownership; keep `AGENTS.md` concise and put detail in `docs/agent/` or the
  relevant source doc as read-on-demand context.
- Keep agent docs token-efficient: update this file only at the routing level
  and put detail in `docs/agent/` or the existing `docs/*.md` source docs.
