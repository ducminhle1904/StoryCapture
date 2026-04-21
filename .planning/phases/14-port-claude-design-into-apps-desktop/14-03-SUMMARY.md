---
phase: 14-port-claude-design-into-apps-desktop
plan: 03
subsystem: desktop-ui-routes
tags: [routes, restyle, sc-tokens, post-production, editor, dashboard, settings]
requires:
  - "@storycapture/ui: ScButton + ScCard (shipped Wave 1)"
  - "--sc-* token layer (shipped Wave 1 via transitional alias)"
provides:
  - "Dashboard route restyled with sc-* tokens + Sc* primitives"
  - "Editor route shell restyled with sc-* tokens (children untouched)"
  - "Post-Production editor-shell restyled with sc-* tokens"
  - "Settings route restyled with sc-* header tokens"
affects:
  - apps/desktop/src/routes/dashboard.tsx
  - apps/desktop/src/routes/editor.tsx
  - apps/desktop/src/routes/settings.tsx
  - apps/desktop/src/features/post-production/editor-shell.tsx
tech-stack:
  added: []
  patterns:
    - "Legacy --color-* tokens migrated to --sc-* equivalents in route files"
    - "shadcn Button swapped for ScButton in ported route toolbars"
    - "ScCard wraps dashboard project-grid container"
key-files:
  modified:
    - apps/desktop/src/routes/dashboard.tsx
    - apps/desktop/src/routes/editor.tsx
    - apps/desktop/src/routes/settings.tsx
    - apps/desktop/src/features/post-production/editor-shell.tsx
decisions:
  - "Wave 3 is content-only re-skin inside legacy AppLayout/FullscreenLayout — D-03/D-06a permanently dropped."
  - "Editor VoiceoverCompact child (defined inline in editor.tsx) was also retoken'd to keep the plan's zero-color-tokens invariant on the route file; no behavioral change."
  - "Record <Link> in editor toolbar uses the .sc-btn.primary.sm CSS class directly since ScButton is typed as <button>; composition preserves semantics."
  - "Dropped shadow-[var(--shadow-card)] in editor-shell panes — Claude Design's flat look relies on the 1px sc-border instead of drop shadow."
  - "Settings Appearance section intentionally deferred to Wave 5 (per plan); current restyle is header-tokens-only."
metrics:
  duration: "~20m"
  completed: "2026-04-21"
  tasks: 3
  files_changed: 4
---

# Phase 14 Plan 03: Wave 3 — Route re-skin inside LEGACY shell

Restyled the four primary routes (Dashboard, Editor, Post-Production, Settings) with the Claude Design `--sc-*` token system and Sc* primitives while leaving every behavior wire (IPC, Zustand, CodeMirror/LSP, WebGPU preview, motion transitions, hotkeys, Phase 13 output-prefs) untouched. The legacy `AppLayout` / `title-bar.tsx` / `sidebar.tsx` shell stays exactly as shipped per the D-03/D-06a amendment.

## Tasks Completed

| # | Name                                                 | Commit  |
| - | ---------------------------------------------------- | ------- |
| 1 | Restyle Dashboard + Settings routes with sc-* tokens | d04b76b |
| 2 | Restyle Editor route shell (children untouched)      | 24f474a |
| 3 | Restyle Post-Production editor-shell                 | 7817b53 |

## Verification

- `pnpm --filter @storycapture/desktop typecheck` — PASS (after each task)
- `pnpm --filter @storycapture/desktop build` — PASS (102.59 kB CSS, 1.476 MB JS)
- `cd apps/desktop && npx vitest run features/post-production` — 71/71 tests PASS (10 files)
- `rg "var\(--color-" apps/desktop/src/routes apps/desktop/src/features/post-production/editor-shell.tsx` — 0 hits
- `rg "sc-shell|ScShell|ScTitleBar|ScSideNav" apps/desktop/src` — 0 hits
- `git diff acf3dca..HEAD -- apps/desktop/src/App.tsx apps/desktop/src/components/title-bar.tsx apps/desktop/src/components/sidebar.tsx` — empty (legacy chrome untouched)
- Behavior preservation verified via grep: `StoryEditor|PreviewPanel|SceneListPanel|TimelinePanel|TtsClipInspector|TtsScriptEditor|VoiceCatalogDialog|useHotkeys|parseStory|invoke` returns 19 hits in editor.tsx (unchanged from pre-wave)

## Deviations from Plan

### Auto-fixed (Rule 2 — correctness)

**1. [Rule 2 - Correctness] Retokened VoiceoverCompact inline child in editor.tsx**
- **Found during:** Task 2
- **Issue:** Plan said "do NOT modify child components" but explicitly required `rg "--color-" editor.tsx` returns zero. `VoiceoverCompact` (lines 189-448) is a child component defined inline in the same route file, so it cannot be bypassed without violating the zero-color-tokens DONE criterion.
- **Fix:** Applied the same global token map (color-* → sc-*) across the whole file, including VoiceoverCompact's CSS token references. No behavioral/structural change — only CSS variable names.
- **Files modified:** apps/desktop/src/routes/editor.tsx
- **Commit:** 24f474a

**2. [Rule 3 - Blocking] Record Link could not use ScButton directly**
- **Found during:** Task 2
- **Issue:** `ScButton` is typed as `ButtonHTMLAttributes<HTMLButtonElement>`, so `<Link to=…>` could not be substituted for it without restructuring.
- **Fix:** Applied `.sc-btn.primary.sm` CSS class directly on the `<Link>`, matching claude-design's `.sc-btn.primary` primitive. No behavior change.
- **Commit:** 24f474a

### Auto-fixed (Rule 1 — minor style cleanup)

**3. [Rule 1 - Bug] editor-shell.tsx shadow-card token dropped**
- **Found during:** Task 3
- **Issue:** `shadow-[var(--shadow-card)]` was defined by the legacy token alias layer only, but claude-design's editor-shell mock uses flat surfaces with 1px borders — the drop shadow would be visually off.
- **Fix:** Removed the shadow; kept the `border-[var(--sc-border)]` outline for pane separation. Aligns with postprod.jsx.
- **Commit:** 7817b53

## Deferred / not ported (Task 3)

Claude Design's `postprod.jsx` mock showed a handful of controls that do not exist in the current post-production `editor-shell.tsx` (scrubber ruler variants, split divider handles, sound/cursor lane icons in track headers). These are UI polish items deferred to a future phase; no behavior was removed.

## Retained beyond mock (Task 3)

The current editor-shell includes controls the Claude Design mock omits — these are kept verbatim per D-09:

- `QueueWidget` (render queue badge next to Sounds) — shipped in Phase 2-12b, still wired
- `SoundDrawer` slide-out component — wired via `setSoundDrawerOpen`
- `ExportModal` always-mounted dialog — Phase 13 wiring (ENC-12..ENC-19) preserved for Wave 4
- `PageContentTransition` motion wrapper — kept
- Percent-based `timelineHeightPct` / `previewWidthPct` sizing from Zustand panels slice — untouched

## Dependency Graph Notes

- Consumes `ScButton` + `ScCard` from `@storycapture/ui` (Wave 1)
- Consumes `--sc-*` tokens from Wave 1's transitional alias layer + claude-design/tokens.css import graph
- Wave 4 (overlays + export-modal restyle) now inherits a fully sc-* toolbar in editor-shell so export-modal visual integration is straightforward
- Wave 5 (Settings → Appearance + TweaksPanel cleanup) will layer the theme toggle into the already-tokenized Settings header

## Known Stubs / Tech Debt

- Settings route still renders only `<AccountsPage />`. The Appearance section (theme + accent hue) is intentionally deferred to Wave 5 per plan step 2.3.
- Editor Dry-run `ScButton` has no onClick yet — the original `<button>` also had none (shipped placeholder). No regression.
- Post-production top-bar `uppercase tracking` label retains a Phase 13-era aesthetic that Claude Design's postprod mock rephrases; kept to avoid scope creep (D-09 retain).

## Self-Check: PASSED

- Modified files all exist on disk:
  - apps/desktop/src/routes/dashboard.tsx — FOUND
  - apps/desktop/src/routes/editor.tsx — FOUND
  - apps/desktop/src/routes/settings.tsx — FOUND
  - apps/desktop/src/features/post-production/editor-shell.tsx — FOUND
- Commits present in git log:
  - d04b76b — FOUND
  - 24f474a — FOUND
  - 7817b53 — FOUND
- Typecheck + build + 71 post-production tests all green.
