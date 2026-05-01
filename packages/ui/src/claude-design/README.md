# Claude Design — Active Desktop System

Active `sc-*` design system for the StoryCapture desktop app. The original
handoff lives in `.planning/design/storycapture-claude-design/`; this directory
is the maintained package version consumed through `@storycapture/ui`.

- `tokens.css` — `--sc-*` tokens (neutral ramp, warm-amber accent, semantic record/success/warn/info, radii, density, shadows, platform-aware surfaces).
- `app.css` — window chrome, titlebar (macOS traffic lights + Windows caption buttons), side nav, toolbar, primitive styles, field layouts, loading skeletons, empty states, and callouts.
- `primitives/` — React wrappers for the CSS classes. Keep them small, typed,
  and dependency-light; Base UI is used only where it already provides the
  underlying control behavior.

Import order in desktop remains:

1. `@storycapture/ui/claude-design/tokens.css`
2. `@storycapture/ui/claude-design/app.css`
3. `@storycapture/ui/tokens.css`

`../tokens.css` is a transitional alias layer for legacy `--color-*` names.
