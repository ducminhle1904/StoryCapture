---
phase: 14-port-claude-design-into-apps-desktop
plan: 01
subsystem: desktop-ui-foundation
tags: [tokens, primitives, fonts, design-system]
requires:
  - packages/ui/src/claude-design/tokens.css (staged in context gather)
  - packages/ui/src/claude-design/app.css (staged in context gather)
provides:
  - "@storycapture/ui": ScButton, ScInput, ScBadge, ScSwitch, ScCard, ScKbd, ScSlider, ScSelect(+Trigger/Content/Item/Value), ScSegmented, cn
  - "@storycapture/ui/claude-design/tokens.css" subpath export (--sc-* canonical tokens)
  - "@storycapture/ui/claude-design/app.css" subpath export (.sc-* primitive CSS)
  - /_design-system/tokens, /_design-system/components hidden routes
affects:
  - apps/desktop/src/styles.css (rewritten token import graph)
  - apps/desktop/package.json (font dep swap)
  - packages/ui/src/tokens.css (transitional legacy --color-* -> --sc-* alias layer)
  - apps/desktop/src/lib/theme.ts (default flipped to dark per D-02)
  - apps/desktop/src/lib/fonts.ts (comment rewrite)
tech-stack:
  added:
    - "@fontsource-variable/inter@^5.2.0"
    - "@fontsource-variable/jetbrains-mono@^5.1.0"
    - "clsx@^2.1.1 (in @storycapture/ui)"
    - "tailwind-merge@^2.5.0 (in @storycapture/ui)"
    - "@testing-library/react + vitest + happy-dom + @vitejs/plugin-react devDeps (in @storycapture/ui)"
  removed:
    - "@fontsource/inter"
    - "@fontsource/jetbrains-mono"
    - "@fontsource/lora"
    - "@fontsource-variable/outfit"
  patterns:
    - "Sc* React primitives over Base UI + clsx/twMerge + forwardRef + displayName"
    - "Subpath CSS exports from @storycapture/ui for framework-agnostic consumption"
key-files:
  created:
    - packages/ui/src/lib/cn.ts
    - packages/ui/src/claude-design/primitives/sc-button.tsx
    - packages/ui/src/claude-design/primitives/sc-input.tsx
    - packages/ui/src/claude-design/primitives/sc-badge.tsx
    - packages/ui/src/claude-design/primitives/sc-switch.tsx
    - packages/ui/src/claude-design/primitives/sc-card.tsx
    - packages/ui/src/claude-design/primitives/sc-kbd.tsx
    - packages/ui/src/claude-design/primitives/sc-slider.tsx
    - packages/ui/src/claude-design/primitives/sc-select.tsx
    - packages/ui/src/claude-design/primitives/sc-segmented.tsx
    - packages/ui/src/claude-design/primitives/index.ts
    - packages/ui/src/claude-design/index.ts
    - packages/ui/src/claude-design/primitives/__tests__/*.test.tsx (9 files, 20 tests)
    - packages/ui/tsconfig.json
    - packages/ui/vitest.config.ts
    - apps/desktop/src/routes/_design-system/tokens.tsx
    - apps/desktop/src/routes/_design-system/components.tsx
  modified:
    - apps/desktop/package.json
    - apps/desktop/src/styles.css
    - apps/desktop/src/lib/theme.ts
    - apps/desktop/src/lib/fonts.ts
    - apps/desktop/src/routes/index.tsx
    - packages/ui/package.json
    - packages/ui/src/index.ts
    - packages/ui/src/tokens.css (rewritten as transitional alias layer)
decisions:
  - "TRANSITIONAL legacy alias: 770 --color-* refs across 88 files exceed the plan's 50-hit migration threshold, so packages/ui/src/tokens.css was kept as a stub mapping every --color-* onto its --sc-* equivalent. Wave 5 deletes the stub after routes are migrated (per CONTEXT.md Deferred Ideas)."
  - "Default theme flipped from light to dark (D-02) in apps/desktop/src/lib/theme.ts so the new sc-* dark-first token system takes effect without explicit user action."
  - "Base UI ToggleGroup 1.0-rc0 renamed toggleMultiple -> multiple (single-select is now the default); ScSegmented drops the prop and lets the default apply."
  - "Subpath exports (./claude-design/tokens.css, ./claude-design/app.css) published from @storycapture/ui so apps/desktop imports canonical CSS without reaching into package internals."
metrics:
  duration: "~25m"
  completed: "2026-04-21"
  tasks: 3
  files_changed: 23
---

# Phase 14 Plan 01: Wave 1 — Token Foundation + Sc* Primitives + Showcase Summary

Retired the Cursor-warm token palette, swapped the font stack to variable Inter + JetBrains Mono, shipped 9 Sc* React primitives over Base UI in `@storycapture/ui`, and wired a hidden `/_design-system` showcase route — establishing the foundation every subsequent Phase 14 wave consumes.

## Tasks Completed

| # | Name                                                           | Commit   |
| - | -------------------------------------------------------------- | -------- |
| 1 | Font swap + token wire-up + transitional tokens.css alias      | 6bdc9f4  |
| 2 | 9 Sc* primitives + barrels + 20 vitest assertions              | f6c1881  |
| 3 | /_design-system/tokens + /_design-system/components routes     | 635141e  |

## Verification

- `pnpm --filter @storycapture/desktop typecheck` — PASS
- `pnpm --filter @storycapture/desktop build` — PASS (1.47 MB JS, 100 KB CSS)
- `pnpm --filter @storycapture/ui test` — PASS (9 files, 20 tests, 463 ms)
- `rg "fontsource/lora|fontsource-variable/outfit|@fontsource/inter[^-]|@fontsource/jetbrains-mono" apps/desktop` — 0 hits
- `import { ScButton, ScInput, ScBadge, ScSwitch, ScCard, ScKbd, ScSlider, ScSelect, ScSegmented } from "@storycapture/ui"` — resolves

## Deviations from Plan

### Auto-adjusted (Rule 3 — blocking fix)

**1. [Rule 3 - Blocker] Transitional tokens.css stub retained instead of deleted**
- **Found during:** Task 1
- **Issue:** Plan Task 1 step 5 instructed "Delete packages/ui/src/tokens.css", but step 4's conditional branch said "keep stub only if grep returns >50 hits". `rg "var\(--color-" apps/desktop/src` returned 770 hits across 88 files — migration at that scale is a multi-wave rewrite, not a Wave 1 foundation task.
- **Fix:** Rewrote `packages/ui/src/tokens.css` as a TRANSITIONAL `@theme` alias layer where every legacy `--color-*` maps to a `--sc-*` equivalent. Imported after `claude-design/{tokens,app}.css` so legacy references still resolve. Marked with a clear comment pointing at the Wave 5 cleanup plan.
- **Files modified:** `packages/ui/src/tokens.css`, `apps/desktop/src/styles.css` (added stub import)
- **Commit:** 6bdc9f4

**2. [Rule 2 - Correctness] Flipped default theme from light to dark**
- **Found during:** Task 1
- **Issue:** `apps/desktop/src/lib/theme.ts` defaulted to `light` from Phase 1. D-02 mandates dark as the new default. Without the flip, the new sc-* dark-first system is invisible without user action.
- **Fix:** Inverted the default in `getTheme()` so unconfigured users land in dark.
- **Commit:** 6bdc9f4

### Auto-fixed (Rule 1 — typecheck bugs)

**3. [Rule 1 - Bug] ScCard `title` clashed with HTMLAttributes**
- **Issue:** `HTMLDivElement` already defines `title: string | undefined`; our `title: ReactNode` was incompatible.
- **Fix:** `extends Omit<HTMLAttributes<HTMLDivElement>, "title">`.
- **Commit:** 635141e

**4. [Rule 1 - Bug] ScSegmented used removed Base UI prop**
- **Issue:** Research expected `toggleMultiple={false}`. Base UI 1.0-rc0 renamed the prop to `multiple` and defaults it to `false`.
- **Fix:** Dropped the prop entirely; default is already single-select.
- **Commit:** 635141e

## Dependency Graph Notes

- Downstream waves (14-02 chrome, 14-03 routes, 14-04 overlays + export restyle, 14-05 TweaksPanel + cleanup) consume the Sc* primitives and `--sc-*` tokens exposed here.
- Phase 13 export-modal (`features/post-production/export-modal/`) was intentionally NOT touched; it still uses the legacy `--color-*` vars which now resolve via the transitional alias layer. Visual output unchanged.
- The transitional `packages/ui/src/tokens.css` alias stub is tech debt owned by Wave 5.

## Known Stubs / Tech Debt

- `packages/ui/src/tokens.css` is a TRANSITIONAL legacy alias. Every `--color-*` it defines is now just `var(--sc-*)`. Deleted in Wave 5 once all 88 files have been migrated to `--sc-*` directly.
- One lingering doc-comment reference to `packages/ui/src/tokens.css` remains in `apps/desktop/src/features/editor/codemirror-setup.ts`; comment only, no functional impact.

## Self-Check: PASSED

- Created files all exist on disk (verified via Write tool handoff).
- Commits present in git log: 6bdc9f4, f6c1881, 635141e.
- `pnpm --filter @storycapture/ui test` and `pnpm --filter @storycapture/desktop build` both green.
