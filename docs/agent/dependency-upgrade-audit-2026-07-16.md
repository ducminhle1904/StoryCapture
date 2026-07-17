# Dependency Upgrade Audit — 2026-07-16

Snapshot captured from the npm registry at `2026-07-16T13:25:09Z` and checked
again at `2026-07-16T13:55:53Z`. No registry target changed during execution.
This is a dated execution record, not a permanent version inventory. Re-query
the registry before a later dependency change.

## Policy

- Registry `dist-tags.latest` is the freshness source of truth.
- Normal upgrades require a release age of at least 7 full days.
- A younger latest release is left unchanged unless it is needed to remediate
  an active high/critical advisory and no mature patched release exists.
- `next-auth` is evaluated on its intentional v5 beta channel.
- `@types/node` is evaluated on the Node 24 line.
- Manifest range style is preserved; the lockfile and frozen installs provide
  reproducibility.

## Baseline security evidence

- `pnpm audit --json`: 31 advisories in the pre-upgrade lockfile (15 high,
  10 moderate, 6 low, 0 critical).
- `npm audit signatures --json`: no invalid or missing signatures in the
  pre-upgrade installation.
- All 91 live targets expose registry integrity metadata and registry
  signatures. Provenance attestations are not universal and are treated as a
  review signal rather than proof of compromise.
- Consumer lifecycle hooks among selected targets are limited to expected
  tooling packages such as Prisma/esbuild; no unexpected hook was found.
- Current direct vulnerable paths include Next, React Router, and Vite. The
  current AWS SDK graph also resolves vulnerable `fast-xml-parser` and
  `fast-xml-builder` packages.

## Direct dependency matrix

Disposition counts after applying the exact 7-day timestamp: 35 current,
44 normal upgrades, 3 mature security targets, and 9 deferred packages.
The matrix starts with the 91 direct dependencies present at P0. Prisma 7 adds
four required, mature direct packages, so the final direct inventory is 95.

| Package | Current manifest range | Registry target | Selected target | Disposition |
|---|---|---|---|---|
| `@auth/prisma-adapter` | `^2.11.2` | `2.11.2` | unchanged | current |
| `@aws-sdk/client-s3` | `^3.1033.0` | `3.1088.0` | `3.1083.0` | mature security target; latest quarantined |
| `@aws-sdk/s3-request-presigner` | `^3.1033.0` | `3.1088.0` | `3.1083.0` | mature security target; latest quarantined |
| `@base-ui/react` | `^1.6.0` | `1.6.0` | unchanged | current |
| `@biomejs/biome` | `^2.4.12` | `2.5.4` | unchanged | deferred until 2026-07-22 |
| `@codemirror/autocomplete` | `^6` | `6.20.3` | `6.20.3` | upgrade |
| `@codemirror/commands` | `^6` | `6.10.4` | `6.10.4` | upgrade |
| `@codemirror/language` | `^6` | `6.12.4` | `6.12.4` | upgrade |
| `@codemirror/lint` | `^6` | `6.9.7` | `6.9.7` | upgrade |
| `@codemirror/search` | `^6` | `6.7.1` | `6.7.1` | upgrade |
| `@codemirror/state` | `^6` | `6.7.1` | `6.7.1` | upgrade |
| `@codemirror/view` | `^6` | `6.43.6` | `6.43.6` | upgrade |
| `@dnd-kit/core` | `^6` | `6.3.1` | `6.3.1` | upgrade |
| `@ffprobe-installer/ffprobe` | `2.1.2` | `2.1.2` | unchanged | current |
| `@fontsource-variable/geist` | `^5.2.8` | `5.2.9` | `5.2.9` | upgrade |
| `@fontsource-variable/geist-mono` | `^5.2.7` | `5.2.8` | `5.2.8` | upgrade |
| `@lezer/highlight` | `^1` | `1.2.3` | `1.2.3` | upgrade |
| `@maxmind/geoip2-node` | `^6.3.4` | `7.0.0` | `7.0.0` | breaking upgrade |
| `@playwright/test` | `^1.61.1` | `1.61.1` | unchanged | current |
| `@prisma/client` | `^6.0.0` | `7.8.0` | `7.8.0` | breaking upgrade |
| `@prisma/adapter-pg` | added | `7.8.0` | `7.8.0` | required Prisma 7 adapter |
| `@sindresorhus/slugify` | `^3.0.0` | `3.0.0` | unchanged | current |
| `@tailwindcss/postcss` | `^4.2.4` | `4.3.3` | unchanged | deferred until 2026-07-23 |
| `@tailwindcss/vite` | `^4.2.4` | `4.3.3` | unchanged | deferred until 2026-07-23 |
| `@tanstack/react-query` | `^5.99.2` | `5.101.2` | `5.101.2` | upgrade |
| `@tanstack/react-query-devtools` | `^5.99.2` | `5.101.2` | `5.101.2` | upgrade |
| `@tanstack/react-virtual` | `^3` | `3.14.6` | unchanged | deferred until 2026-07-20 |
| `@tauri-apps/api` | `^2.10.1` | `2.11.1` | `2.11.1` | upgrade |
| `@tauri-apps/plugin-dialog` | `^2.7.0` | `2.7.1` | `2.7.1` | upgrade |
| `@tauri-apps/plugin-fs` | `^2.5.0` | `2.5.1` | `2.5.1` | upgrade |
| `@tauri-apps/plugin-log` | `^2.8.0` | `2.9.0` | unchanged | deferred until 2026-07-21 |
| `@tauri-apps/plugin-os` | `^2.3.2` | `2.3.2` | unchanged | current |
| `@tauri-apps/plugin-process` | `^2.3.1` | `2.3.1` | unchanged | current |
| `@tauri-apps/plugin-shell` | `^2.3.5` | `2.3.5` | unchanged | current |
| `@tauri-apps/plugin-store` | `^2.4.2` | `2.4.3` | `2.4.3` | upgrade |
| `@tauri-apps/plugin-updater` | `^2.10.1` | `2.10.1` | unchanged | current |
| `@tauri-apps/plugin-window-state` | `^2.4.1` | `2.4.1` | unchanged | current |
| `@testing-library/jest-dom` | `^6.9.1` | `6.9.1` | unchanged | current |
| `@testing-library/react` | `^16.3.2` | `16.3.2` | unchanged | current |
| `@testing-library/user-event` | `^14.6.1` | `14.6.1` | unchanged | current |
| `@trpc/client` | `^11.16.0` | `11.18.0` | `11.18.0` | upgrade |
| `@trpc/server` | `^11.16.0` | `11.18.0` | `11.18.0` | upgrade |
| `@trpc/tanstack-react-query` | `^11.16.0` | `11.18.0` | `11.18.0` | upgrade |
| `@types/node` | `^22.x` | `24.13.3` (Node 24) | `24.13.3` | runtime-aligned upgrade |
| `@types/pg` | added | `8.20.0` | `8.20.0` | required Prisma 7 adapter types |
| `@types/react` | `^19.2.14` | `19.2.17` | `19.2.17` | upgrade |
| `@types/react-dom` | `^19.2.3` | `19.2.3` | unchanged | current |
| `@typescript/native-preview` | `7.0.0-dev.20260707.2` | same | unchanged | intentional exact pin |
| `@uiw/react-codemirror` | `^4.25` | `4.25.11` | `4.25.11` | upgrade |
| `@vercel/analytics` | `^2.0.1` | `2.0.1` | unchanged | current |
| `@vitejs/plugin-react` | `^6.0.1` | `6.0.3` | `6.0.3` | upgrade |
| `@vitest/ui` | `^4.1.5` | `4.1.10` | `4.1.10` | upgrade |
| `class-variance-authority` | `^0.7.1` | `0.7.1` | unchanged | current |
| `client-only` | `^0.0.1` | `0.0.1` | unchanged | current |
| `clsx` | `^2.1.1` | `2.1.1` | unchanged | current |
| `cmdk` | `^1.1.1` | `1.1.1` | unchanged | current |
| `concurrently` | `^10.0.3` | `10.0.3` | unchanged | current |
| `dotenv` | added | `17.4.2` | `17.4.2` | explicit Prisma config environment loading |
| `electron` | `^42.4.1` | `43.1.1` | unchanged | deferred until 2026-07-21 |
| `electron-builder` | `^26.15.3` | `26.15.3` | unchanged | current |
| `electron-updater` | `^6.8.9` | `6.8.9` | unchanged | current |
| `esbuild` | `^0.28.1` | `0.28.1` | unchanged | current |
| `fast-deep-equal` | `3.1.3` | `3.1.3` | unchanged | current |
| `ffmpeg-static` | `^5.3.0` | `5.3.0` | unchanged | current |
| `glob-modern` (`glob` alias) | `npm:glob@13.0.2` | `13.0.6` | `13.0.6` | upgrade |
| `happy-dom` | `^20.9.0` | `20.10.6` | `20.10.6` | upgrade |
| `jose` | `^6.2.2` | `6.2.3` | `6.2.3` | upgrade |
| `lucide-react` | `^1.8.0` | `1.24.0` | `1.24.0` | upgrade; crossed exact 7-day threshold during P0 |
| `motion` | `^12.38.0` | `12.42.2` | `12.42.2` | upgrade |
| `next` | `^16.2.4` | `16.2.10` | `16.2.10` | security upgrade |
| `next-auth` | `5.0.0-beta.31` | `5.0.0-beta.31` (beta) | unchanged | intentional channel pin |
| `pino` | `^10.3.1` | `10.3.1` | unchanged | current |
| `pino-pretty` | `^13.1.3` | `13.1.3` | unchanged | current |
| `pg` | added | `8.22.0` | `8.22.0` | required Prisma 7 PostgreSQL driver |
| `prisma` | `^6.0.0` | `7.8.0` | `7.8.0` | breaking upgrade |
| `react` | `^19.2.5` | `19.2.7` | `19.2.7` | upgrade |
| `react-dom` | `^19.2.5` | `19.2.7` | `19.2.7` | upgrade |
| `react-hotkeys-hook` | `^5.2.4` | `5.3.3` | `5.3.3` | upgrade |
| `react-resizable-panels` | `^4.10.0` | `4.12.2` | unchanged | deferred until 2026-07-20 |
| `react-router-dom` | `^7` | `7.18.1` | `7.18.1` | security upgrade |
| `resend` | `^6.16.0` | `6.17.2` | `6.17.2` | upgrade |
| `server-only` | `^0.0.1` | `0.0.1` | unchanged | current |
| `sonner` | `^2.0.7` | `2.0.7` | unchanged | current |
| `superjson` | `^2.2.6` | `2.2.6` | unchanged | current |
| `tailwind-merge` | `^3.5.0` | `3.6.0` | `3.6.0` | upgrade |
| `tailwindcss` | `^4.2.4` | `4.3.3` | unchanged | deferred until 2026-07-23 |
| `tsx` | `^4.21.0` | `4.23.1` | unchanged | deferred until 2026-07-20 |
| `turbo` | `^2.10.5` | `2.10.5` | unchanged | current; already locked before quarantine policy |
| `typescript` | `^7.0.2` | `7.0.2` | unchanged | current |
| `vite` | `^8.0.9` | `8.1.5` | `8.1.4` | mature security target; latest quarantined |
| `vitest` | `^4.1.5` | `4.1.10` | `4.1.10` | upgrade |
| `wait-on` | `^9.0.10` | `9.0.10` | unchanged | current |
| `wavesurfer.js` | `^7` | `7.12.10` | `7.12.10` | upgrade |
| `zod` | `^4.3.6` | `4.4.3` | `4.4.3` | upgrade |
| `zustand` | `^5.0.12` | `5.0.14` | `5.0.14` | upgrade |

## Breaking and deprecated API review

- Prisma 7 requires the new generator, explicit `prisma.config.ts`, ESM-aware
  configuration, and a PostgreSQL driver adapter. There are no repository
  `$use` middleware calls or removed CLI flags to replace. Generated imports
  now use the generator's `client` entry point. The global client stays lazy so
  Next can collect build metadata without a database, while the first runtime
  database access rejects a missing/blank `DATABASE_URL` before `pg` can apply
  ambient `PG*` defaults.
- MaxMind 7 is ESM-only and requires Node 22+. StoryCapture uses only local
  `Reader`/`ReaderModel` MMDB lookup; WebService error changes are irrelevant.
- The current import/call scan found no direct use of the deprecated Next,
  Zod, Vite, Electron, or Tauri symbols identified in the selected release
  declarations. Typecheck and migration-guide scans are repeated after install.
- CodeMirror was deduplicated to one `@codemirror/state` and
  `@codemirror/view` identity after the coherent upgrade. `react-hotkeys-hook`
  5.3's documented platform-sensitive `mod` behavior is covered by explicit
  macOS and Windows user-agent tests.
- Electron 43 is deferred. Its future review must cover
  `nativeImage.toBitmap()` color normalization, dialog `defaultPath`, and
  hidden/frameless window behavior.

## Authoritative sources

- npm packuments: `https://registry.npmjs.org/<package>`
- Prisma 7 guide: <https://www.prisma.io/docs/guides/upgrade-prisma-orm/v7>
- pnpm release age: <https://pnpm.io/settings#minimumreleaseage>
- Node release policy: <https://nodejs.org/en/about/previous-releases>
- GitHub Actions hardening: <https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions>
- npm provenance: <https://docs.npmjs.com/generating-provenance-statements/>
- Auth.js v5 migration: <https://authjs.dev/getting-started/migrating-to-v5>
- Electron breaking changes: <https://www.electronjs.org/docs/latest/breaking-changes>
- MaxMind v7 release: <https://github.com/maxmind/GeoIP2-node/releases/tag/v7.0.0>

## Final verification

### Registry and supply chain

- Final registry snapshot: 95 direct packages (the initial 91 plus four Prisma
  adapter requirements); no target changed during execution. Thirteen live
  latest releases were younger than seven days, including the already-locked
  Turbo exception and the latest releases intentionally bypassed by mature
  AWS/Vite security targets.
- `minimumReleaseAge: 10080` rejects newly published packages by default.
  GitHub Actions use full commit SHAs and the PostgreSQL CI service uses an
  immutable image digest.
- All 902 registry resolution blocks in `pnpm-lock.yaml` contain integrity
  hashes. `npm audit signatures --json` reports no invalid or missing
  signatures. Provenance remains non-universal; selected packages and the four
  newly introduced packages had no integrity, signature, lifecycle, or
  publisher anomaly requiring quarantine.
- OSV batch lookup reports zero matches across the 95 resolved direct targets.
  `pnpm audit --json` reports 0 critical, 0 high, 0 moderate, and 1 low. The
  remaining low advisory is dev-only `tsx@4.21.0 -> esbuild@0.27.7`
  (`GHSA-g7r4-m6w7-qqqr`); patched `tsx@4.23.1` is quarantined until
  2026-07-20, so the whole package remains deferred by policy.
- No `fast-xml-parser` or `fast-xml-builder` path remains. Security floors
  resolve Prisma's Hono path to `@hono/node-server@1.19.13`, Next's path to
  `postcss@8.5.10`, and affected Electron/jsdom paths to `undici@7.28.0`.

### Regression and integration

- Node `v24.18.0`, pnpm `11.9.0`; frozen install and root typecheck pass.
- Desktop Vitest: 166 files, 1,460 tests passed. Shared UI: 14 files, 33 tests
  passed. Web: 5 files, 10 tests passed.
- Root production build passes for both Electron/desktop and Next/web. Local
  macOS code signing was skipped because no signing identity is installed; the
  unsigned package is sufficient for the local smoke but not a release
  artifact.
- Electron cursor-sync smoke: 1 passed. Media playback smoke: 3 passed.
  Packaged export parity passed for MP4/WebM/GIF and the 720p/1080p/4K capture
  matrix; minimum all-effects SSIM was `0.9940936837`, software High was
  `0.9998425149`, and VideoToolbox High was `0.9998363759`.
- Disposable PostgreSQL 17 at the CI image digest passed schema bootstrap,
  Prisma adapter create/read/delete, unconditional disconnect, and seed. A
  post-smoke query confirmed zero leaked reserved-email users.
- Focused non-rewrite Biome checks pass for all newly authored and directly
  behavior-changed code. The repository-wide `pnpm lint` gate remains red on
  the pre-existing baseline (471 errors and 260 warnings, including Tailwind
  `@theme` parser configuration and unrelated format drift); Biome itself was
  intentionally deferred and unchanged at 2.4.12.

### Residual risk and follow-up

- The checked-in Prisma migration history starts after the original schema
  baseline, so `migrate deploy` cannot initialize an empty database safely.
  CI uses `db push` only for its disposable database. A separate production
  migration-baseline project is required before asserting empty-database
  `migrate deploy` support.
- Electron 43 remains quarantined. Its next review must cover bitmap color
  normalization, dialog paths, hidden/frameless windows, and capture/export
  pixel parity on both supported operating systems.
- Final PR run
  [29538771451](https://github.com/ducminhle1904/StoryCapture/actions/runs/29538771451)
  passed the required macOS build/test, PostgreSQL adapter smoke, Windows media
  and packaged export parity, and Vercel checks. The macOS media test passed
  after one retry and remains a non-blocking flake to monitor. Signing and
  production release credentials were not exercised by this CI run.
- GitHub warned that the quarantined, SHA-pinned `setup-node` v4 action runtime
  was forced from Node 20 to Node 24. The action passed; re-evaluate the newer
  action after it clears the seven-day quarantine.
- Re-run the dated registry/audit procedure on or after 2026-07-23, then apply
  the same seven-day rule to anything published after this snapshot rather than
  assuming the deferred targets are still latest.
