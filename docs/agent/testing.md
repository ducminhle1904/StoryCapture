# Testing Guide

## Test Commands

- There is no root `pnpm test`.
- Desktop all tests: `pnpm --dir apps/desktop exec vitest run`.
- Desktop focused test: `pnpm --dir apps/desktop exec vitest run <path>`.
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
- No current Playwright/E2E test command or config is present. Runtime
  Playwright references are app automation concepts, not test wiring.

## Focus Guidance

- UI/component changes: run the nearest Vitest file first, then the owning
  package test command when risk warrants.
- IPC/host changes: run focused desktop Electron tests plus
  `pnpm --dir apps/desktop exec vitest run` when touching shared behavior.
- Prisma/schema/web router changes: run `pnpm --dir apps/web db:generate`,
  focused web tests, and `pnpm --dir apps/web typecheck`.
- Cross-package contract changes: run focused package tests, consumer tests, and
  `pnpm typecheck`.
- Generated type surfaces: do not edit generated files directly unless the
  generation source and regeneration process are also handled.
