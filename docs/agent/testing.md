# Testing Guide

## Test Commands

- There is no root `pnpm test`.
- Desktop all tests: `pnpm --dir apps/desktop exec vitest run`.
- Desktop focused test: `pnpm --dir apps/desktop exec vitest run <path>`.
- Cursor-sync Electron E2E: `pnpm --dir apps/desktop run test:e2e:cursor-sync`.
- Local media playback Electron E2E: `pnpm --dir apps/desktop run test:e2e:media`.
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
  `apps/desktop/electron/ipc/legacy/story-runner.test.ts`,
  `apps/desktop/src/features/post-production/preview/__tests__/virtual-cursor-path.test.ts`,
  and
  `apps/desktop/src/features/post-production/__tests__/build-timeline-from-story.test.ts`.
- Source-map/preview/export changes should also run
  `state/__tests__/source-timeline-map.test.ts`,
  `preview/__tests__/source-bound-parity.test.ts`, and the Electron export
  planning/compositor tests. Use `scripts/ci/analyze-cursor-sync-roi.mjs` for
  encoded-marker frame correlation.
- Prisma/schema/web router changes: run `pnpm --dir apps/web db:generate`,
  focused web tests, and `pnpm --dir apps/web typecheck`.
- Cross-package contract changes: run focused package tests, consumer tests, and
  `pnpm typecheck`.
- Generated type surfaces: do not edit generated files directly unless the
  generation source and regeneration process are also handled.
- Electron E2E config: `apps/desktop/playwright.config.ts`; cursor-sync smoke:
  `apps/desktop/e2e/cursor-sync.spec.ts`.
