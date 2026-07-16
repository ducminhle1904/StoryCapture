# Testing Guide

## Test Commands

- There is no root `pnpm test`.
- Desktop all tests: `pnpm --dir apps/desktop exec vitest run`.
- Desktop focused test: `pnpm --dir apps/desktop exec vitest run <path>`.
- Recording diagnostic reader tests:
  `pnpm --dir apps/desktop exec vitest run electron/ipc/recording-observability.test.ts electron/ipc/recording-discovery.test.ts electron/ipc/recording-diagnostic-reader.test.ts electron/ipc/recording-spike-trace.test.ts electron/ipc/logs.test.ts`.
- macOS native-spike Electron control:
  `pnpm --dir apps/desktop exec playwright test --config playwright.config.ts e2e/macos-native-capture-control.spec.ts`.
  A direct run skips unless the parent spike harness supplies its validated
  control fixture; `spike:macos-native-capture` owns the exercised run.
- Cursor-sync Electron E2E: `pnpm --dir apps/desktop run test:e2e:cursor-sync`.
- Record-engine checkpoint/bundle Electron E2E:
  `pnpm --dir apps/desktop run test:e2e:record-engine-checkpoints`.
- Record-engine exact external-window/target-loss Electron E2E:
  `pnpm --dir apps/desktop run test:e2e:record-engine-external-capture`.
- Record-engine drag/upload Electron E2E:
  `pnpm --dir apps/desktop run test:e2e:record-engine-interactions`.
- Record-engine live scene-repair/stitch, token-expiry, and attempt-exhaustion Electron E2E:
  `pnpm --dir apps/desktop run test:e2e:record-engine-live-repair`.
- Record-engine process-loss recovery Electron E2E:
  `pnpm --dir apps/desktop run test:e2e:record-engine-recovery`.
- Record-engine authenticated microphone-plus-tab iframe/navigation/silence Electron E2E:
  `pnpm --dir apps/desktop run test:e2e:record-engine-tab-audio`.
- Smooth document/nested-container scroll Electron E2E:
  `pnpm --dir apps/desktop run test:e2e:scroll`.
- Local media playback Electron E2E: `pnpm --dir apps/desktop run test:e2e:media`.
- Packaged post-production export parity:
  `pnpm --dir apps/desktop run test:e2e:export`. This builds the Electron main
  bundle and renderer, creates an unpacked package, exports the all-effects
  fixture to MP4/WebM/GIF, and runs an independent FFmpeg-generated 720p MP4
  fixture with color swatches, one-pixel edges, bundled-font text,
  cursor/effect markers, and deterministic audio. It verifies full decode,
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
- Export coverage includes the schema-v4 compiler/preflight contract,
  canonical scene/media/asset renderers, every transition/background/cursor
  trajectory variant, full audio-bus planning, queue/output lifecycle,
  verification, XMP writer/parser, packaged assets/binaries, the all-effects
  regression, and the independent quality/capture matrix. Host geometry tests
  cover DPR 1, 1.25, 1.5, and 2; the packaged capture matrix explicitly requests
  DPR 1 and 2 without relying on the CI runner's physical display scale or
  committing generated artifacts.
- Web tests are narrow: workflow helpers, sync router metadata, and template
  router metadata.
- UI tests cover `packages/ui/src/claude-design/primitives/__tests__/`.
- `packages/story-dsl` currently relies on typecheck and consuming desktop
  tests; no package test script is present.
- Playwright Electron tests live in `apps/desktop/e2e`; the cursor-sync smoke
  launches the real Electron host plus a deterministic local paint fixture.
  It does not replace operator-gated Screen Recording/TCC capture UAT.

## Focus Guidance

- Wave 1 record-engine changes should run the focused tests for
  `recording-outcome`, `recording-lifecycle`, `recording-bundle`,
  `recording-discovery`, `recording-session-journal`, `recording-readiness`,
  `recording-health`, `recording-preflight`, `recording-av-clock`, preload,
  action timeline/landmarks/media clock, legacy story runner, and recorder
  lifecycle before desktop typecheck and the full desktop suite.
- Later record-engine changes should add the owning focused suites before the
  full desktop run: `audio-tracks`, `audio-track-requirements`,
  `author-preview-tab-audio`, `engine-health`, `recording-checkpoints`,
  `recording-segment-stitch`, `recording-repair`, `capture-backend`,
  `capture-backend-delivery`, `capture-target-resolver`, and
  `electron-capture-backends`. Tab/system/native promotion additionally needs
  packaged platform fixtures; unit tests do not satisfy permission, drift,
  signing, or measured spike gates. Use the owning `test:e2e:record-engine-*`
  package script so the Electron main bundle is rebuilt before Playwright;
  calling Playwright directly can exercise stale host code. The tab-audio E2E
  covers concurrent fake-device microphone plus tab capture and hostile page
  denial, but physical-device and signed-package UAT remain separate gates.
- Structured logging changes should run `recording-observability`, `logs`, the
  reader test, and the owning boundary suites. Privacy fixtures must assert that
  canary secrets, story/typed content, upload paths, filenames, and raw selectors
  are absent from JSONL, text logs, and exported diagnostic bundles. Health and
  encoder tests must reject per-frame logging and enforce the one-Hz normal
  aggregate cadence while allowing immediate state transitions. Record-engine
  producers must use typed JSONL V2; general Electron/simulator diagnostics stay
  text-only, and tests should fail if production recording event names return to
  `hostLog` or the removed `recording.legacy` bridge.
- REC-190/220 harness smoke uses the documented `spike:macos-* -- --quick`
  commands. Promotion must omit `--quick`: REC-190 needs the permission,
  ten-minute timing, performance, packaging, and audio-marker exclusion matrix;
  REC-220 needs paired Electron/native 1080p30 for ten minutes, 1440p30 for five
  minutes, exploratory 4K30, lifecycle, stress, and signed-package evidence.
  The native lifecycle gate must explicitly cover first-run/denial/reset,
  window and display, source close, minimize/occlusion, resize and Retina scale,
  sleep/wake, cursor on/off, format/color metadata, and system-audio coexistence.
- The paired Electron control is
  `apps/desktop/e2e/macos-native-capture-control.spec.ts`. It is diagnostic and
  intentionally fails the promotion comparison when the exact source thumbnail
  is empty under macOS TCC.

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
- Source-map/preview/export changes should also run
  `state/__tests__/source-timeline-map.test.ts`,
  `preview/__tests__/source-bound-parity.test.ts`,
  `preview/__tests__/canonical-render-parity.test.ts`, the focused
  `export-compositor/*.test.ts` suites, and Electron
  `export-{planning,audio-planning,output-lifecycle,artifact-verification,xmp,render}.test.ts`,
  `export-quality-gate.test.ts`, and `export-compositor-host.test.ts`.
  Run `test:e2e:export` whenever the change reaches hidden-window assets,
  FFmpeg/ffprobe, audio mixing, output publication, or packaging. Use
  `scripts/ci/analyze-cursor-sync-roi.mjs` for encoded-marker frame correlation.
- Prisma/schema/web router changes: run `pnpm --dir apps/web db:generate`,
  focused web tests, and `pnpm --dir apps/web typecheck`.
- Cross-package contract changes: run focused package tests, consumer tests, and
  `pnpm typecheck`.
- Generated type surfaces: do not edit generated files directly unless the
  generation source and regeneration process are also handled.
- Electron E2E config: `apps/desktop/playwright.config.ts`; cursor-sync smoke:
  `apps/desktop/e2e/cursor-sync.spec.ts`; record-engine checkpoint fixture:
  `apps/desktop/e2e/record-engine-checkpoints.spec.ts`; external capture fixture:
  `apps/desktop/e2e/record-engine-external-capture.spec.ts`; interaction fixture:
  `apps/desktop/e2e/record-engine-interactions.spec.ts`; live-repair fixture:
  `apps/desktop/e2e/record-engine-live-repair.spec.ts`; process-loss recovery:
  `apps/desktop/e2e/record-engine-recovery.spec.ts`; tab-audio fixture:
  `apps/desktop/e2e/record-engine-tab-audio.spec.ts`; smooth-scroll smoke:
  `apps/desktop/e2e/smooth-scroll.spec.ts`. The export package smoke is driven
  by `apps/desktop/scripts/export-compositor-artifact-smoke.mjs` and the main
  process fixture in `apps/desktop/electron/ipc/export-e2e-smoke.ts`, not by
  Playwright.
- Visibility/scroll host changes should focus `target-visibility.test.ts`,
  `smooth-scroll.test.ts`, `interaction-readiness.test.ts`,
  `legacy/story-runner.test.ts`, and `legacy/capture-preview-picker.test.ts`
  before the full desktop suite.
