# StoryCapture Sc Primitives

Typed React primitives for the shared StoryCapture design system. This directory
keeps its historical name to avoid source-path churn; consumers import only from
`@storycapture/ui`.

- `primitives/` — React wrappers for the CSS classes. Keep them small, typed,
  and dependency-light; Base UI is used only where it already provides the
  underlying control behavior.

Canonical CSS import order:

1. `@storycapture/ui/tokens.css`
2. `@storycapture/ui/primitives.css`
3. `@storycapture/ui/desktop-shell.css` (desktop only)
