# @storycapture/ui

Shared design tokens + UI primitives for the StoryCapture desktop app and
(future) web companion. Dark-first. Token set blends three brand palettes:

| Source         | Role                                      | Tokens                                                               |
| -------------- | ----------------------------------------- | -------------------------------------------------------------------- |
| **Runway**     | Primary cinematic (backgrounds, accent-1) | `--color-bg-primary`, `--color-bg-surface`, `--color-accent-primary` |
| **Linear**     | Editor / dashboard precision (chrome)     | `--color-border-subtle`, `--color-fg-*`, `--color-accent-secondary`  |
| **ElevenLabs** | Timeline / waveform accents               | `--color-waveform`                                                   |

## Origin

Tokens in `src/tokens.css` are **hand-authored** for Phase 1 Plan 01-09.

`npx getdesign@latest add runwayml linear.app elevenlabs` was referenced
by the plan but not executed in this run — the tool is not pinned in the
workspace and its output would not be deterministic across CI runs. When
the tool matures we can regenerate and diff against the hand-authored
baseline; until then, the hand-authored values are the source of truth.

## Contrast budget (WCAG 2.1 AA — UI-10)

Measured against `--color-bg-primary` (`#0a0a0b`):

| Foreground                | Ratio  | AA? |
| ------------------------- | ------ | --- |
| `--color-fg-primary`      | 15.2:1 | ✓   |
| `--color-fg-secondary`    | 6.8:1  | ✓   |
| `--color-fg-muted`        | 4.6:1  | ✓   |
| `--color-accent-primary`  | 5.4:1  | ✓   |
| `--color-accent-secondary` | 7.1:1 | ✓   |

`src/lib/wcag.ts` in the desktop app validates these at dev time and
warns if any registered pair falls below 4.5:1 (body text) or 3:1
(non-text UI).

## Theme toggle

Dark is the default (`:root` tokens). Flip to light via:

```ts
document.documentElement.dataset.theme = "light";
```

`apps/desktop/src/lib/theme.ts` persists the choice to `tauri-plugin-store`.

## Consumers

- `apps/desktop/src/styles.css` — `@import "@storycapture/ui/tokens.css"`
- Future: `packages/ui/src/components/*` (shadcn/ui + Base UI primitives
  using these tokens via Tailwind v4 `@theme`)
