# @storycapture/ui

Shared design tokens and UI primitives for StoryCapture.

## What Lives Here

- `src/tokens.css`
  Canonical foundation, semantic, and compatibility token layer.
- `src/primitives.css`
  Shared component styling for desktop and web.
- `src/desktop-shell.css`
  Electron window chrome, navigation, and workspace layout.
- `src/claude-design/`
  The shipped `Sc*` React component implementation.
- Package exports:
  - `@storycapture/ui`
  - `@storycapture/ui/tokens.css`
  - `@storycapture/ui/primitives.css`
  - `@storycapture/ui/desktop-shell.css`

## Current Role

- Desktop and web consume the canonical tokens and shared React primitives.
- Base UI is the primitive layer. Do not introduce Radix-based assumptions
  here.

## Primitive Families

The `claude-design` primitive barrel exports these `Sc*` families:

- `ScBadge`
- `ScAccordion`
- `ScButton`
- `ScCallout`
- `ScCard`
- `ScEmptyState`
- `ScField`
- `ScInput`
- `ScKbd`
- `ScDialog`
- `ScPopover`
- `ScRadioGroup`
- `ScSegmented`
- `ScSelect`
- `ScSkeleton`
- `ScSlider`
- `ScSwitch`
- `ScTabs`
- `ScTextarea`
- `ScToggleGroup`
- `ScTooltip`

Use these before adding local one-off UI primitives in desktop/web surfaces.

## Commands

- `pnpm --dir packages/ui test`
- `pnpm --dir packages/ui test:a11y`
- `pnpm --dir packages/ui test:boundaries`
- `pnpm --dir packages/ui boundaries:update` refreshes the exact per-file literal allowlist after an intentional token exception is reviewed.
- `pnpm --dir packages/ui test:visual`
- `pnpm --dir packages/ui catalog`
- `pnpm --dir packages/ui exec vitest run <path>`

## Notes

- Tokens are hand-authored and versioned in-repo.
- This package is not “future only” scaffolding anymore.
- If you change the design language, update `AGENTS.md` only at the headline
  level and put the real detail in `docs/ARCHITECTURE.md` or package docs.
