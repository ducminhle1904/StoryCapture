# @storycapture/ui

Shared design tokens and UI primitives for StoryCapture.

## What Lives Here

- `src/tokens.css`
  Shared token layer used across desktop and web.
- `src/claude-design/`
  The shipped `sc-*` design namespace: tokens, app-level styles, and the
  component language used by the current desktop UI.
- Package exports:
  - `@storycapture/ui`
  - `@storycapture/ui/tokens.css`
  - `@storycapture/ui/claude-design/tokens.css`
  - `@storycapture/ui/claude-design/app.css`

## Current Role

- Desktop consumes the token layer and `claude-design` styles today.
- Web can consume the same package, but desktop is the primary consumer right
  now.
- Base UI is the primitive layer. Do not introduce Radix-based assumptions
  here.

## Primitive Families

The `claude-design` primitive barrel exports these `Sc*` families:

- `ScBadge`
- `ScButton`
- `ScCallout`
- `ScCard`
- `ScEmptyState`
- `ScField`
- `ScInput`
- `ScKbd`
- `ScSegmented`
- `ScSelect`
- `ScSkeleton`
- `ScSlider`
- `ScSwitch`
- `ScTabs`
- `ScTextarea`

Use these before adding local one-off UI primitives in desktop/web surfaces.

## Commands

- `pnpm --dir packages/ui test`
- `pnpm --dir packages/ui exec vitest run <path>`

## Notes

- Tokens are hand-authored and versioned in-repo.
- This package is not “future only” scaffolding anymore.
- If you change the design language, update `AGENTS.md` only at the headline
  level and put the real detail in `docs/ARCHITECTURE.md` or package docs.
