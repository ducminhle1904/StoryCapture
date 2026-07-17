# Operations Guide

Read this before changing CI, deploy, signing, environment variables, Prisma
migrations, generated files, or release tooling.

## CI

- Workflow: `.github/workflows/ci.yml`.
- Toolchain action: `.github/actions/setup-toolchain/action.yml`.
- CI runner images are defined in `.github/workflows/ci.yml`. The macOS job
  installs with `pnpm install --frozen-lockfile`, then runs:
  - `pnpm typecheck`
  - `pnpm --dir apps/desktop exec vitest run`
  - `pnpm --dir apps/desktop run test:e2e:cursor-sync`
  - `pnpm --dir apps/desktop run test:e2e:media`
  - `pnpm --dir packages/ui test`
  - `pnpm --dir apps/web test`
  - `pnpm --dir apps/desktop run test:e2e:export`
- The Windows job runs local-media and packaged export parity smokes. Both
  package smokes use the platform binaries installed on that runner.
- The Ubuntu Prisma job uses a disposable PostgreSQL 17 service. Because the
  repository's checked-in migration history starts after the original schema
  baseline, CI uses `prisma db push` only for this empty disposable database,
  then runs adapter CRUD and seed smokes. Do not copy this bootstrap flow to a
  production database or fabricate a baseline migration without a dedicated
  production migration plan.
- CI package manager and Node versions are configured in
  `.github/actions/setup-toolchain/action.yml`; dependency pins live in package
  manifests and `pnpm-lock.yaml`, not agent docs.
- Third-party actions are pinned to full commit SHAs with a version comment.
  Dependency upgrades must respect the 7-day `minimumReleaseAge` policy in
  `pnpm-workspace.yaml` and record younger deferred releases explicitly.

## Desktop Packaging And Release

- Electron packaging config is in `apps/desktop/package.json` under `build`.
- Desktop build scripts:
  - `apps/desktop/scripts/build-electron.mjs`
  - `apps/desktop/scripts/start-dev-electron.mjs`
  - `apps/desktop/scripts/prepare-dev-electron-app.mjs`
- Electron package output is `apps/desktop/release-electron`.
- Packaged export verification is
  `pnpm --dir apps/desktop run test:e2e:export`; its main-process harness is
  `apps/desktop/electron/ipc/export-e2e-smoke.ts`, and its launcher is
  `apps/desktop/scripts/export-compositor-artifact-smoke.mjs`.
- Production export code must resolve FFmpeg and ffprobe through
  `apps/desktop/electron/ipc/export-binaries.ts`. Executables packaged below
  `app.asar` are run from `app.asar.unpacked`; keep installer changes covered
  by the package smoke on each supported CI OS.
- Output reservations and same-folder partial files are owned by
  `apps/desktop/electron/ipc/legacy/export-output-lifecycle.ts`. The host stores
  a registry of used output folders under Electron `userData`, removes only
  dead-process reservation sidecars/partials at startup, serializes concurrent
  registry updates, and publishes a verified same-folder partial with an
  atomic no-replace hard link so it never overwrites a final file created after
  reservation.
- Signing/notarization scripts are standalone, not wired into a current GitHub
  release workflow:
  - `scripts/notarize/notarize-mac.sh`
  - `scripts/notarize/adhoc-sign.sh`
  - `scripts/release/sign-windows.ps1`
- For signing secrets and missing-secret behavior, read `docs/CREDENTIALS.md`
  first.

## Web Deploy And Cron

- Vercel config: `apps/web/vercel.json`.
- Web build command is `pnpm run build` from `apps/web/package.json`, which runs
  `pnpm run typecheck && next build`; the typecheck runs
  `pnpm run db:generate && tsc --noEmit`.
- Next production config is `apps/web/next.config.ts`.
- GeoLite provisioning is manual: `apps/web/scripts/download-geolite2.sh` is
  not called by package scripts, CI, or Vercel config. Runtime lookup expects
  gitignored `apps/web/public/geolite2/GeoLite2-Country.mmdb` and returns `XX`
  when the database is absent.
- Scheduled analytics job:
  - Config: `apps/web/vercel.json`.
  - Route: `apps/web/src/app/api/cron/aggregate-analytics/route.ts`.
  - Schedule: `0 0 * * *`.
- Production must set `CRON_SECRET`; otherwise the cron route's bearer check is
  disabled.

## Environment And Secrets

- Web env example: `apps/web/.env.example`.
- Credential source of truth: `docs/CREDENTIALS.md`.
- Never commit plaintext secrets.
- Web companion env includes `DATABASE_URL`, `AUTH_SECRET`, OAuth client
  secrets, `JWT_SECRET`, R2 credentials, `RESEND_API_KEY`,
  `MAXMIND_LICENSE_KEY`, and `CRON_SECRET`.
- Desktop AI/TTS keys are stored in the OS keychain at runtime, not in repo env
  files.

## Prisma, Migrations, And Generated Files

- Prisma schema: `apps/web/prisma/schema.prisma`.
- Seed file: `apps/web/prisma/seed.ts`.
- Migrations: `apps/web/prisma/migrations/`.
- Generated Prisma client: `apps/web/src/generated/prisma`; do not edit
  directly.
- Relevant commands from `apps/web/package.json`:
  - `pnpm --dir apps/web db:migrate`
  - `pnpm --dir apps/web db:push`
  - `pnpm --dir apps/web db:generate`
  - `pnpm --dir apps/web db:seed`

## Generated File Guardrails

- Do not hand-edit `apps/web/src/generated/prisma/**`.
- Do not hand-edit `packages/shared-types/src/generated/effects.ts`; it is
  generated by `ts-rs`.
- `packages/shared-types/src/generated/effects.ts` is not exported through
  `packages/shared-types/package.json`.
- Treat `scripts/build-ffmpeg/build/` as helper-script build output unless the
  task is directly about FFmpeg dependency builds.
- `STORYCAPTURE_CURSOR_SYNC_MODE=legacy|shadow|unified` is an internal rollout
  control, not a public setting or secret. Invalid/unset values resolve to
  `shadow`; promote cohorts only after local invariant counters and encoded
  parity gates pass. Roll back by selecting `legacy`; compatibility readers
  remain available indefinitely.

### Cursor Synchronization Diagnostics

- `scripts/ci/analyze-cursor-sync-roi.mjs` decodes a grayscale ROI against the
  first-frame baseline and reports `first_changed_frame`, `expected_frame`,
  `delta_frames`, and `decoded_frames`. Defaults are one-frame tolerance and
  mean-pixel threshold 8; use `FFMPEG_PATH` to override the FFmpeg binary.
- Promotion order is `legacy` -> `shadow` -> `unified` internal -> beta -> GA.
  Shadow writes the compatible v2 projection and logs only local event/count
  invariants. Require focused/backpressure tests, Electron smoke, encoded ROI
  parity, and the render benchmark before promotion. Roll back immediately by
  setting `STORYCAPTURE_CURSOR_SYNC_MODE=legacy`; keep v1/v2 readers enabled.
