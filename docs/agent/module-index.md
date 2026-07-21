# Module Index

Use this for task routing after reading the short root guide.

## Desktop Renderer

- Route table: `apps/desktop/src/routes/index.tsx`.
- Bootstrap: `apps/desktop/src/main.tsx` initializes settings/output preferences
  and the export-compositor entry; `apps/desktop/src/App.tsx` owns startup
  effects, routing, and global overlays.
- Dashboard/projects: `apps/desktop/src/routes/dashboard.tsx`,
  `apps/desktop/src/features/dashboard/`, `apps/desktop/src/state/projects.ts`,
  `apps/desktop/src/ipc/projects.ts`, and new-project workflow definitions in
  `apps/desktop/src/features/workflows/workflow-catalog.ts`.
- Project pipeline stages and hybrid navigation gates:
  `apps/desktop/src/features/project-workflow/project-stage.ts` and
  `apps/desktop/src/features/project-workflow/project-stage-header.tsx`.
- Editor/authoring: `apps/desktop/src/routes/editor.tsx`,
  `apps/desktop/src/features/editor/story-editor.tsx`,
  `apps/desktop/src/features/editor/story-builder.tsx`,
  `apps/desktop/src/features/editor/story-ui-model.ts`,
  `apps/desktop/src/features/editor/polish-sidecar.ts`,
  `apps/desktop/src/features/editor/use-editor-live-preview.ts`,
  `apps/desktop/src/state/editor.ts`,
  `apps/desktop/src/state/simulator-store.ts`.
- Recorder: `apps/desktop/src/routes/recorder.tsx`,
  `apps/desktop/src/features/recorder/recording-view.tsx`,
  `apps/desktop/src/features/capture/TargetPicker.tsx`,
  `apps/desktop/src/state/recorder.ts`, and IPC facades in
  `apps/desktop/src/ipc/capture.ts`, `apps/desktop/src/ipc/audio.ts`,
  `apps/desktop/src/ipc/automation.ts`, `apps/desktop/src/ipc/encode.ts`.
- Post-production: `apps/desktop/src/routes/post-production.tsx`,
  `apps/desktop/src/features/post-production/editor-shell.tsx`,
  `apps/desktop/src/features/post-production/state/store.ts`,
  `apps/desktop/src/features/post-production/state/timeline-layout.ts`,
  `apps/desktop/src/features/post-production/state/build-timeline-from-story.ts`,
  `apps/desktop/src/features/post-production/state/cursor-click-effect.ts`,
  `apps/desktop/src/features/post-production/state/virtual-cursor-scheduler.ts`,
  `apps/desktop/src/features/post-production/state/compute-graph.ts`, plus
  `apps/desktop/src/features/post-production/timeline/`,
  `apps/desktop/src/features/post-production/inspector/`,
  `apps/desktop/src/features/post-production/preview/`,
  `apps/desktop/src/features/post-production/export-compositor/`,
  `apps/desktop/src/features/post-production/export-modal/`, and
  `apps/desktop/src/features/post-production/render-queue/`. Export disclosure
  UI lives in `apps/desktop/src/features/export/AiDisclosureModal.tsx`.
- Post-production text customization: `state/timeline-slice.ts` owns persisted
  clip fields; `state/text-style.ts` owns presets, normalization, and render
  projection; `state/system-font-catalog.ts` owns user-activated system-font
  discovery and fallback. Appearance controls live in
  `inspector/text-appearance-controls.tsx`, layer and bulk-apply orchestration
  in `inspector/effect-params.tsx`, and exact multi-clip undo snapshots in
  `undo/actions.ts`. Keep parity changes paired across
  `preview/preview-player.tsx`, `preview/canonical-preview-adapter.ts`,
  `state/compute-graph.ts`, and `export-compositor/canonical-visual-engine.ts`;
  the retired WebGPU/WebGL2 preview stack must not be revived. The production
  hidden bridge is `export-compositor/export-compositor-app.tsx`. Re-record
  style reattachment lives in `state/build-timeline-from-story.ts` and
  `editor-shell.tsx`.
- Settings/onboarding: `apps/desktop/src/routes/settings.tsx`,
  `apps/desktop/src/features/settings/categories/`,
  `apps/desktop/src/routes/onboarding.tsx`,
  `apps/desktop/src/assets/onboarding/`.
- NL/AI/TTS UI: `apps/desktop/src/features/nl-mode/`,
  `apps/desktop/src/features/voiceover/`,
  `apps/desktop/src/features/status-bar/`,
  `apps/desktop/electron/ipc/ai.ts`.

## Electron Host And IPC

- Host lifecycle: `apps/desktop/electron/main.ts`,
  `apps/desktop/electron/preload.ts`, `apps/desktop/electron/runtime.ts`.
- IPC registration: `apps/desktop/electron/ipc.ts`,
  `apps/desktop/electron/ipc/handlers.ts`.
- Grouped handlers: `apps/desktop/electron/ipc/ai.ts`,
  `apps/desktop/electron/ipc/app.ts`, `apps/desktop/electron/ipc/capture.ts`,
  `apps/desktop/electron/ipc/context.ts`,
  `apps/desktop/electron/ipc/export.ts`, `apps/desktop/electron/ipc/picker.ts`,
  `apps/desktop/electron/ipc/logs.ts`,
  `apps/desktop/electron/ipc/post-production.ts`,
  `apps/desktop/electron/ipc/preview.ts`,
  `apps/desktop/electron/ipc/projects.ts`,
  `apps/desktop/electron/ipc/recording.ts`,
  `apps/desktop/electron/ipc/render.ts`, `apps/desktop/electron/ipc/secrets.ts`,
  `apps/desktop/electron/ipc/settings.ts`,
  `apps/desktop/electron/ipc/simulator.ts`,
  `apps/desktop/electron/ipc/updates.ts`,
  `apps/desktop/electron/ipc/web-sync.ts`.
- Tauri-compatible plugin shims: `apps/desktop/electron/ipc/plugin/index.ts`
  plus `apps/desktop/electron/ipc/plugin/*.ts`.
- Legacy host operations: `apps/desktop/electron/ipc/legacy.ts`,
  `apps/desktop/electron/ipc/legacy/*.ts`, and
  `apps/desktop/electron/ipc/legacy-command.ts`.
- Renderer IPC facades: `apps/desktop/src/ipc/*.ts`.

### Recording V2

- Public contract: `packages/shared-types/src/recording-v2.ts`.
- Strict admission and lifecycle:
  `apps/desktop/electron/ipc/recording-certification-catalog.ts`,
  `apps/desktop/electron/ipc/capture-backend-v2-guard.ts`, and
  `apps/desktop/electron/ipc/recording-strict-browser-lifecycle.ts`.
- Capture backends:
  `apps/desktop/electron/ipc/browser-capture-backend-v2.ts`,
  `apps/desktop/electron/ipc/macos-screen-capture-backend.ts`, and
  `apps/desktop/electron/ipc/windows-capture-backend.ts`; platform protocol and
  helper sources live in `windows-capture-protocol.ts` and
  `apps/desktop/native/{macos-screen-capture,windows-capture}/`.
- Frame/master data plane:
  `apps/desktop/electron/ipc/recording-frame-ring.ts`,
  `apps/desktop/electron/ipc/recording-master.ts`,
  `apps/desktop/electron/ipc/recording-master-pipeline.ts`,
  `apps/desktop/electron/ipc/recording-bundle.ts`,
  `apps/desktop/electron/ipc/recording-cadence-verifier.ts`, and
  `apps/desktop/electron/ipc/recording-quality-verifier.ts`.
- Discovery, retention, and diagnostics:
  `apps/desktop/electron/ipc/recording-discovery.ts`,
  `apps/desktop/electron/ipc/recording-evidence-retention.ts`,
  `apps/desktop/electron/ipc/recording-failed-bundle-retention.ts`, and
  `apps/desktop/electron/ipc/recording-failed-bundle-actions.ts`.
- Renderer policy/result integration:
  `apps/desktop/src/state/output-prefs.ts`,
  `apps/desktop/src/state/recorder.ts`,
  `apps/desktop/src/features/recorder/recording-view.tsx`,
  `apps/desktop/src/ipc/recording-failure.ts`, and
  `apps/desktop/src/ipc/recording-master.ts`.

## DSL, Capture, Render, Export

- DSL vocabulary and CodeMirror: `packages/story-dsl/src/ast.ts`,
  `packages/story-dsl/src/codemirror-lang.ts`.
- Runtime parser: `apps/desktop/electron/ipc/story-parser.ts`.
- Target visibility and controlled scrolling:
  `apps/desktop/electron/ipc/target-visibility.ts`,
  `apps/desktop/electron/ipc/smooth-scroll.ts`,
  `apps/desktop/electron/ipc/interaction-readiness.ts`, and runner integration in
  `apps/desktop/electron/ipc/legacy/story-runner.ts`.
- Recorded action/cursor timing crosses host and renderer:
  `apps/desktop/electron/ipc/action-timeline.ts`,
  `apps/desktop/electron/ipc/cursor-timing.ts`,
  `apps/desktop/electron/ipc/legacy/story-runner.ts`,
  `apps/desktop/src/ipc/actions.ts`,
  `apps/desktop/src/features/post-production/state/virtual-cursor-scheduler.ts`,
  and `apps/desktop/src/features/post-production/preview/virtual-cursor-path.ts`.
- Recording diagnostics use typed JSONL V2 events from
  `apps/desktop/electron/ipc/recording-observability.ts`, local stream
  rotation/export from `apps/desktop/electron/ipc/log-store.ts`, and the
  session/process reader in `apps/desktop/scripts/recording-diagnostics.mjs`.
  The legacy recorder emits only events that match its current lifecycle;
  `hostLog` remains for general Electron and simulator diagnostics.
- Browser picker and authoring sidecars:
  `apps/desktop/src/features/editor/`, `apps/desktop/src/ipc/picker.ts`,
  `apps/desktop/electron/ipc/picker.ts`.
- Capture/recording/render/export host paths:
  `apps/desktop/electron/ipc/capture.ts`,
  `apps/desktop/electron/ipc/recording.ts`,
  `apps/desktop/electron/ipc/render.ts`,
  `apps/desktop/electron/ipc/export.ts`,
  `apps/desktop/electron/ipc/export-compositor-host.ts`,
  `apps/desktop/electron/ipc/export-binaries.ts`,
  `apps/desktop/electron/ipc/legacy/export-render.ts`,
  `apps/desktop/electron/ipc/legacy/export-planning.ts`,
  `apps/desktop/electron/ipc/legacy/export-audio-planning.ts`,
  `apps/desktop/electron/ipc/legacy/export-compositor.ts`,
  `apps/desktop/electron/ipc/legacy/export-output-lifecycle.ts`,
  `apps/desktop/electron/ipc/legacy/export-artifact-verification.ts`, and corresponding
  renderer facades under `apps/desktop/src/ipc/`.

## Web Companion

- App routes: `apps/web/src/app`.
- REST handlers: `apps/web/src/app/api`.
- tRPC bootstrap: `apps/web/src/trpc/init.ts`,
  `apps/web/src/trpc/routers/_app.ts`, `apps/web/src/trpc/lib/guards.ts`.
- tRPC routers: `apps/web/src/trpc/routers/analytics.ts`,
  `apps/web/src/trpc/routers/health.ts`, `apps/web/src/trpc/routers/sync.ts`,
  `apps/web/src/trpc/routers/template.ts`,
  `apps/web/src/trpc/routers/user.ts`, `apps/web/src/trpc/routers/video.ts`,
  `apps/web/src/trpc/routers/workspace.ts`.
- Auth/session/token work: `apps/web/src/lib/auth.ts`,
  `apps/web/src/lib/desktop-auth.ts`, `apps/web/src/lib/jwt.ts`,
  `apps/web/src/app/api/auth/[...nextauth]/route.ts`,
  `apps/web/src/app/api/auth/desktop-token/route.ts`,
  `apps/web/src/app/api/auth/mint-sse-jwt/route.ts`.
- Upload/share/storage: `apps/web/src/trpc/routers/video.ts`,
  `apps/web/src/app/api/upload/initiate/route.ts`,
  `apps/web/src/app/api/upload/presign/route.ts`,
  `apps/web/src/app/api/upload/complete/route.ts`, `apps/web/src/lib/r2.ts`.
- Analytics/cron: `apps/web/src/trpc/routers/analytics.ts`,
  `apps/web/src/app/api/analytics/ingest/route.ts`,
  `apps/web/src/app/api/analytics/session/route.ts`,
  `apps/web/src/app/api/cron/aggregate-analytics/route.ts`,
  `apps/web/vercel.json`.
- Public watch/embed/oEmbed: `apps/web/src/app/watch/[slug]/page.tsx`,
  `apps/web/src/app/embed/[id]/page.tsx`,
  `apps/web/src/components/watch-viewer.tsx`,
  `apps/web/src/components/embed-player.tsx`,
  `apps/web/src/app/api/oembed/route.ts`.

## Desktop-Web Boundary

- Sync router: `apps/web/src/trpc/routers/sync.ts`.
- Desktop auth routes: `apps/web/src/app/api/auth/desktop-token/route.ts`,
  `apps/web/src/app/api/auth/mint-sse-jwt/route.ts`.
- Desktop host bridge: `apps/desktop/electron/ipc/legacy/web.ts`;
  `apps/desktop/electron/ipc/web-sync.ts` registers legacy command slices.
- Renderer stores calling web/sync/upload invokes:
  `apps/desktop/src/stores/web-account-store.ts`,
  `apps/desktop/src/stores/web-sync-store.ts`,
  `apps/desktop/src/stores/upload-store.ts`.

## Shared UI And Styling

- Desktop styling entry: `apps/desktop/src/styles.css`.
- Shared package entry and base tokens: `packages/ui/src/index.ts`,
  `packages/ui/src/tokens.css`.
- Shared CSS: `packages/ui/src/primitives.css` and
  `packages/ui/src/desktop-shell.css`.
- Component catalog and governance: `packages/ui/src/catalog/`,
  `packages/ui/visual-tests/`, and `packages/ui/scripts/`.
- Primitives: `packages/ui/src/claude-design/primitives/` and
  exports from `packages/ui/src/claude-design/index.ts`.
- Desktop local wrappers/components: `apps/desktop/src/components/ui/`.

## Shared Contracts

- Shared package exports: `packages/shared-types/src/index.ts`.
- IPC compatibility surface: `packages/shared-types/src/ipc.ts`.
- Recording V2 policy, backend, evidence, bundle, result, and export-source
  contracts: `packages/shared-types/src/recording-v2.ts`, exported as
  `@storycapture/shared-types/recording-v2`.
- Public `WebAccountInfo` is defined by `packages/shared-types/src/ipc.ts` and
  re-exported from `packages/shared-types/src/index.ts`;
  `packages/shared-types/src/web-account.ts` is currently not exported.
- Browser presets: `packages/shared-types/browser-presets.json`,
  `packages/shared-types/src/browser-presets.ts`.
- Generated effect types:
  `packages/shared-types/src/generated/effects.ts`.
- Authoritative recording synchronization: `apps/desktop/electron/ipc/action-landmarks.ts`
  samples cursor/input/presentation state only at committed media frames;
  `cursor-sync-mode.ts` resolves the internal `legacy`, `shadow`, and `unified`
  rollout modes.
  Frame/PTS arithmetic remains owned by
  `apps/desktop/electron/ipc/recording-media-clock.ts`.
- Source-bound post-production timing: `state/source-timeline-map.ts` is the
  shared mapper for video, cursor, audio, preview, and export;
  `state/cursor-preset-reflow.ts` owns optional exact-deficit holds and atomic
  sync-group reflow.
- Presented preview state: `preview/presented-media-clock.ts` and
  `preview/preview-player.tsx` use decoded/presented frames for source-bound
  overlays. Export parity lives in
  `export-compositor/export-compositor-app.tsx` and the Electron export planner.
