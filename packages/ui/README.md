# @storycapture/ui

StoryCapture's product theme boundary on top of Astryx Gothic.

## Ownership

- `@storycapture/ui/theme` exports `StoryCaptureThemeProvider` and
  `storyCaptureGothicTheme`.
- `@storycapture/ui/theme.css` is the checked-in Astryx CLI output.
- `@storycapture/ui/fonts.css` loads the bundled Fustat, JetBrains Mono, and
  Manufacturing Consent fonts without a runtime network dependency.
- `@storycapture/ui/product-tokens.css` defines only StoryCapture-specific
  recording, timeline, track, and Electron chrome aliases.

Generic UI components are imported directly from Astryx subpaths such as
`@astryxdesign/core/Button`. This package must not wrap or rename Astryx
components.

## Commands

- `pnpm --dir packages/ui run theme:build`
- `pnpm --dir packages/ui run theme:check`
- `pnpm --dir packages/ui test`
- `pnpm --dir packages/ui run typecheck`

Generated files under `src/theme/generated/` are committed and must only be
updated through `theme:build`.
