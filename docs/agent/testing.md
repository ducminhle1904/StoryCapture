# Testing Guide

## Test Commands

- There is no root `pnpm test`.
- Desktop all tests: `pnpm --dir apps/desktop exec vitest run`.
- Desktop focused test: `pnpm --dir apps/desktop exec vitest run <path>`.
- Post-production sizing/schema changes: focus
  `apps/desktop/src/features/post-production/inspector/background-panel.test.tsx`
  for preset/slider accessibility and single-entry undo/redo semantics across
  pointer, keyboard, and interrupted gestures; then cover timeline layout
  migration, graph compiler, scene evaluator/renderer, host planning, preflight,
  and compositor-host tests before running `pnpm typecheck`. Run
  `pnpm --dir apps/desktop run test:e2e:export` when the host or packaged path
  changes.
- Recording diagnostic tests:
  `pnpm --dir apps/desktop exec vitest run electron/ipc/recording-observability.test.ts electron/ipc/recording-diagnostic-reader.test.ts electron/ipc/recording-spike-trace.test.ts electron/ipc/logs.test.ts`.
- Recording V2 packaged helper gate:
  `pnpm --dir apps/desktop run test:e2e:recording-v2-helper`. This builds an
  unpacked package and verifies the platform helper signature plus the V2 hello
  protocol. It is separate from `test:e2e:export` and does not certify live
  display/window capture or a sustained release soak.
- Recording V3 native addon protocol gate:
  `pnpm --dir apps/desktop run native:build:recording-v3`.
- Recording V3 uncertified-development E2E:
  `pnpm --dir apps/desktop run test:e2e:recording-v3-development-flow`. Run it
  after changes to the dev gate, preflight, V3 lifecycle, bundle discovery,
  export provenance, or upload guard. The command performs a fresh native
  addon build and requires macOS ARM64 plus screen-capture permission.
- Recording V3 packaged production proof:
  `pnpm --dir apps/desktop run test:e2e:recording-v3-production-probe`.
- Recording V3 sustained gates are
  `pnpm --dir apps/desktop run test:e2e:recording-v3-60s` and
  `pnpm --dir apps/desktop run test:e2e:recording-v3-soak`. The soak assumes
  the protected workflow already packaged the certification executable; local
  ad-hoc success does not replace Developer ID, notarization, or protected
  manifest generation.
- Cursor-sync Electron E2E: `pnpm --dir apps/desktop run test:e2e:cursor-sync`.
- Smooth document/nested-container scroll Electron E2E:
  `pnpm --dir apps/desktop run test:e2e:scroll`.
- Local media playback Electron E2E: `pnpm --dir apps/desktop run test:e2e:media`.
- Packaged recording and post-production export parity:
  `pnpm --dir apps/desktop run test:e2e:export`. This builds the Electron main
  bundle and renderer, creates an unpacked package, exercises streaming encode,
  legacy finalize, and media probing through the packaged FFmpeg resolver,
  exports the all-effects fixture to MP4/WebM/GIF, and runs an independent
  FFmpeg-generated 720p MP4 fixture with color swatches, one-pixel edges,
  bundled-font text, cursor/effect markers, and deterministic audio. It verifies full decode,
  final-frame motion, exact overlay geometry, color samples, scheduler capacity,
  MP4 delivery/loudness/XMP, and exact-byte 720p/1080p/4K capture at 30/60 fps.
  Software High must score SSIM >= 0.995 against the independent FFmpeg
  reference. When a bundled platform hardware encoder is available at runtime,
  explicit hardware High must score >= 0.985; otherwise the evidence records a
  structured platform/runtime skip. The canonical all-effects regression
  remains >= 0.99.
- Web all tests: `pnpm --dir apps/web test`.
- Web focused test: `pnpm --dir apps/web exec vitest run <path>`.
- UI all tests: `pnpm --dir packages/ui test`.
- UI focused test: `pnpm --dir packages/ui exec vitest run <path>`.
- UI watch mode: `pnpm --dir packages/ui test:watch`.

## Test Configs

- Desktop config: `apps/desktop/vitest.config.ts`.
  - Environment: `happy-dom`.
  - Setup: `apps/desktop/src/test-setup.ts`.
  - Includes renderer tests under `apps/desktop/src` and Electron tests under
    `apps/desktop/electron`.
- Web config: `apps/web/vitest.config.ts`.
  - Environment: `node`.
  - Includes `apps/web/src/**/*.{test,spec}.{ts,tsx}`.
  - Aliases auth, Prisma, and `server-only` to test doubles under
    `apps/web/src/test/`.
- UI config: `packages/ui/vitest.config.ts`.
  - Environment: `happy-dom`.
  - Globals enabled.
  - Includes `packages/ui/src/**/*.{test,spec}.{ts,tsx}`.

## Coverage Shape

- Desktop tests cover editor, recorder, post-production, state, IPC helpers,
  local asset URL handling, and screen-capture permission helpers.
- Export coverage includes the schema-v5 compiler/preflight contract, malformed
  V5 foreground-scale rejection, exact schema-v4 compatibility geometry,
  fixed-resolution foreground-scale parity across preview/export, canonical
  scene/media/asset renderers, every transition/background/cursor trajectory
  variant, full audio-bus planning, queue/output lifecycle, verification, XMP
  writer/parser, packaged assets/binaries, the all-effects regression, and the
  independent quality/capture matrix. Host geometry tests cover DPR 1, 1.25,
  1.5, and 2; the packaged capture matrix explicitly requests DPR 1 and 2
  without relying on the CI runner's physical display scale or committing
  generated artifacts.
- Web tests are narrow: workflow helpers, sync router metadata, and template
  router metadata.
- UI tests cover `packages/ui/src/claude-design/primitives/__tests__/`.
- `packages/story-dsl` currently relies on typecheck and consuming desktop
  tests; no package test script is present.
- Playwright Electron tests live in `apps/desktop/e2e`; the cursor-sync smoke
  launches the real Electron host plus a deterministic local paint fixture.
  It does not replace operator-gated Screen Recording/TCC capture UAT.

## Focus Guidance

- UI/component changes: run the nearest Vitest file first, then the owning
  package test command when risk warrants.
- IPC/host changes: run focused desktop Electron tests plus
  `pnpm --dir apps/desktop exec vitest run` when touching shared behavior.
- Cursor timing/synchronization changes: focus
  `apps/desktop/electron/ipc/cursor-timing.test.ts`,
  `apps/desktop/electron/ipc/action-landmarks.test.ts`,
  `apps/desktop/electron/ipc/legacy/capture-preview-frame-sync.test.ts`,
  `apps/desktop/electron/ipc/legacy/story-runner.test.ts`,
  `apps/desktop/src/features/post-production/preview/__tests__/virtual-cursor-path.test.ts`,
  and
  `apps/desktop/src/features/post-production/__tests__/build-timeline-from-story.test.ts`.
- Recording reload/channel lifecycle changes: focus
  `apps/desktop/electron/channel-sequence.test.ts`,
  `apps/desktop/electron/ipc/legacy/story-runner.test.ts`, and
  `apps/desktop/src/features/recorder/recording-view-lifecycle.test.tsx`.
- Recording V2 contract/admission changes: focus the shared contract test,
  `capture-backend-v2-guard.test.ts`, and
  `recording-certification-catalog.test.ts`.
- Recording V3 changes: focus
  `recording-v3-{contract,capability,browser-backend,engine,native-addon,session-registry,bundle-writer}.test.*`,
  `recording-v3-certification-{manifest,quality,scripts}.test.ts`, discovery,
  and `recording-view-lifecycle.test.tsx`; then run desktop typecheck and the
  packaged production proof when native/probe/package behavior changed.
- Browser Strict/data-plane changes: focus browser backend/lifecycle,
  frame-ring, master pipeline/bundle, cadence, quality, discovery, retention,
  and recorder lifecycle/contract tests before the full desktop suite.
- macOS native capture changes: run the macOS backend tests, native helper
  build/tests when the active Swift toolchain supplies `XCTest`, and the
  packaged helper gate on macOS. The package gate is not a ScreenCaptureKit/TCC
  live-capture certification.
- Windows native capture changes: run the Windows backend, protocol, and
  packaging tests plus the packaged helper gate on a Windows runner. Live WGC,
  Authenticode, DPI/multi-monitor, and named-ring behavior require the actual
  target environment.
- Project registry/atomic persistence changes: focus
  `apps/desktop/electron/ipc/json-store.test.ts` and
  `apps/desktop/electron/ipc/legacy/projects.test.ts`.
- Source-map/preview/export changes should also run
  `state/__tests__/source-timeline-map.test.ts`,
  `preview/__tests__/source-bound-parity.test.ts`,
  `preview/__tests__/canonical-render-parity.test.ts`,
  `preview/canonical-preview-adapter.test.ts`, the focused
  `export-compositor/*.test.ts` suites, and Electron
  `export-{planning,audio-planning,output-lifecycle,artifact-verification,xmp,render}.test.ts`,
  `export-quality-gate.test.ts`, and `export-compositor-host.test.ts`.
  Run `test:e2e:media` when preview-stage presentation or background continuity
  changes. Run `test:e2e:export` whenever the change reaches hidden-window assets,
  FFmpeg/ffprobe, audio mixing, output publication, or packaging. Use
  `scripts/ci/analyze-cursor-sync-roi.mjs` for encoded-marker frame correlation.
- Prisma/schema/web router changes: run `pnpm --dir apps/web db:generate`,
  focused web tests, and `pnpm --dir apps/web typecheck`.
- Cross-package contract changes: run focused package tests, consumer tests, and
  `pnpm typecheck`.
- Electron runtime-value imports from workspace packages must also run the
  Node-resolution and packaged-bundle smokes. For public
  `@storycapture/shared-types` exports, run
  `pnpm --dir apps/desktop exec vitest run electron/shared-types-runtime-resolution.test.ts electron/shared-types-bundle-resolution.test.ts`;
  when the consumer is in the post-production startup path, also run
  `pnpm --dir apps/desktop run test:e2e:media`. Typecheck alone does not prove
  Node ESM can load the package export.
- Generated type surfaces: do not edit generated files directly unless the
  generation source and regeneration process are also handled.
- Electron E2E config: `apps/desktop/playwright.config.ts`; cursor-sync smoke:
  `apps/desktop/e2e/cursor-sync.spec.ts`; smooth-scroll smoke:
  `apps/desktop/e2e/smooth-scroll.spec.ts`. The export package smoke is driven
  by `apps/desktop/scripts/export-compositor-artifact-smoke.mjs` and the main
  process fixture in `apps/desktop/electron/ipc/export-e2e-smoke.ts`, not by
  Playwright.
- Visibility/scroll host changes should focus `target-visibility.test.ts`,
  `smooth-scroll.test.ts`, `interaction-readiness.test.ts`,
  `legacy/story-runner.test.ts`, and `legacy/capture-preview-picker.test.ts`
  before the full desktop suite.
- Structured recording logging changes should run the diagnostic tests plus
  `legacy/capture-preview-frame-sync.test.ts` and `legacy/story-runner.test.ts`.
  Privacy fixtures must prove secrets, story/typed content, selectors, URLs,
  and absolute paths do not reach the JSONL stream or exported bundle.
