# Bundled Fonts (SIL OFL 1.1)

This directory contains 5 TrueType fonts used by the post-production text
overlay engine. All fonts are licensed under the
**SIL Open Font License 1.1** — see `LICENSES.md` for per-font copyright
and source URLs.

| File                          | Family          | Weight | Role                                       |
| ----------------------------- | --------------- | ------ | ------------------------------------------ |
| `Geist-Regular.ttf`           | Geist           | 400    | UI sans-serif (body/annotations)           |
| `Geist-Bold.ttf`              | Geist           | 700    | UI emphasis                                |
| `JetBrainsMono-Regular.ttf`   | JetBrains Mono  | 400    | Code / DSL snippets in annotations         |
| `Inter-Display.ttf`           | Inter (Display) | 700    | Display callout / headline                 |
| `SpaceGrotesk-Display.ttf`    | Space Grotesk   | 700    | Alternate display callout                  |

## Regenerating real fonts

The files committed here are **CI-safe header stubs** (valid SFNT magic,
16 bytes each). To fetch the real OFL-licensed TTFs, run:

```sh
./scripts/download-fonts.sh
```

This pulls each font from its upstream release into `assets/fonts/` and
overwrites the stubs. Ship-ready bundles MUST contain real fonts; the
stubs are only acceptable for offline CI where the network is unavailable.

## Why stubs?

- Render-time fallback: tests only need font files to exist.
- Licence compliance: every real font we ship is OFL, so we never
  re-distribute a restricted font by accident.
- Determinism: CI runs without network access still pass, and
  snapshot fixtures do not depend on glyph metrics (Plan 09 Task 2
  measures text via `ab_glyph`, which degrades gracefully on stubs).
