# Dependency Upgrade Plan

_Audited: 2026-04-21._
_Working copy: `/Users/locvotuan/git/StoryCapture` (branch `main`, clean)._

## Summary

- **Manifests audited:** 9 JS/TS (`package.json`), 11 Rust (`Cargo.toml`, incl. workspace root).
- **Unique deps looked up:** 83 npm + 90 crates = **173 packages**.
- **Bump counts** (level = max bump across all pin sites):
  - NONE (already latest within committed major): ~62
  - PATCH: ~18
  - MINOR: ~60
  - MAJOR: ~33
- **Headline risks:** Next 15→16, Prisma 6→7, `@prisma/client` 6→7, jose 5→6, TypeScript 5→6, Biome 1→2, Vite 6→8, Vitest/@vitest/ui 4 already current, @tailwindcss/vite 4 already current, `windows-capture 2.0.0` already used (CLAUDE.md still references 1.5.x), `tauri-specta` RC→1.0 stable bump.
- **Do NOT silently bump** (CLAUDE.md committed majors): Tauri 2.x family, React 19, Next 15, Tailwind v4, Zustand 5, TanStack Query 5, Motion 12, Prisma 6, NextAuth v5, tRPC 11, Biome (project ok w/ upgrade), `screencapturekit` (pinned), `chromiumoxide` (pre-1.0, though not currently in Cargo — see notes).

---

## Manifest-by-manifest

### 1. `/package.json` (root)

| package | current | latest | level | notes |
|---|---|---|---|---|
| turbo (dev) | ^2.5.0 | 2.9.6 | minor | safe |
| @biomejs/biome (dev) | ^1.9.4 | 2.4.12 | **major** | Biome v2 renames many rule ids; run `biome migrate`. CLAUDE.md "Biome recommended 2026" — v2 is fine but coordinated change. |
| typescript (dev) | ^5.7.2 | 6.0.3 | **major** | TS 6 released; review across repo (6 manifests pin ^5.7). |

### 2. `/apps/desktop/package.json`

| package | current | latest | level | notes |
|---|---|---|---|---|
| @base-ui-components/react | ^1.0.0-beta.6 | 1.0.0-rc.0 | minor (beta→rc) | Still pre-1.0 stable; review-gated |
| @codemirror/autocomplete | ^6 | 6.20.1 | none | caret covers |
| @codemirror/commands | ^6 | 6.10.3 | none | |
| @codemirror/language | ^6 | 6.12.3 | none | |
| @codemirror/lint | ^6 | 6.9.5 | none | |
| @codemirror/state | ^6 | 6.6.0 | none | |
| @codemirror/view | ^6 | 6.41.1 | none | |
| @dnd-kit/core | ^6 | 6.3.1 | none | |
| @fontsource-variable/inter | ^5.2.0 | 5.2.8 | patch | |
| @fontsource-variable/jetbrains-mono | ^5.1.0 | 5.2.8 | minor | |
| @lezer/highlight | ^1 | 1.2.3 | none | |
| @tanstack/react-query | ^5.62.0 | 5.99.2 | minor | |
| @tanstack/react-query-devtools | ^5.62.0 | 5.99.2 | minor | keep lockstep w/ react-query |
| @tanstack/react-virtual | ^3 | 3.13.24 | none | |
| @tauri-apps/api | ^2.0.0 | 2.10.1 | minor | **coordinate w/ Rust tauri 2.x** |
| @tauri-apps/plugin-dialog | ^2.0.0 | 2.7.0 | minor | coord |
| @tauri-apps/plugin-fs | ^2.0.0 | 2.5.0 | minor | coord |
| @tauri-apps/plugin-log | ^2.0.0 | 2.8.0 | minor | coord |
| @tauri-apps/plugin-os | ^2.0.0 | 2.3.2 | minor | coord |
| @tauri-apps/plugin-process | ^2.0.0 | 2.3.1 | minor | coord |
| @tauri-apps/plugin-shell | ^2.0.0 | 2.3.5 | minor | coord |
| @tauri-apps/plugin-store | ^2.4.0 | 2.4.2 | patch | coord |
| @tauri-apps/plugin-updater | ^2.0.0 | 2.10.1 | minor | coord |
| @tauri-apps/plugin-window-state | ^2.0.0 | 2.4.1 | minor | coord |
| @uiw/react-codemirror | ^4.25 | 4.25.9 | none | |
| class-variance-authority | ^0.7.1 | 0.7.1 | none | |
| clsx | ^2.1.1 | 2.1.1 | none | |
| cmdk | ^1.0.0 | 1.1.1 | minor | |
| lucide-react | ^0.460.0 | 1.8.0 | **major** | v1 GA; verify icon API |
| motion | ^12.0.0 | 12.38.0 | minor | Motion 12 is committed major |
| react | ^19.0.0 | 19.2.5 | minor | |
| react-dom | ^19.0.0 | 19.2.5 | minor | |
| react-hotkeys-hook | ^4 | 5.2.4 | **major** | API changes in v5 |
| react-resizable-panels | ^2 | 4.10.0 | **major** | v3+v4 had breaking changes |
| react-router-dom | ^7 | 7.14.2 | none | CLAUDE.md committed |
| sonner | ^1.7.0 | 2.0.7 | **major** | |
| tailwind-merge | ^2.5.0 | 3.5.0 | **major** | v3 targets Tailwind v4 — actually pairs well |
| wavesurfer.js | ^7 | 7.12.6 | none | |
| zustand | ^5.0.0 | 5.0.12 | minor | |
| @tailwindcss/vite (dev) | ^4.0.0 | 4.2.4 | minor | |
| @tauri-apps/cli (dev) | ^2.0.0 | 2.10.1 | minor | coord |
| @testing-library/jest-dom (dev) | ^6.9.1 | 6.9.1 | none | |
| @testing-library/react (dev) | ^16.3.2 | 16.3.2 | none | |
| @testing-library/user-event (dev) | ^14.6.1 | 14.6.1 | none | |
| @types/node (dev) | ^22.10.0 | 25.6.0 | **major** | align w/ Node 22 LTS? Latest 25 tracks Node 25; stay on ^22 unless bumping Node |
| @types/react (dev) | ^19.0.0 | 19.2.14 | minor | |
| @types/react-dom (dev) | ^19.0.0 | 19.2.3 | minor | |
| @vitejs/plugin-react (dev) | ^4.3.4 | 6.0.1 | **major** | v6 targets Vite 7+; coord w/ vite bump |
| @vitest/ui (dev) | ^4.1.4 | 4.1.5 | patch | |
| @webgpu/types (dev) | ^0.1.69 | 0.1.69 | none | |
| happy-dom (dev) | ^20.9.0 | 20.9.0 | none | |
| tailwindcss (dev) | ^4.0.0 | 4.2.4 | minor | |
| typescript (dev) | ^5.7.2 | 6.0.3 | **major** | |
| vite (dev) | ^6.0.0 | 8.0.9 | **major** | Vite 7, 8 published — CLAUDE.md says "Vite 6+"; skipping 7 to 8 needs review |
| vitest (dev) | ^4.1.4 | 4.1.5 | patch | |

### 3. `/apps/web/package.json`

| package | current | latest | level | notes |
|---|---|---|---|---|
| next | ^15.3.0 | 16.2.4 | **major** | Next 16 out; CLAUDE.md commits Next 15 — gated on user approval |
| react | ^19.0.0 | 19.2.5 | minor | |
| react-dom | ^19.0.0 | 19.2.5 | minor | |
| @trpc/server | ^11.16.0 | 11.16.0 | none | |
| @trpc/client | ^11.16.0 | 11.16.0 | none | |
| @trpc/tanstack-react-query | ^11.16.0 | 11.16.0 | none | |
| @tanstack/react-query | ^5.0.0 | 5.99.2 | minor | must match desktop |
| @prisma/client | ^6.0.0 | 7.7.0 | **major** | CLAUDE.md commits Prisma 6 — user approval |
| next-auth | 5.0.0-beta.31 | 4.24.14 (stable) / 5.x beta ongoing | review | npm "latest" tag = v4 stable; v5 still beta. Check `npm view next-auth@beta version` for latest beta |
| @auth/prisma-adapter | ^2.11.0 | 2.11.2 | patch | match next-auth v5 |
| zod | ^3.23.0 | 4.3.6 | **major** | Zod 4 GA; breaking |
| superjson | ^2.2.0 | 2.2.6 | patch | |
| jose | ^5.0.0 | 6.2.2 | **major** | ESM-only changes in v6 |
| @aws-sdk/client-s3 | ^3.0.0 | 3.1033.0 | minor | |
| @aws-sdk/s3-request-presigner | ^3.0.0 | 3.1033.0 | minor | keep lockstep w/ client-s3 |
| @maxmind/geoip2-node | ^6.0.0 | 6.3.4 | minor | |
| pino | ^9.0.0 | 10.3.1 | **major** | CLAUDE.md listed 9.x |
| tailwindcss | ^4.0.0 | 4.2.4 | minor | |
| resend | ^4.0.0 | 6.12.2 | **major** | v5 + v6 breaking |
| client-only | ^0.0.1 | 0.0.1 | none | |
| server-only | ^0.0.1 | 0.0.1 | none | |
| prisma (dev) | ^6.0.0 | 7.7.0 | **major** | lockstep w/ @prisma/client |
| pino-pretty (dev) | ^11.0.0 | 13.1.3 | **major** | |
| @tailwindcss/postcss (dev) | ^4.0.0 | 4.2.4 | minor | |
| @types/node (dev) | ^22.0.0 | 25.6.0 | **major** | see root comment |
| @types/react (dev) | ^19.0.0 | 19.2.14 | minor | |
| @types/react-dom (dev) | ^19.0.0 | 19.2.3 | minor | |
| typescript (dev) | ^5.7.0 | 6.0.3 | **major** | |
| tsx (dev) | ^4.0.0 | 4.21.0 | minor | |

### 4. `/packages/config/package.json`
No runtime deps. No changes.

### 5. `/packages/shared-types/package.json`

| package | current | latest | level | notes |
|---|---|---|---|---|
| @tauri-apps/api | ^2.0.0 | 2.10.1 | minor | coord (Tauri group) |

### 6. `/packages/story-dsl/package.json`

| package | current | latest | level | notes |
|---|---|---|---|---|
| @codemirror/autocomplete | ^6 | 6.20.1 | none | |
| @codemirror/language | ^6 | 6.12.3 | none | |
| @codemirror/state | ^6 | 6.6.0 | none | |
| @codemirror/view | ^6 | 6.41.1 | none | |
| @lezer/highlight | ^1 | 1.2.3 | none | |
| typescript (dev) | ^5.7.2 | 6.0.3 | **major** | |

### 7. `/packages/ui/package.json`

| package | current | latest | level | notes |
|---|---|---|---|---|
| @base-ui-components/react | ^1.0.0-beta.6 | 1.0.0-rc.0 | minor(beta) | lockstep w/ desktop |
| clsx | ^2.1.1 | 2.1.1 | none | |
| tailwind-merge | ^2.5.0 | 3.5.0 | **major** | lockstep w/ desktop |
| react (peer+dev) | ^19.0.0 | 19.2.5 | minor | |
| react-dom (peer+dev) | ^19.0.0 | 19.2.5 | minor | |
| @testing-library/react (dev) | ^16.3.2 | 16.3.2 | none | |
| @testing-library/jest-dom (dev) | ^6.9.1 | 6.9.1 | none | |
| @types/react (dev) | ^19.0.0 | 19.2.14 | minor | |
| @types/react-dom (dev) | ^19.0.0 | 19.2.3 | minor | |
| @vitejs/plugin-react (dev) | ^4.3.4 | 6.0.1 | **major** | lockstep |
| happy-dom (dev) | ^20.9.0 | 20.9.0 | none | |
| typescript (dev) | ^5.7.2 | 6.0.3 | **major** | |
| vitest (dev) | ^4.1.4 | 4.1.5 | patch | |

### 8. `/scripts/playwright-sidecar/package.json`

| package | current | latest | level | notes |
|---|---|---|---|---|
| playwright-core | ^1.48.0 | 1.59.1 | minor | Node-sidecar; bump to stay current with Chromium |
| @medv/finder (dev) | 4.0.2 | 4.0.2 | none | pinned |
| esbuild (dev) | ^0.28.0 | 0.28.0 | none | |
| jsdom (dev) | ^29.0.2 | 29.0.2 | none | |
| postject (dev) | ^1.0.0-alpha.6 | 1.0.0-alpha.6 | none | |
| vitest (dev) | ^2.1.0 | 4.1.5 | **major** | sidecar on Vitest 2; desktop on 4 — unify |

### 9. `/scripts/notarize/smoke-app/package.json`

| package | current | latest | level | notes |
|---|---|---|---|---|
| @tauri-apps/cli (dev) | ^2.0.0 | 2.10.1 | minor | coord |

---

### Rust — `/Cargo.toml` (workspace root)

| crate | current | latest | level | notes |
|---|---|---|---|---|
| tokio | 1.40 | 1.52.1 | minor | keep ≥1.40 (CLAUDE.md hard req) |
| serde | 1 | 1.0.228 | none | |
| serde_json | 1 | 1.0.149 | none | |
| thiserror | 2 | 2.0.18 | none | |
| anyhow | 1 | 1.0.102 | none | |
| tracing | 0.1 | 0.1.44 | none | |
| tracing-subscriber | 0.3 | 0.3.23 | none | |
| uuid | 1 | 1.23.1 | none | |
| parking_lot | 0.12 | 0.12.5 | none | |
| objc2 | 0.5 | 0.6.4 | **major** | encoder already pins 0.6; capture still 0.5 — unify |
| windows | 0.58 | 0.62.2 | **major** | capture pins 0.58 intentionally (WGC); major bump needs review |

### Rust — `/apps/desktop/src-tauri/Cargo.toml`

| crate | current | latest | level | notes |
|---|---|---|---|---|
| tauri-build | 2 | 2.5.6 | minor | |
| tauri | 2 | 2.10.3 | minor | Tauri group |
| tauri-plugin-log | 2 | 2.8.0 | minor | Tauri group |
| tauri-plugin-fs | 2 | 2.5.0 | minor | |
| tauri-plugin-dialog | 2 | 2.7.0 | minor | |
| tauri-plugin-updater | 2 | 2.10.1 | minor | |
| tauri-plugin-window-state | 2 | 2.4.1 | minor | |
| tauri-plugin-shell | 2 | 2.3.5 | minor | |
| tauri-plugin-opener | 2 | 2.5.3 | minor | |
| tauri-plugin-process | 2 | 2.3.1 | minor | |
| tauri-plugin-single-instance | 2 | 2.4.1 | minor | |
| tauri-plugin-store | 2.4 | 2.4.2 | patch | |
| tauri-plugin-os | 2 | 2.3.2 | minor | |
| tauri-specta | =2.0.0-rc.21 | 1.0.2 | review | crates.io `tauri-specta` max-stable is 1.0.2; 2.x is RC. Keep pinned to RC until Tauri 2.x compatible stable lands. **Leave as-is pending research.** |
| specta | =2.0.0-rc.22 | 1.0.5 | review | same as above — 2.x is RC track |
| specta-typescript | 0.0.9 | 0.0.11 | patch | |
| tracing-appender | 0.2 | 0.2.5 | none | |
| tracing-log | 0.2 | 0.2.0 | none | |
| log | 0.4 | 0.4.29 | none | |
| keyring | 3 | 3.6.3 | none | |
| once_cell | 1 | 1.21.4 | none | |
| async-trait | 0.1 | 0.1.89 | none | |
| rusqlite | 0.34 | 0.39.0 | **major** (0.x) | breaking per-release; coord w/ storage/effects/encoder (all pin 0.34) |
| time | 0.3 | 0.3.47 | none | |
| reqwest | 0.12 | 0.13.2 | **major** (0.x) | intelligence also pins 0.12 — coord |
| url | 2 | 2.5.8 | none | |
| base64 | 0.22 | 0.22.1 | none | |
| sha2 | 0.10 | 0.11.0 | minor (0.x) | breaking w/in 0.x lineage — review; util + intelligence also pin 0.10 |
| hex | 0.4 | 0.4.3 | none | |
| objc2 (macos) | 0.5 | 0.6.4 | **major** | see workspace note |
| objc2-app-kit | 0.2 | 0.3.2 | **major** | lockstep w/ objc2 0.6 |
| objc2-foundation | 0.2 | 0.3.2 | **major** | lockstep |

### Rust — `/crates/automation/Cargo.toml`

| crate | current | latest | level | notes |
|---|---|---|---|---|
| async-trait | 0.1 | 0.1.89 | none | |
| url | 2 | 2.5.8 | none | |
| scraper | 0.20 | 0.26.0 | **major** (0.x) | review html5ever ABI |
| tempfile | 3 | 3.27.0 | none | |

### Rust — `/crates/capture/Cargo.toml`

| crate | current | latest | level | notes |
|---|---|---|---|---|
| async-trait | 0.1 | 0.1.89 | none | |
| xcap | 0.9 | 0.9.4 | none | |
| image | 0.25 | 0.25.10 | none | |
| cpal | =0.17.3 | 0.17.3 | none | pinned |
| ringbuf | =0.4.8 | 0.4.8 | none | pinned |
| rubato | 0.16 | 2.0.0 | **major** | unused per comment; safe to bump or remove |
| bytemuck | 1 | 1.25.0 | none | |
| tempfile | 3 | 3.27.0 | none | |
| nix (unix) | 0.29 | 0.31.2 | minor (0.x) | breaking in 0.30/0.31 |
| sysinfo (opt) | 0.32 | 0.38.4 | **major** (0.x) | feature-gated behind real-capture |
| screencapturekit | =1.5.4 | 1.5.4 | none | **DO NOT BUMP** — pinned per CLAUDE.md risk flag |
| objc2 | 0.5 | 0.6.4 | **major** | coord w/ encoder/workspace |
| objc2-foundation | 0.2 | 0.3.2 | **major** | coord |
| core-foundation | 0.10 | 0.10.1 | none | |
| core-graphics | 0.24 | 0.25.0 | minor (0.x) | |
| windows-capture | =2.0.0 | 2.0.0 | none | CLAUDE.md ref to 1.5.x is stale (already on 2.0) |
| windows | 0.58 | 0.62.2 | **major** | see workspace note; capture comment says 0.58 is deliberate vs transitive 0.62 |
| which (dev) | 7 | 8.0.2 | **major** | |
| criterion (dev) | 0.5 | 0.8.2 | **major** | |
| anyhow (dev) | 1 | 1.0.102 | none | |

### Rust — `/crates/effects/Cargo.toml`

| crate | current | latest | level | notes |
|---|---|---|---|---|
| indexmap | 2.5 | 2.14.0 | minor | |
| ts-rs (opt) | 10 | 12.0.1 | **major** | API breaking across 11/12 |
| rusqlite (opt) | 0.34 | 0.39.0 | **major** (0.x) | group bump |
| image | 0.25 | 0.25.10 | none | |
| rayon | 1 | 1.12.0 | none | |
| insta (dev) | 1.40 | 1.47.2 | none | |
| tempfile (dev) | 3 | 3.27.0 | none | |

### Rust — `/crates/encoder/Cargo.toml`

| crate | current | latest | level | notes |
|---|---|---|---|---|
| async-trait | 0.1 | 0.1.89 | none | |
| tokio-util | 0.7 | 0.7.18 | none | |
| bytes | 1 | 1.11.1 | none | |
| rusqlite | 0.34 | 0.39.0 | **major** (0.x) | group |
| futures | 0.3 | 0.3.32 | none | |
| tempfile | 3 | 3.27.0 | none | |
| libc (unix) | 0.2 | 0.2.185 | none | |
| objc2 (macos) | 0.6 | 0.6.4 | none | already on 0.6 — encoder is the reason to unify |
| objc2-foundation | 0.3 | 0.3.2 | none | |
| objc2-av-foundation | 0.3 | 0.3.2 | none | |
| objc2-core-media | 0.3 | 0.3.2 | none | |
| objc2-core-video | 0.3 | 0.3.2 | none | |
| insta (dev) | 1 | 1.47.2 | none | |
| image (dev) | 0.25 | 0.25.10 | none | |

### Rust — `/crates/intelligence/Cargo.toml`

| crate | current | latest | level | notes |
|---|---|---|---|---|
| reqwest | 0.12 | 0.13.2 | **major** (0.x) | group w/ src-tauri reqwest |
| eventsource-stream | 0.2 | 0.2.3 | none | |
| bytes | 1 | 1.11.1 | none | |
| tokio | 1.40 | 1.52.1 | minor | |
| tokio-stream | 0.1 | 0.1.18 | none | |
| futures-util | 0.3 | 0.3.32 | none | |
| async-trait | 0.1 | 0.1.89 | none | |
| serde | 1 | 1.0.228 | none | |
| serde_json | 1 | 1.0.149 | none | |
| schemars | 0.8 | 1.2.1 | **major** | 1.0 GA; API changes (derive macro + `JsonSchema`) |
| tower-lsp | 0.20 | 0.20.0 | none | |
| tower | 0.4 | 0.5.3 | minor (0.x) | breaking in 0.5 |
| dashmap | 6 | 6.1.0 | none | |
| ropey | 1.6 | 1.6.1 | none | |
| thiserror | 2 | 2.0.18 | none | |
| anyhow | 1 | 1.0.102 | none | |
| tracing | 0.1 | 0.1.44 | none | |
| tracing-subscriber | 0.3 | 0.3.23 | none | |
| regex | 1 | 1.12.3 | none | |
| uuid | 1 | 1.23.1 | none | |
| sha2 | 0.10 | 0.11.0 | minor (0.x) | breaking |
| hex | 0.4 | 0.4.3 | none | |
| symphonia | 0.5 | 0.5.5 | none | |
| rand | 0.8 | 0.10.1 | **major** | 0.9/0.10 reshuffled APIs |
| httpdate | 1 | 1.0.3 | none | |
| toml | 0.8 | 1.1.2 | **major** | toml 1.0 GA |
| insta (dev) | 1 | 1.47.2 | none | |
| tempfile (dev) | 3 | 3.27.0 | none | |
| wiremock (dev) | 0.6 | 0.6.5 | none | |
| serde_yaml (dev) | 0.9 | 0.9.34+deprecated | review | **deprecated upstream** — pick `serde_yml` or `serde_yaml_ng` |

### Rust — `/crates/storage/Cargo.toml`

| crate | current | latest | level | notes |
|---|---|---|---|---|
| rusqlite | 0.34 | 0.39.0 | **major** (0.x) | group |
| rusqlite_migration | 2 | 2.5.0 | none | |
| time | 0.3 | 0.3.47 | none | |
| slug | 0.1 | 0.1.6 | none | |

### Rust — `/crates/story-parser/Cargo.toml`

| crate | current | latest | level | notes |
|---|---|---|---|---|
| pest | 2.7 | 2.8.6 | minor | |
| pest_derive | 2.7 | 2.8.6 | minor | lockstep |
| strsim | 0.11 | 0.11.1 | none | |
| uuid | 1 | 1.23.1 | none | |
| specta (opt) | 2.0.0-rc.22 | 1.0.5 stable / 2.x RC | review | lockstep w/ src-tauri |
| ts-rs (opt) | 10 | 12.0.1 | **major** | group w/ effects |
| insta (dev) | 1.40 | 1.47.2 | none | |
| proptest (dev) | 1.5 | 1.11.0 | minor | |

### Rust — `/crates/util/Cargo.toml`

| crate | current | latest | level | notes |
|---|---|---|---|---|
| sha2 | 0.10 | 0.11.0 | minor (0.x, breaking) | group |
| hex | 0.4 | 0.4.3 | none | |

### Rust — `/tools/e2e-playwright-capture/Cargo.toml`
Only workspace path deps + workspace deps — nothing to bump here directly.

### Rust — `/scripts/notarize/smoke-app/src-tauri/Cargo.toml`

| crate | current | latest | level | notes |
|---|---|---|---|---|
| tauri-build | 2 | 2.5.6 | minor | coord w/ desktop Tauri group |
| tauri | 2 | 2.10.3 | minor | coord |
| serde | 1 | 1.0.228 | none | |
| serde_json | 1 | 1.0.149 | none | |

---

## Coordinated bumps (must move together)

1. **Tauri group (JS + Rust)** — bump all `tauri*` Rust crates (host + smoke-app) and all `@tauri-apps/*` JS packages to their latest 2.x minor in one commit. Keeps major 2.x aligned per CLAUDE.md.
2. **TanStack Query** — `@tanstack/react-query` + `@tanstack/react-query-devtools` across `apps/desktop` and `apps/web` must share the same version.
3. **tRPC** — `@trpc/server` + `@trpc/client` + `@trpc/tanstack-react-query` lockstep (currently all 11.16.0; no bump needed).
4. **Prisma** — `prisma` (CLI, dev) + `@prisma/client` (runtime) must match exactly. Any 6→7 bump is a coordinated major (gated).
5. **AWS SDK** — `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` share a release train; bump together.
6. **objc2 family** — `objc2`, `objc2-foundation`, `objc2-app-kit`, `objc2-av-foundation`, `objc2-core-media`, `objc2-core-video` must share majors. Encoder already on 0.6; bump workspace + desktop-host + capture to 0.6 in one commit.
7. **rusqlite group** — `src-tauri`, `storage`, `effects`, `encoder` all pin `rusqlite = 0.34`. Any bump (0.34 → 0.35/…/0.39) must be a single commit, plus touching any `rusqlite_migration` compatibility.
8. **pest group** — `pest` and `pest_derive` lockstep.
9. **reqwest** — `src-tauri` + `intelligence` both pin 0.12; 0.13 bump is coordinated.
10. **ts-rs** — `effects` and `story-parser` lockstep (both opt).
11. **tauri-specta / specta** — `tauri-specta`, `specta`, `specta-typescript`, and the optional `specta` feature in `story-parser` all move together.
12. **React** — `react`, `react-dom`, `@types/react`, `@types/react-dom` lockstep across `apps/desktop`, `apps/web`, `packages/ui`.
13. **Vite toolchain** — `vite`, `@vitejs/plugin-react`, `@tailwindcss/vite`, `tailwindcss`, `@tailwindcss/postcss`, `@vitest/ui`, `vitest` bump together (Vite 8 → plugin-react 6; Vitest stays 4 cross-repo; unify sidecar Vitest 2 → 4).
14. **TypeScript** — a single repo-wide TS major bump (5→6) across 6 manifests.
15. **Biome** — single root devDep; v2 migration touches `biome.json` formatting and lint rules repo-wide.

---

## Risky / needs review

- **`tauri-specta =2.0.0-rc.21` / `specta =2.0.0-rc.22`** — intentionally pinned to RC. crates.io's `max_stable_version` for both is the older 1.x line. Do **not** downgrade to 1.x; investigate current 2.x-rc latest and bump only after the typespec codegen round-trip passes (IPC contract).
- **`screencapturekit =1.5.4`** — CLAUDE.md calls this out as deliberately pinned (MEDIUM risk). Leave untouched.
- **`windows-capture =2.0.0`** — CLAUDE.md still references 1.5.x but code is already on 2.0; doc drift. No version change needed; update `CLAUDE.md`/`docs/ARCHITECTURE.md` to reflect 2.x.
- **`windows` 0.58 vs 0.62** — capture intentionally pins 0.58 against a transitive 0.62 from `windows-capture`. Bumping our direct dep to 0.62 collapses the duplication but is a WGC-surface breaking change. Review required.
- **`objc2` 0.5 → 0.6** — encoder already on 0.6; workspace + desktop-host + capture still on 0.5. Unifying removes multi-version graph but touches every Obj-C FFI site in capture's SCK backend.
- **`rusqlite` 0.34 → 0.39** — 5 minor jumps; each has breaking API changes. `rusqlite_migration` 2.x supports 0.34+; verify compat.
- **`reqwest` 0.12 → 0.13** — HTTP client feature-flag surface changed; used for Anthropic/OpenAI streams in `intelligence` (SSE). Test provider probe + streaming.
- **`sha2` 0.10 → 0.11** — 0.x breaking; used in util + intelligence + src-tauri (author snapshot hashing). Digest API change.
- **`rand` 0.8 → 0.10** — massive API shuffle (rng traits, `thread_rng` gone, etc.).
- **`scraper` 0.20 → 0.26** — html5ever bump; selectors API stable but tests should re-run.
- **`toml` 0.8 → 1.0+** — intelligence `eval_report` binary uses it; v1 changes error types.
- **`schemars` 0.8 → 1.x** — breaking derive macro changes in intelligence.
- **`serde_yaml` (dev) is deprecated upstream.** Replace w/ `serde_yml` or `serde_yaml_ng` (straight swap).
- **`next` 15 → 16**, **`@prisma/client` 6 → 7**, **`prisma` 6 → 7**, **`jose` 5 → 6**, **`zod` 3 → 4**, **`tailwind-merge` 2 → 3**, **`sonner` 1 → 2**, **`lucide-react` 0.x → 1**, **`react-hotkeys-hook` 4 → 5**, **`react-resizable-panels` 2 → 4**, **`resend` 4 → 6**, **`pino` 9 → 10**, **`pino-pretty` 11 → 13**, **`vite` 6 → 8**, **`@vitejs/plugin-react` 4 → 6**, **`typescript` 5 → 6**, **Biome 1 → 2** — all committed-major changes that CLAUDE.md suggests keeping. Each needs explicit user approval.
- **`next-auth`** — v5 still in beta ("unusually long" per CLAUDE.md). npm `latest` tag points at v4 stable. Resolve current v5 beta via `npm view next-auth dist-tags` before bumping from `5.0.0-beta.31`.
- **`@base-ui-components/react` beta.6 → rc.0** — API could still shift before 1.0.0 stable.
- **`@types/node` 22 → 25** — tied to Node runtime choice. Root `engines.node = ">=20"`; keep `@types/node` on 22.x unless raising Node floor.
- **`chromiumoxide`** — listed in CLAUDE.md as primary browser driver, but no `chromiumoxide` dep in any current `Cargo.toml`. Either a planned-future dep or deprecated; confirm with user whether to track.

---

## Suggested execution order

Each step should be a single atomic commit (or a small group of commits per CLAUDE.md "type(scope): subject" convention).

**Phase A — Safe patch/minor-only (no API surface risk)**

1. Bump all workspace Rust patch/minor-only crates: `tokio`, `serde*`, `thiserror`, `anyhow`, `tracing*`, `uuid`, `parking_lot`, `url`, `tempfile`, `base64`, `hex`, `async-trait`, `once_cell`, `log`, `bytes`, `tokio-util`, `futures*`, `image`, `rayon`, `indexmap`, `regex`, `time`, `proptest`, `pest` + `pest_derive`, `dashmap`, `ropey`, `keyring`, `symphonia`, `eventsource-stream`, `tokio-stream`, `slug`, `rusqlite_migration`, `strsim`, `wiremock`, `insta`, `httpdate`. Run `cargo nextest` across workspace.
2. Bump safe npm patch/minor packages in one commit per workspace: desktop (TanStack Query, Tauri plugins, motion, zustand, react patch, @types/react*, tailwindcss, @tailwindcss/vite, cmdk, sonner deferred, etc.), web (AWS SDK, geoip2-node, superjson, @auth/prisma-adapter, tsx, @tailwindcss/postcss, tailwindcss), ui, shared-types, playwright-sidecar `playwright-core`, smoke-app `@tauri-apps/cli`.

**Phase B — Coordinated non-breaking bumps**

3. Tauri group: Rust `tauri*` 2.x → 2.10.x + JS `@tauri-apps/*` → 2.x latest + `@tauri-apps/cli`. Touch desktop host + smoke-notarize + desktop frontend + shared-types.
4. Playwright sidecar: bump vitest 2 → 4 to unify with repo-wide Vitest 4.

**Phase C — Coordinated 0.x breaking bumps (review, single commit per group)**

5. `objc2` family 0.5 → 0.6 (workspace + desktop host + capture) — aligns with encoder. Cargo test both platforms.
6. `rusqlite` 0.34 → 0.39 across src-tauri, storage, effects, encoder. Regenerate migrations, run storage integration tests.
7. `reqwest` 0.12 → 0.13 in src-tauri + intelligence. Re-exercise provider probes + streaming tests.
8. `sha2` 0.10 → 0.11 in util + intelligence + src-tauri (author snapshot).
9. `scraper` 0.20 → 0.26 in automation; run author-time DOM validator tests.
10. `nix` 0.29 → 0.31 (capture unix audio fifo) — verify mkfifo path.
11. `tower` 0.4 → 0.5, `schemars` 0.8 → 1.x, `rand` 0.8 → 0.10, `toml` 0.8 → 1.x, `ts-rs` 10 → 12 in intelligence/effects/story-parser — each its own commit.
12. Replace deprecated `serde_yaml` with `serde_yml` (or `_ng`) in intelligence dev-deps.

**Phase D — JS major bumps (each needs explicit user go-ahead)**

13. `tailwind-merge` 2 → 3 (pairs cleanly w/ Tailwind v4; desktop + ui).
14. `sonner` 1 → 2, `cmdk` patch, `react-resizable-panels` 2 → 4, `react-hotkeys-hook` 4 → 5, `lucide-react` 0.460 → 1.x — per-package commits, rerun component tests.
15. `zod` 3 → 4 (web) — coordinate with tRPC input validators.
16. `jose` 5 → 6 (web) — token verification; re-test desktop↔web auth flow.
17. `pino` 9 → 10 + `pino-pretty` 11 → 13 (web).
18. `resend` 4 → 6 (web).
19. `vite` 6 → 8 + `@vitejs/plugin-react` 4 → 6 + re-verify Tailwind v4 plugin compatibility (desktop + ui).
20. `typescript` 5 → 6 (root + 5 workspaces). Run `turbo run typecheck` repo-wide.
21. Biome 1 → 2. Run `biome migrate`, commit `biome.json` changes.

**Phase E — Gated framework majors (explicit user decision)**

22. `next-auth`: confirm v5 beta latest via `dist-tags`; bump if desired.
23. `@types/node` 22 → 25 only if Node runtime floor is raised.
24. **Next 15 → 16** (web) — review App Router breaking changes + RSC cache; coord with `@prisma/client` stays on 6.
25. **Prisma 6 → 7** (web) — client + CLI + adapter. Regenerate migrations / client output.
26. **`windows` 0.58 → 0.62** (capture + workspace) — collapse version duplication; retest WGC backend.
27. **`tauri-specta` / `specta` RC bump** — move to current 2.x-rc; regenerate `packages/shared-types/src/ipc.ts`.
28. **CLAUDE.md + docs sync** — update stale references (`screencapturekit` 1.70 → pinned 1.5.4, `windows-capture` 1.5 → 2.0, objc2 0.5 → 0.6).

Keep each commit runnable: `cargo check && cargo nextest && turbo run typecheck && turbo run build` must pass before committing.
