# StoryCapture - Architecture Map

Read-on-demand reference for structure, IPC, routes, package boundaries, CI, and
release topology. This file describes the current source tree, not the older
Tauri/Rust planning artifacts.

## Repo Layout

```text
apps/
  desktop/              Electron + React 19 + Vite 8 desktop app
    electron/           Electron main/preload process and host IPC handlers
      ipc.ts            registers the tauri-invoke bridge
      ipc/handlers.ts   grouped handler registry
      ipc/*.ts          grouped command registries, many delegating to legacy
      ipc/legacy/*.ts   remaining legacy host implementation split by domain
      ipc/plugin/*.ts   Tauri-compatible plugin shims
      ipc/legacy.ts     legacy dispatcher compatibility entrypoint
    icons/              desktop app icons used by electron-builder
    scripts/            desktop build helpers
    src/                renderer UI, feature modules, stores, IPC facades
  web/                  Next.js 16 web companion

packages/
  config/               shared TypeScript config package
  glob-compat/           CommonJS shim for legacy glob callback consumers
  lodash-isequal-compat/ CommonJS equality shim for Electron updater consumers
  rimraf-compat/         CommonJS shim for legacy rimraf callback consumers
  shared-types/         browser presets, IPC surface, checked-in generated files
  story-dsl/            Story AST/vocabulary and CodeMirror language support
  ui/                   shared tokens and claude-design primitives

assets/                 sound library, fonts, image/assets/preset defaults
scripts/                local CI, release, signing, benchmark helpers
docs/                   current read-on-demand technical docs
.github/actions/        local composite setup action
.github/workflows/      current CI
```

Workspace globs are only `apps/*` and `packages/*`. Exact package-manager and
Node requirements live in root `package.json` (`packageManager`, `engines`) and
`.github/actions/setup-toolchain/action.yml`; do not duplicate the pins here.
Transitive dependency overrides in `pnpm-workspace.yaml` route selected legacy
Electron packaging consumers through the local compatibility packages.

## Workspace Scripts

Root `package.json` scripts:

- `pnpm dev` -> Turbo dev tasks.
- `pnpm build` -> Turbo build tasks.
- `pnpm lint` -> `biome check .`.
- `pnpm format` -> `biome format --write .`.
- `pnpm typecheck` -> Turbo typecheck.

There is no root `pnpm test` and Turbo has no `test` task. Use package-level
Vitest commands from `docs/CONVENTIONS.md`.

Desktop scripts in `apps/desktop/package.json`:

- `pnpm --dir apps/desktop dev` starts Electron with a Vite renderer.
- `pnpm --dir apps/desktop electron:build-main` builds Electron main/preload.
- `pnpm --dir apps/desktop renderer:build` runs `tsc -b && vite build`.
- `pnpm --dir apps/desktop build` packages Electron via `electron-builder`.

Web scripts in `apps/web/package.json`:

- `dev`, `build`, `start`, `typecheck`, `test`.
- Prisma helpers: `db:migrate`, `db:push`, `db:generate`, `db:seed`.

## Desktop Runtime

Electron is the runtime host. `apps/desktop/electron/main.ts` creates the
`BrowserWindow`, loads `preload.cjs`, uses Vite in dev, loads `dist/index.html`
in production, and registers IPC.

Desktop build entrypoints:

- `apps/desktop/scripts/build-electron.mjs` esbuilds `electron/main.ts` to
  `dist-electron/main.mjs` and `electron/preload.ts` to
  `dist-electron/preload.cjs`.
- `apps/desktop/scripts/start-dev-electron.mjs` launches Electron after the
  Vite dev server is available.
- `.electron-dev/` is the prepared development app directory.
- There is no `electron-builder.yml`; Electron Builder configuration is inline
  under `apps/desktop/package.json#build`.

The renderer still imports `@tauri-apps/api` and selected Tauri plugin packages
as a compatibility API surface. Usage is not limited to `src/ipc`; imports also
exist in settings, dashboard dialogs, NL mode, recorder preview, post-production
export/progress, voiceover, editor preview/picker, stores, LSP transport,
logging, and output preferences.

`apps/desktop/electron/preload.ts` exposes the compatibility globals
`__TAURI_INTERNALS__`, `__TAURI_EVENT_PLUGIN_INTERNALS__`, and
`__STORYCAPTURE_ELECTRON__`. It also special-cases recording start/stop so the
renderer can use browser `MediaRecorder` microphone capture and pass captured
audio back to the host through `electron_recording_set_audio`.

The packaged app includes:

- `dist/**`
- `dist-electron/**`
- `package.json`

No Rust workspace, Tauri host, `src-tauri`, Cargo target output, or native Rust
crates are part of the current app.

## Desktop Routes

React Router v7 lives in `apps/desktop/src/routes`.

| URL | Route file | Primary surface |
|---|---|---|
| `/` | `dashboard.tsx` | project dashboard and new/open/remove flows |
| `/onboarding` | `onboarding.tsx` | first-run onboarding |
| `/settings` | `settings.tsx` | app/provider/account settings |
| `/editor/:projectId` | `editor.tsx` | story authoring, preview, simulator, UI mode |
| `/recorder/:projectId` | `recorder.tsx` | record a project story |
| `/post-production` | `post-production-landing.tsx` | choose a project/recording to polish |
| `/post-production/:storyId` | `post-production.tsx` | post-production `EditorShell` |
| `*` | `index.tsx` | redirect to `/` |

## IPC Flow

1. Renderer calls thin wrappers in `apps/desktop/src/ipc/*.ts` or imports
   Tauri-compatible plugin APIs directly.
2. `apps/desktop/electron/preload.ts` forwards Tauri-style invokes to
   `ipcRenderer.invoke("tauri-invoke", ...)` and exposes
   `__TAURI_INTERNALS__`, `__TAURI_EVENT_PLUGIN_INTERNALS__`, and
   `__STORYCAPTURE_ELECTRON__`.
3. `apps/desktop/electron/ipc.ts` registers the bridge and dispatches into
   `ipc/handlers.ts`.
4. `ipc/handlers.ts` groups modular handlers. Most grouped modules currently
   call `legacyHandlers([...])`, so they are command ownership registries while
   `ipc/legacy/*.ts` owns the remaining legacy implementation.
5. Long-running operations use the existing Tauri-compatible channel/event shim
   rather than a second streaming abstraction.

Current grouped handler areas include app/settings/logs/secrets, projects,
post-production, capture, export, web sync, AI, updates, recording, render,
picker, preview, simulator, and plugin shims for dialog/events/fs/log/os-process
/shell/store/updater/window-state.

Current non-plugin command ownership:

| Module | Commands |
|---|---|
| `ipc/app.ts` | `ping`, `app_info`, `parse_story`, panic, audio inputs, hardware encoder probe, displays/windows/capture targets, screen-capture permission, relaunch, Playwright target resolution, Stage Manager check |
| `ipc/settings.ts` | app settings, reset category, browser executable/language |
| `ipc/logs.ts` | log config, open log dir, frontend log ingest, diagnostic bundle |
| `ipc/secrets.ts` | key presence/set/delete/test plus generic secret store/load/delete |
| `ipc/projects.ts` | list/create/open/remove projects and list project recordings |
| `ipc/preview.ts` | automation launch, preview stream, author preview lifecycle, viewport/url, back/forward/reload, author input, author snapshots |
| `ipc/picker.ts` | author/general picker start, cancel, activity check, stamp step id |
| `ipc/simulator.ts` | simulator start/step/cancel/promote fallback and dry-run start/cancel |
| `ipc/recording.ts` | start/stop/pause/resume recording and host audio handoff |
| `ipc/capture.ts` | capture target get/set/thumbnail and capture start/stop |
| `ipc/post-production.ts` | workflow state, timeline load/save, recording actions/trajectory/step timing, presets, sound library |
| `ipc/render.ts` | render cancel/list active/progress stream; direct enqueue is not a fake timer path |
| `ipc/export.ts` | export presets, validation, run; `export_run` creates real render jobs |
| `ipc/ai.ts` | LSP requests, NL sessions/chat/diffs/regeneration, session rollup, TTS voices/generation/sync/cache |
| `ipc/web-sync.ts` | web account/token, sync/upload status, OAuth, metadata sync queue, upload/cancel, recording status |
| `ipc/updates.ts` | update check/install |

Plugin shims live under `ipc/plugin/*` and cover Tauri-compatible
dialog/event/log/resource, fs, os/process, shell, store, updater, and
window-state commands.

## Renderer Feature Map

- `features/dashboard`: project grid, new-project dialog, search/sort, cards.
- `features/editor`: CodeMirror authoring, parser/LSP bridge, UI builder mode,
  live preview, selector picker, fallback targets, dry run panel, simulator
  timeline, command palette, polish sidecar.
- `features/recorder`: recording view, browser/capture lifecycle, pause/resume,
  audio availability, review prompts.
- `features/post-production`: editor shell, timeline, inspector, preview engine,
  compute graph, export modal, render queue, sound drawer, voiceover compact UI,
  undo/history.
- `features/nl-mode`: natural-language edit chat, diff cards, regeneration and
  apply flows. Current source has feature code and tests, but no route-level
  mount was found in the desktop router.
- `features/voiceover`: voice catalog and TTS clip surfaces.
- Shared renderer folders: `src/components`, `src/lib`, `src/state`,
  `src/stores`, `src/ipc`.

Capture/render/export are desktop app boundaries, not shared packages. They are
split between renderer IPC facades, post-production feature state, and Electron
host handlers.

## Shared Packages

- `@storycapture/config`: shared TypeScript base config.
- `@storycapture/story-dsl`: checked-in, `ts-rs`-generated Story AST surface
  plus CodeMirror language support. Runtime parsing is reached through desktop IPC
  (`apps/desktop/src/ipc/parse.ts`) and host handlers.
- `@storycapture/shared-types`: public package exports are `.` and `./ipc`.
  The root barrel exports IPC types/commands, browser presets, and
  `APP_PANIC_EVENT`. `src/generated/effects.ts` is a checked-in
  `ts-rs`-generated file in the package tree, but it is not currently exposed
  through the package export map or root barrel.
- `@storycapture/ui`: shared token layer, `claude-design` CSS, and `Sc*`
  primitives. Base UI is the primitive foundation.

## Web Companion

`apps/web` is a Next.js 16 app with App Router, tRPC, Prisma, NextAuth v5,
Cloudflare R2 multipart uploads, workspace/video dashboards, invites,
templates, analytics, oEmbed, and desktop sync.

`apps/web/next.config.ts` uses standalone output, transpiles
`@storycapture/ui` and `@storycapture/shared-types`, externalizes MaxMind, and
sets frame-ancestor policy so `/embed/*` can be framed while other routes deny
framing.

Routes and APIs:

| Path | Source | Purpose |
|---|---|---|
| `/` | `src/app/page.tsx` | public home or redirect based on session |
| `/watch/[slug]` | `src/app/watch/[slug]/page.tsx` | public watch page |
| `/embed/[id]` | `src/app/embed/[id]/page.tsx` | embeddable player |
| `/invite/[token]` | `src/app/invite/[token]/page.tsx` | workspace invite accept |
| `/sign-in` | `src/app/(auth)/sign-in/page.tsx` | sign-in UI |
| dashboard group | `src/app/(dashboard)/**` | dashboard, videos, analytics, sync, templates, workspace members/settings |
| `/api/trpc/[trpc]` | API route | tRPC endpoint |
| `/api/auth/*` | API routes | NextAuth plus desktop token/JWT minting |
| `/api/upload/*` | API routes | R2 multipart initiate/presign/complete |
| `/api/analytics/*` | API routes | view session and event ingest |
| `/api/cron/aggregate-analytics` | API route | Vercel cron aggregation |
| `/api/oembed` | API route | oEmbed metadata |

Current source caveat: `src/app/page.tsx` redirects authenticated users to
`/dashboard`, while dashboard pages live under the `(dashboard)` route group.
Verify route behavior before assuming `/dashboard` exists as a concrete path.

tRPC routers:

- `user`: current user and workspace memberships.
- `workspace`: create/list/update/delete workspaces, members, invites,
  acceptance, RBAC checks.
- `video`: video metadata, privacy/share fields, workspace-scoped operations.
- `analytics`: video stats and dashboard analytics.
- `template`: public curated templates plus protected fork flow.
- `sync`: desktop metadata sync, recording status, SSE-style subscriptions, and
  polling fallback.
- `health`: health checks.

Prisma models: Auth.js `User`, `Account`, `Session`, `VerificationToken`, plus
`Workspace`, `WorkspaceMember`, `WorkspaceInvite`, `Video`, `ViewEvent`,
`DailyVideoStats`, `Template`, and `SyncedProject`. Enums include `Role`,
`VideoStatus`, `TemplateCategory`, and `WorkflowType`.

## CI

Current CI is `.github/workflows/ci.yml` on `macos-14`. It runs on pull
requests and pushes to `main`, uses `contents: read`, and cancels older runs on
the same ref through workflow concurrency.

1. setup pnpm and Node through `.github/actions/setup-toolchain/action.yml`;
2. `pnpm install --frozen-lockfile`;
3. `pnpm typecheck`;
4. desktop Vitest;
5. UI package Vitest;
6. web Vitest;
7. desktop Electron package build.

There is no current GitHub release workflow. Release/signing scripts exist but
are standalone unless a future workflow wires them in.

Benchmark and auxiliary scripts such as `scripts/benchmark/render-1min.sh`,
`scripts/ci/check-av-drift.sh`, `scripts/ci/generate-synthetic-recording.sh`,
and `scripts/download-fonts.sh` are local/manual helpers unless explicitly
called by a workflow.

## Release Topology

Electron packaging is configured in `apps/desktop/package.json` under `build`.
Outputs go to `apps/desktop/release-electron`.

Relevant scripts:

- `scripts/notarize/notarize-mac.sh`
- `scripts/notarize/adhoc-sign.sh`
- `scripts/release/sign-windows.ps1`
- `scripts/release/verify-installer-size.sh`

Local macOS package builds skip signing when no Developer ID certificate is
installed. Production signing/notarization credentials are documented in
`docs/CREDENTIALS.md`.
- Recording synchronization is split between the committed-frame media clock,
  `ipc/action-landmarks.ts`, and the centralized `ipc/cursor-sync-mode.ts`
  rollout resolver. The action sidecar writer stays compatible in shadow mode
  and emits v3 only in unified mode.
- Post-production source timing is centralized in
  `state/source-timeline-map.ts`; preview presented-frame scheduling and export
  compositor seeking consume that mapper rather than maintaining separate
  clocks. Timeline layout v2 persists maps, sync groups, source revisions, and
  timing-model metadata.
