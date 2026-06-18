# StoryCapture - Architecture Map

Read-on-demand reference for structure, IPC, routes, CI, and release topology.

## Repo Layout

```text
apps/
  desktop/              Electron + React 19 + Vite 8 desktop app
    electron/           Electron main/preload process and host IPC handlers
    icons/              Desktop app icons used by electron-builder
    scripts/            Desktop build helpers
    src/                Renderer UI, feature modules, stores, IPC facades
  web/                  Next.js 16 web companion

packages/
  ui/                   Shared tokens and claude-design primitives
  shared-types/         Shared browser presets and DTO/type surfaces
  story-dsl/            CodeMirror language support and DSL vocabulary
  config/               Shared TypeScript config

assets/                 Sound library, fonts, image assets
scripts/                Release/signing helpers and runbooks
docs/                   Read-on-demand technical docs
.github/workflows/      Node/Electron CI
```

## Workspace And Scripts

- Root scripts: `dev`, `build`, `lint`, `format`, `typecheck`.
- Desktop scripts:
  - `dev` starts Electron with a Vite renderer.
  - `build` packages Electron via `electron-builder`.
  - `renderer:*` runs renderer-only Vite workflows.
- Web scripts: `dev`, `build`, `start`, `typecheck`, `test`, plus Prisma helpers.

## Desktop Runtime

Electron is the runtime host. The renderer still imports `@tauri-apps/api` and
selected Tauri plugin packages as a compatibility API surface; Electron
implements the corresponding bridge in `apps/desktop/electron/preload.ts` and
`apps/desktop/electron/ipc.ts`.

The packaged app includes only:

- `dist/**`
- `dist-electron/**`
- `package.json`

No Rust workspace, Tauri host, or Cargo target output is packaged.

## IPC Flow

1. Renderer code calls thin wrappers in `apps/desktop/src/ipc/*.ts` or imports
   Tauri-compatible plugin APIs.
2. `apps/desktop/electron/preload.ts` exposes Tauri-compatible internals and
   routes calls to Electron IPC.
3. `apps/desktop/electron/ipc.ts` handles host operations: project storage,
   browser automation, recording, preview, export, web sync, settings, logs,
   updater, and plugin compatibility.
4. Long-running operations use Tauri-compatible channel/event shims implemented
   in the Electron bridge.

## Frontend Desktop

- Routing: React Router v7 in `apps/desktop/src/routes`.
- Feature state: colocated Zustand stores under `features/*`, plus shared
  stores under `src/state` and `src/stores`.
- Server/host state: TanStack Query wrappers under `src/ipc`.
- Editor: CodeMirror-based DSL authoring with live preview, simulator timeline,
  selector picker flow, and UI/code hybrid editing.
- Recorder: Electron-hosted browser capture and FFmpeg export via
  `ffmpeg-static`.
- Post-production: timeline, inspector, preview, effects graph construction,
  sound/cursor/zoom/annotation tracks, and export UI.

## Web Companion

`apps/web` is a Next.js app with tRPC, Prisma, NextAuth, R2 upload/share flows,
workspace/video dashboards, analytics, invites, and desktop sync endpoints.

## CI

`.github/workflows/ci.yml` runs the Node/Electron verification path:

- pnpm install
- root typecheck
- desktop Vitest
- UI package Vitest
- web Vitest
- desktop Electron package build

## Release Notes

Electron packaging is configured in `apps/desktop/package.json` under the
`build` key. Local macOS package builds skip signing when no Developer ID
certificate is installed; production signing/notarization credentials are
documented in `docs/CREDENTIALS.md`.
