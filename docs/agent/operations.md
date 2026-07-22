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
  - `pnpm --dir apps/desktop run native:build:recording-v3`
  - `pnpm --dir apps/desktop run test:e2e:cursor-sync`
  - `pnpm --dir apps/desktop run test:e2e:media`
  - `pnpm --dir packages/ui test`
  - `pnpm --dir packages/ui test:boundaries`
  - `pnpm --dir packages/ui exec playwright install chromium`
  - `pnpm --dir packages/ui test:visual`
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
  - `apps/desktop/scripts/esbuild-shared-types-plugin.mjs`
  - `apps/desktop/scripts/start-dev-electron.mjs`
  - `apps/desktop/scripts/prepare-dev-electron-app.mjs`
  - `apps/desktop/scripts/build-native-capture.mjs`
  - `apps/desktop/scripts/verify-packaged-native-capture.mjs`
- Electron package output is `apps/desktop/release-electron`.
- Electron main/probe builds keep third-party packages external, but must use
  `esbuild-shared-types-plugin.mjs` to bundle every public
  `@storycapture/shared-types` runtime export. Otherwise packaged Node attempts
  to load TypeScript from `app.asar` and fails before startup. Keep this rule
  covered by `electron/shared-types-bundle-resolution.test.ts`.
- Electron Builder packages the ScreenCaptureKit helper at
  `resources/native/macos/storycapture-screen-capture-helper` and the WGC helper
  at `resources/native/windows/${arch}/storycapture-wgc.exe`.
- `pnpm --dir apps/desktop run test:e2e:recording-v2-helper` builds an unpacked
  package and verifies the helper signature and V2 protocol. The macOS verifier
  runs strict `codesign` verification; the Windows verifier requires a valid
  Authenticode signature and optionally checks the configured publisher.
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
- General signing/notarization scripts include:
  - `scripts/notarize/notarize-mac.sh`
  - `scripts/notarize/adhoc-sign.sh`
  - `scripts/release/sign-windows.ps1`
- For signing secrets and missing-secret behavior, read `docs/CREDENTIALS.md`
  first.

Recording V3 has dedicated trusted automation:

- `.github/workflows/recording-v3-nightly.yml` runs the sustained 60-second
  gate only for trusted `main`, after the same commit's normal CI succeeds, on
  a dedicated Mac17,2 self-hosted runner label set.
- `.github/workflows/recording-v3-release.yml` is manual-only, accepts only
  trusted main/release refs, and uses the protected `recording-v3-release`
  GitHub Environment before credentials are exposed.
- The release job runs sustained/static/lifecycle/fault-cleanup gates, creates
  one exact profile, signs the manifest, injects only the public signer key,
  then signs, notarizes, staples, clean-launches, and verifies the package.
- The final package restores the exact signed addon and FFmpeg bytes exercised
  by the certification executable before the outer app is signed/notarized.
  Do not rebuild or independently re-sign those binaries after evidence is
  generated; their hashes are part of the exact profile.

### Strict Recording V2/V3 Release Controls

- `BUNDLED_RECORDING_CERTIFICATION_TIERS` is intentionally empty. V2 Strict and
  V3 Strict Certified are fail-closed until the exact
  platform/architecture/hardware/backend/target tuple completes packaged live
  capture and release-soak certification.
- `STORYCAPTURE_DISABLE_RECORDING_TIER_IDS` is a comma-separated emergency
  kill switch. For V3 it matches the signed profile's `kill_switch_id`; the
  signed manifest can also list `disabled_kill_switch_ids`. Neither path may
  relabel a failed/degraded take as Strict.
- V3 source checkouts deliberately ship an empty generated signer-key map and
  no signed release manifest/evidence. Strict Certified therefore remains
  unavailable even when the addon and packaged production proof pass; Strict
  Local does not require these certification assets.
- Never hand-edit the V3 signer map, signed manifest, or certification evidence.
  `recording-v3-certification-profile.mjs`,
  `recording-v3-certification-sign-manifest.mjs`, and
  `recording-v3-certification-inject-signer.mjs` are release-automation inputs.
- Promote only after the protected 60-second/ten-minute gates, Developer ID
  app/addon verification, hardened runtime, notarization/stapling, exact
  manifest/profile match, evidence hash binding, and clean packaged preflight
  all pass.
- Failed Strict bundles remain inside `<project>/exports`, default to seven-day
  retention, and may be manually deleted only after validation as a contained
  `quality_failed` bundle.

### Recording V3 Local And Certified Boundary

- Strict Local and Strict Certified share the browser target, addon, FFmpeg,
  storage, source-rate, metadata, cadence, ledger, decode, deadline, and
  artifact-verification gates. Strict Certified alone adds signed
  manifest/profile matching.
- Strict Local is available in development and packaged builds without an
  environment opt-in. `dev:recording-v3` builds the addon and starts the normal
  Electron development runtime; it does not bypass a runtime gate.
- Strict Local uses validated DPR-1 viewport dimensions within the native
  safety limits. This flexibility does not relax the exact signed Strict
  Certified dimension profile.
- New Local bundles and derived exports use `strict_local`/`-strict-local` with
  a null certification profile. Legacy `uncertified_development` artifacts are
  normalized to Strict Local in memory without rewriting their manifests.
  Both remain previewable/editable/exportable locally and cannot be uploaded.
- New Certified bundles use `strict_certified` with a valid profile reference.
  Legacy `certified` artifacts normalize to that mode at read boundaries.
- Upload enforcement is host-owned in
  `apps/desktop/electron/ipc/recording-v3-export-provenance.ts` and
  `apps/desktop/electron/ipc/legacy/web.ts`. The atomic user-data registry
  preserves canonical export provenance across app reopen; renderer fields and
  filenames are not the sole authority.

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
- Do not hand-edit
  `apps/desktop/electron/ipc/recording-v3-certification-signer-keys.generated.ts`
  or generated `apps/desktop/recording-v3-certification/{manifest,evidence}.json`;
  the protected Recording V3 release workflow owns them.
- Treat `apps/desktop/recording-v3-certification-artifacts/` as disposable local
  runner output. Refresh
  `apps/desktop/native/macos-recording-v3/reports/production-600-frame-proof.json`
  only by rerunning the packaged production probe; do not hand-edit it.
- `packages/shared-types/src/generated/effects.ts` is not exported through
  `packages/shared-types/package.json`.
- Treat `scripts/build-ffmpeg/build/` as helper-script build output unless the
  task is directly about FFmpeg dependency builds.
- Treat `apps/desktop/native/macos-screen-capture/.build/`,
  `apps/desktop/native/macos-recording-v3/.build/`,
  `apps/desktop/native/windows-capture/build/`,
  `apps/desktop/native/windows-capture/bin/`, and
  `apps/desktop/release-electron/` as generated/package output.
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
