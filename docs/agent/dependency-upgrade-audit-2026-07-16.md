# Dependency Upgrade Audit — 2026-07-16

Snapshot captured from the npm registry at `2026-07-16T13:25:09Z`. This is a
dated execution record, not a permanent version inventory. Re-query the
registry before a later dependency change.

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
  `$use` middleware calls to replace.
- MaxMind 7 is ESM-only and requires Node 22+. StoryCapture uses only local
  `Reader`/`ReaderModel` MMDB lookup; WebService error changes are irrelevant.
- The current import/call scan found no direct use of the deprecated Next,
  Zod, Vite, Electron, or Tauri symbols identified in the selected release
  declarations. Typecheck and migration-guide scans are repeated after install.
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

To be completed after the integrated lockfile and test gates are available.
