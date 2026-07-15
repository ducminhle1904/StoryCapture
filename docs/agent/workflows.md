# Agent Workflows

## Package Manager And Workspace

- Package manager and Node versions are defined in root `package.json`
  (`packageManager`, `engines`) and `.github/actions/setup-toolchain/action.yml`.
  Read those files for exact versions instead of copying pins into agent docs.
- Workspaces are declared in `pnpm-workspace.yaml`: `apps/*`, `packages/*`.
- Transitive dependency overrides also live in `pnpm-workspace.yaml`. The local
  `packages/glob-compat`, `packages/lodash-isequal-compat`, and
  `packages/rimraf-compat` shims must be reviewed with Electron packaging
  dependency upgrades.
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
- Read the TypeScript pin from the workspace manifests and lockfile. The web app disables Next's
  built-in build-time type validation, but `pnpm --dir apps/web build` runs the
  web typecheck before `next build`. Run `pnpm --dir apps/web typecheck` first
  only when invoking `next build` directly.
  `@typescript/native-preview` is kept in the web dev dependencies so Next's
  TypeScript setup check does not fail in CI while built-in validation is off.
- Desktop Electron build: `pnpm --dir apps/desktop run build`.
- Desktop renderer build: `pnpm --dir apps/desktop renderer:build`.
- Packaged export parity: `pnpm --dir apps/desktop run test:e2e:export`.
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
- Web build runs `pnpm run typecheck && next build`; the typecheck runs
  `pnpm run db:generate && tsc --noEmit`.

## CI Mapping

- Primary workflow: `.github/workflows/ci.yml`.
- Toolchain action: `.github/actions/setup-toolchain/action.yml`.
- Read `.github/workflows/ci.yml` for current runner images. The macOS job runs:
  - `pnpm install --frozen-lockfile`
  - `pnpm typecheck`
  - `pnpm --dir apps/desktop exec vitest run`
  - `pnpm --dir apps/desktop run test:e2e:cursor-sync`
  - `pnpm --dir apps/desktop run test:e2e:media`
  - `pnpm --dir packages/ui test`
  - `pnpm --dir apps/web test`
  - `pnpm --dir apps/desktop run test:e2e:export`
- The Windows job runs the media and packaged export smokes.

## Helper Scripts

- Read one local record-engine JSONL file or exported diagnostic directory:
  - session coherence:
    `pnpm --dir apps/desktop diagnose:recording -- --input <path> --session <session-id> [--json]`;
  - process/discovery/native-spike coherence:
    `pnpm --dir apps/desktop diagnose:recording -- --input <path> --process [--json]`.
  Exit `0` means coherent, `1` means incomplete/inconsistent, and `2` means
  invalid input. The reader accepts typed record-engine schema V2 only; V1 and
  the removed `recording.legacy` event return `2`. Process sequences are
  validated independently per JSONL file. This command does not launch
  Electron or read project data.

- Local/manual CI helpers: `scripts/ci/check-av-drift.sh`,
  `scripts/ci/generate-synthetic-recording.sh`.
- Benchmark helper: `scripts/benchmark/render-1min.sh`.
- Encoded cursor/presentation ROI verifier:
  `node scripts/ci/analyze-cursor-sync-roi.mjs --video=<mp4> --roi=x:y:w:h --expected-frame=N [--tolerance=1]`.
  Set `FFMPEG_PATH` when `ffmpeg` is not on `PATH`; the command exits nonzero
  when no ROI change is found or the frame delta exceeds tolerance.
- Release/signing helpers: `scripts/release/sign-windows.ps1`,
  `scripts/release/verify-installer-size.sh`,
  `scripts/notarize/adhoc-sign.sh`, `scripts/notarize/notarize-mac.sh`.

## macOS Capture Spikes

- REC-190 system-audio diagnostic:
  `pnpm --dir apps/desktop run spike:macos-system-audio -- --matrix permissions,timing,performance,packaging`.
- REC-220 native external-capture diagnostic:
  `pnpm --dir apps/desktop run spike:macos-native-capture -- --matrix baseline,lifecycle,stress --profiles 1080p30,1440p30,4k30`.
- Add `--quick` only for harness smoke checks. Quick runs use scaled durations
  and can never promote a provider/backend or supersede a production adapter.
- The commands require macOS, `xcrun swiftc`, ScreenCaptureKit, a real shareable
  target, and the relevant Screen Recording/audio permission. Promotion also
  requires a signed/notarized diagnostic identity; an unsigned dev run is
  insufficient.
- Spike source stays under `apps/desktop/native/spikes/` and has no production
  imports. Do not add a native dependency, entitlement, packaged helper, or
  adapter from a spike result without the separate approval required by its
  plan.

## Agent Docs Maintenance

- After code changes, update agent-facing docs if the change affects how future
  agents should find, modify, verify, or avoid parts of the repo.
- Keep `AGENTS.md` as the routing index only. Put longer details in
  `docs/agent/` or the relevant `docs/*.md` source doc, then link or summarize
  from `AGENTS.md` only when future sessions need the rule up front.
- CI also runs cursor synchronization, local-media, and packaged export smokes.
  Use the owning package script so host/renderer bundles cannot be stale.
