# Agent Workflows

## Package Manager And Workspace

- Package manager and Node versions are defined in root `package.json`
  (`packageManager`, `engines`) and `.github/actions/setup-toolchain/action.yml`.
  Read those files for exact versions instead of copying pins into agent docs.
- Workspaces are declared in `pnpm-workspace.yaml`: `apps/*`, `packages/*`.
- Prefer package-scoped commands for dev servers and focused checks.

## Install And Dev

- Install: `pnpm install`.
- Root dev: `pnpm dev`.
- Desktop dev: `pnpm --dir apps/desktop dev`.
- Web dev: `pnpm --dir apps/web dev`.

## Build, Typecheck, Lint, Format

- Root build: `pnpm build`.
- Root typecheck: `pnpm typecheck`.
- Root lint: `pnpm lint`.
- Format: `pnpm format`.
- Desktop Electron build: `pnpm --dir apps/desktop run build`.
- Desktop renderer build: `pnpm --dir apps/desktop renderer:build`.
- Web build: `pnpm --dir apps/web build`.
- Story DSL typecheck: `pnpm --dir packages/story-dsl typecheck`.

## Database And Codegen

- Prisma schema: `apps/web/prisma/schema.prisma`.
- Migrations: `apps/web/prisma/migrations/`.
- Seed file: `apps/web/prisma/seed.ts`.
- Generated Prisma client output: `apps/web/src/generated/prisma`.
- Generate Prisma client: `pnpm --dir apps/web db:generate`.
- Create dev migration: `pnpm --dir apps/web db:migrate`.
- Push schema: `pnpm --dir apps/web db:push`.
- Seed database: `pnpm --dir apps/web db:seed`.
- Web build runs `prisma generate && next build`.

## CI Mapping

- Primary workflow: `.github/workflows/ci.yml`.
- Toolchain action: `.github/actions/setup-toolchain/action.yml`.
- CI runs on `macos-14`:
  - `pnpm install --frozen-lockfile`
  - `pnpm typecheck`
  - `pnpm --dir apps/desktop exec vitest run`
  - `pnpm --dir packages/ui test`
  - `pnpm --dir apps/web test`
  - `pnpm --dir apps/desktop run build`

## Helper Scripts

- Local/manual CI helpers: `scripts/ci/check-av-drift.sh`,
  `scripts/ci/generate-synthetic-recording.sh`.
- Benchmark helper: `scripts/benchmark/render-1min.sh`.
- Release/signing helpers: `scripts/release/sign-windows.ps1`,
  `scripts/release/verify-installer-size.sh`,
  `scripts/notarize/adhoc-sign.sh`, `scripts/notarize/notarize-mac.sh`.

## Agent Docs Maintenance

- After code changes, update agent-facing docs if the change affects how future
  agents should find, modify, verify, or avoid parts of the repo.
- Keep `CLAUDE.md` as the routing index only. Put longer details in
  `docs/agent/` or the relevant `docs/*.md` source doc, then link or summarize
  from `CLAUDE.md` only when future sessions need the rule up front.
