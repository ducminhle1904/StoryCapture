---
phase: 14
plan: 03d
subsystem: desktop-ui
tags: [claude-design, gap-closure, placeholders, settings, dashboard, post-production, editor]
requires: [14-03c]
provides: [placeholder-upgrade-4-routes]
affects:
  - apps/desktop/src/routes/settings.tsx
  - apps/desktop/src/routes/dashboard.tsx
  - apps/desktop/src/routes/editor.tsx
  - apps/desktop/src/features/settings/categories/
  - apps/desktop/src/features/dashboard/project-card.tsx
  - apps/desktop/src/features/post-production/editor-shell.tsx
created: []
modified:
  - apps/desktop/src/routes/settings.tsx
  - apps/desktop/src/routes/dashboard.tsx
  - apps/desktop/src/routes/editor.tsx
  - apps/desktop/src/features/settings/categories/api-keys-category.tsx
  - apps/desktop/src/features/settings/categories/about-category.tsx
  - apps/desktop/src/features/settings/categories/general-category.tsx
  - apps/desktop/src/features/settings/categories/privacy-category.tsx
  - apps/desktop/src/features/dashboard/project-card.tsx
  - apps/desktop/src/features/post-production/editor-shell.tsx
deleted: []
decisions:
  - Settings nav is strictly 7 mock categories; Accounts folded (Web account → API keys, Updates → About, BrowserRow → General/Automation).
  - AccountsPage.tsx left on disk (orphan, still referenced by pre-existing failing AccountsPage.test.tsx — not touched per 14-03b convention).
  - Dashboard status badge uses neutral muted "Draft" on all cards — no derivation from id hash, no fake status.
  - Rendering progress bar intentionally omitted — time-series data would mislead as a flat placeholder.
  - Post-production placeholders go in shell chrome only (top bar, sub-toolbar, bottom transport); PreviewPlayer internals untouched.
  - Editor file tab strip renders a single real tab (single-buffer reality); "+" disabled; dirty indicator is a static muted dot pending dirty-state tracking.
  - Ln/Col kept as em-dash placeholders — wiring would require plumbing through CodeMirror onUpdate into StoryEditor (out of scope).
  - Console strip is 28px collapsed-by-default to avoid stealing vertical real estate from the editor.
metrics:
  commits: 4
  completed: 2026-04-21
---

# Phase 14 Plan 03d: Placeholder Upgrade for Four Routes Summary

One-liner: Bring deferred Claude Design mock elements back as honest, disabled, non-functional placeholders across Settings, Dashboard, Post-production, and Editor — preserving every IPC/Zustand/hotkey/CodeMirror/WebGPU/motion wiring while matching the mock's visual density.

## What Changed

### Scope 1 — Settings: fold Accounts into 7 mock categories

- `routes/settings.tsx`: removed 8th `accounts` entry from `SECTIONS`; `UserCircle` import dropped; `AccountsPage` import + render branch removed. Nav is now exactly 7 items.
- `categories/api-keys-category.tsx`: imports `WebAccountPanel` from `../accounts-panel`; renders a "Web account" subsection at the top of the panel (above the OS-keychain callout and provider groups).
- `categories/about-category.tsx`: imports `AutoUpdaterSettings` (default export) from `../auto-updater`; renders an "Updates" subsection below the about card (Check-on-launch toggle + Check-now button + update banner).
- `categories/general-category.tsx`: imports `BrowserRow` from `../BrowserRow`; renders an "Automation" subsection below the existing General card (browser-executable picker with presets).
- `categories/privacy-category.tsx`: updated the "Auto-update" row hint from "Managed under Accounts → Updates" to "Managed under About → Updates" to match the new location.
- `AccountsPage.tsx` left intact on disk (referenced by the pre-existing failing `AccountsPage.test.tsx` per 14-03b — untouched to avoid widening scope).

### Scope 2 — Dashboard placeholders

- `features/dashboard/project-card.tsx`:
  - Added `ScBadge tone="muted" dot` with label "Draft" in the card header row (neutral default, honest — no status derivation).
  - Added a scene/duration placeholder meta line `— scenes · —:—` above the existing sessions subtitle.
  - Disabled the `⋯` more-menu button; removed the `onMore` callback usage (the `title` tooltip explains "More actions coming soon"). Prop signature unchanged for caller compatibility but the handler is no longer invoked.
- `routes/dashboard.tsx`:
  - Added a disabled `ScSegmented` (All/Ready/Rendering/Drafts) in the toolbar between search and the New Story button.
  - Added a bottom `RecentRenderRail` component rendered only when there are projects to show; emits a "RECENT RENDERS" header + disabled "View all" + muted "No recent renders yet." empty-state.
- Rendering progress bar intentionally **not** re-added.

### Scope 3 — Post-production (EditorShell) placeholders

- `features/post-production/editor-shell.tsx`:
  - Top bar: inserted disabled `AI pass` (Sparkles icon) and `Preview` (Eye icon) buttons before a vertical divider, then the existing Sounds / Queue / Export chain.
  - Preview section now flex-column so three chrome strips share the frame cleanly.
  - **Canvas sub-toolbar** (above PreviewPlayer, 36px): disabled Fit/100/Zoom segmented, ghost icon buttons for cursor / zoom-keyframe / AI auto-zoom / voiceover-overlay, em-dash resolution meta on the right.
  - **Shell transport** (below PreviewPlayer): disabled SkipBack / Play / Pause / SkipForward + mono `—:—:— / —:—:—` placeholder + volume/fullscreen ghost buttons.
  - `PreviewPlayer`, `InspectorPanel`, `Timeline`, `SoundDrawer`, `ExportModal`, `QueueWidget` all called with identical props; none of their internals touched.
- **SceneList placeholder**: not added. Our existing panel layout covers scene discovery through the timeline; adding a sidebar placeholder would duplicate visual affordances and fight `useEditorStore`.

### Scope 4 — Editor placeholders

- `routes/editor.tsx`:
  - **File tab strip** above the existing Script header: accent-top-bordered active tab labeled `${folder.name}.story` with a muted modified-dot (placeholder — no dirty tracking) and a disabled `+` button.
  - **Ln / Col / SC-DSL / UTF-8 status line** on the right of the tab strip, cursor values are `Ln —, Col —` (placeholder pending CodeMirror selection wiring).
  - **Console strip** (28px) at the bottom of the script-editor column: `Terminal` icon + "Console" label + muted "Console output will appear here." caption.
  - **Viewport picker**: in the rail header, only when `railTab === "preview"`, disabled `ScSegmented` for Mobile/Tablet/Desktop. On the Voiceover tab the existing scene-name chip still renders.
- `StoryEditor`, `SceneListPanel`, `PreviewPanel`, `TimelinePanel`, `VoiceCatalogDialog`, `useVoiceoverStore`, `useEditorStore`, motion/react transitions — unchanged.

## Verification

- `pnpm --filter @storycapture/desktop typecheck` — PASS.
- `pnpm --filter @storycapture/desktop build` — PASS (2.26s, pre-existing chunk-size warning unrelated).
- `rg "sc-shell|ScShell|ScTitleBar|ScSideNav" apps/desktop/src` — 0 matches.
- Pre-existing failing `AccountsPage.test.tsx` remains untouched (English/Vietnamese copy mismatch documented in 14-03b).

## Placeholder Inventory

### Dashboard
| Element | State | Rationale |
|---|---|---|
| Status badge | Muted "Draft" · dot | `Project` has no status field — neutral default; no hash-derived fakes. |
| Scene·duration meta | `— scenes · —:—` | No scene/duration data source yet. |
| Segmented filter | Disabled, `all` selected | Filter options depend on the status field. |
| ⋯ per-card menu | Disabled, tooltip | No context-menu actions wired. |
| Recent renders rail | Renders with empty-state copy | No render-history data. |
| Render progress bar | Intentionally omitted | Time-series data; static bar would mislead. |
| STATE Filled/Empty toggle | Not added | Mock DEV-only tool, not a product feature. |

### Post-production
| Element | State | Rationale |
|---|---|---|
| AI pass button | Disabled | No AI-pass pipeline. |
| Preview button | Disabled | `PreviewPlayer` already embedded; no separate fullscreen mode. |
| Canvas sub-toolbar | Disabled strip | Canvas view-model not lifted to shell. |
| Shell transport | Disabled strip | `PreviewPlayer` owns the real transport; shell placeholder is chrome only. |

### Editor
| Element | State | Rationale |
|---|---|---|
| File tab strip | One real tab + disabled + | Single-buffer reality. |
| Modified dot | Static muted dot | No dirty-state tracking (autosave debounce handles persistence today). |
| Console strip | 28px collapsed empty-state | No event log stream at editor layer. |
| Viewport picker | Disabled segmented | No viewport-override pipeline in preview. |
| Ln / Col | `Ln —, Col —` | Selection listener not surfaced through `StoryEditor`. |
| Run / Pause toolbar | Not added | Execution lives in `/recorder`; duplicating would fight existing Dry-run + Record flow. |
| BrowserMock preview | Not added | `PreviewPanel` satisfies the preview slot. |

### Settings (Accounts fold)
| Accounts section | New home | Shape |
|---|---|---|
| Web account (OAuth) | API keys category | Subsection above OS-keychain callout. |
| Updates (AutoUpdaterSettings) | About category | Subsection below version card. |
| Automation (BrowserRow) | General category | Subsection below General card. |

## Deviations from Plan

### Rule 1 — fixed in place
- Typecheck caught unused `onMore` destructured prop on `ProjectCard` after disabling the more-menu handler; removed from destructure. Prop type retained for caller compatibility.

### Rule 2 — auto-added
- Added `title` tooltips on disabled buttons that gate real functionality ("Multi-file buffers coming soon", "Shell transport — coming soon", etc.) per WCAG AA — disabled-without-context strands users.
- Added `aria-label` on all icon-only disabled ghost buttons (canvas sub-toolbar, shell transport, file-tab `+`) so screen readers announce their purpose even when inert.

### Scope decisions (not deviations)
- **SceneList pane for post-production** deliberately not added — existing timeline + scene-list already cover this surface. Adding a placeholder pane would push existing panels and duplicate intent.
- **Run/Pause editor toolbar buttons** deliberately not added — `/recorder` is the execution home; the editor toolbar already carries Dry run + Record. Adding disabled twins would confuse.
- **Ln/Col live wiring** deferred — hooking a CodeMirror `EditorView.updateListener` into `StoryEditor` and plumbing it through IPC-adjacent state is out of scope for a placeholder pass.

### Hotkey audit
- No new hotkeys introduced. All existing hotkeys (`⌘N` new story, `⌘F` search, `⌘K` palette, editor CodeMirror/voiceover bindings, `useEditorHotkeys` in post-production) unchanged.

## Preservation Check (D-09)

- No edit to: `App.tsx`, `title-bar.tsx`, `sidebar.tsx`, `recorder.tsx`, `features/export/*`, `features/post-production/export-modal/*`, `features/post-production/state/*`, `packages/ui/src/claude-design/tokens.css`, `packages/ui/src/claude-design/app.css`, any Sc* primitive.
- IPC surface unchanged. `list_projects`, `key_get_presence`, `tts_regenerate_clip`, `fetchProjectFolder`, `parseStory`, updater IPC — all preserved.
- Zustand: `useEditorStore` (both slices), `useVoiceoverStore`, `useDashboardStore`, `useOutputPrefsStore`, `useWebAccountStore` all referenced with identical selectors.
- CodeMirror + LSP bridge: StoryEditor mounted verbatim with same props + jumpTarget + autosave.
- Motion / react: rail-tab pill + panel transitions + page-content transition all preserved.
- PanelGroup / Panel / PanelResizeHandle resize behavior intact in editor.tsx.
- No new Sc* primitive needed — existing Sc{Badge,Button,Card,Input,Segmented,Switch,Slider} sufficed.
- `rg sc-shell|ScShell|ScTitleBar|ScSideNav` → 0 matches.

## Commits

- `75935f0` refactor(14-03d): fold Accounts surfaces into 7 mock Settings categories
- `80a9018` feat(14-03d): dashboard placeholders for deferred mock elements
- `1e54d1f` feat(14-03d): post-production placeholders for deferred mock chrome
- `42c1677` feat(14-03d): editor placeholders for deferred mock elements

## Known Stubs (for verifier)

All items in the Placeholder Inventory above are intentional stubs. They render as disabled / empty / neutral per the plan's `<placeholder_principles>`. Each has a documented blocker in 14-03a/14-03b/14-03c deferred lists and is not masking a failure of the current plan's goal (which is visual fidelity to the mock, not functional completion).

## Self-Check: PASSED

- [x] `apps/desktop/src/routes/settings.tsx` FOUND (8th category removed; 7 nav items).
- [x] `apps/desktop/src/features/settings/categories/api-keys-category.tsx` FOUND (WebAccountPanel folded in).
- [x] `apps/desktop/src/features/settings/categories/about-category.tsx` FOUND (AutoUpdaterSettings folded in).
- [x] `apps/desktop/src/features/settings/categories/general-category.tsx` FOUND (BrowserRow folded in).
- [x] `apps/desktop/src/features/dashboard/project-card.tsx` FOUND (Draft badge + meta line + disabled menu).
- [x] `apps/desktop/src/routes/dashboard.tsx` FOUND (segmented filter + RecentRenderRail).
- [x] `apps/desktop/src/features/post-production/editor-shell.tsx` FOUND (AI/Preview + sub-toolbar + shell transport).
- [x] `apps/desktop/src/routes/editor.tsx` FOUND (file tabs + Ln/Col status + console strip + viewport picker).
- [x] Commits `75935f0`, `80a9018`, `1e54d1f`, `42c1677` present in `git log`.
- [x] typecheck PASS, build PASS.
- [x] No `sc-shell|ScShell|ScTitleBar|ScSideNav` references in `apps/desktop/src`.
