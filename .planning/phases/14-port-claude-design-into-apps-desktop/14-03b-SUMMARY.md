---
phase: 14
plan: 03b
subsystem: desktop-ui
tags: [settings, editor, post-production, claude-design, gap-closure]
requires: [14-03a]
provides: [settings-mock-structure, post-production-mock-structure, editor-mock-structure]
affects:
  - apps/desktop/src/routes/settings.tsx
  - apps/desktop/src/routes/editor.tsx
  - apps/desktop/src/features/post-production/editor-shell.tsx
created: []
modified:
  - apps/desktop/src/routes/settings.tsx
  - apps/desktop/src/features/post-production/editor-shell.tsx
  - apps/desktop/src/routes/editor.tsx
deleted: []
decisions:
  - Settings ships with a single wired category ("Accounts") — the mock's category nav frame lands now so Wave 5 can add "Appearance" as item #2 without structural churn
  - Post-production SceneList (mock left pane) deferred — our shot-list lives in the timeline; no scene data model exists
  - Post-production preview transport bar + AI-pass/Preview toolbar actions deferred — no playback engine wired at shell level (internal preview has its own controls)
  - Editor Run/Pause transport + tabs strip + console strip deferred — execution happens in /recorder, not in the editor; file tabs require multi-buffer support not present
  - Lint-clean badge shown only when zero errors AND zero warnings AND store ready
metrics:
  commits: 3
  completed: 2026-04-21
---

# Phase 14 Plan 03b: Settings + Post-Production + Editor Mock Structure Gap Closure Summary

One-liner: Port Claude Design `settings.jsx`, `postprod.jsx`, and `editor.jsx` toolbar/shell structures into the desktop routes — sc-toolbar headers, Settings category sidebar, scissors/folder icon breadcrumbs, diagnostic + lint-clean badges — preserving all IPC wiring, Zustand slices, panel composition, CodeMirror/LSP, and voiceover integration per D-09.

## What Changed

### Route 1 — Settings (`apps/desktop/src/routes/settings.tsx`)

Rewritten to match the mock's SettingsScreen shell shape:

- `sc-toolbar` header with `sc-toolbar-title` "Settings" (replaces the old plain `<header>`).
- Left `<nav>` column (200 px, `--sc-chrome-2` background, `--sc-border` divider) rendering `.sc-nav-item` buttons. Icons colored with `--sc-accent-400` on active.
- Right content area: `PageContentTransition` wrapping the selected section's component.
- Section registry is a static array. **Only `Accounts` is wired** — mapped to the existing `AccountsPage` which owns WebAccountPanel + ApiKeyRow rows + AutoUpdaterSettings + BrowserRow. All internal AccountsPage content is unchanged.
- Section state is `useState<SectionId>` (client-only UI state, not persisted — matches the mock).
- `aria-current="page"` on the active nav button for a11y.

### Route 2 — Post-production shell (`apps/desktop/src/features/post-production/editor-shell.tsx`)

Top bar restyled to the mock's `sc-toolbar`:

- `Scissors` lucide icon (left) + `sc-toolbar-title` "Post-Production" + `ScBadge` muted showing `story {storyId}` (replaces the old uppercase tracking label).
- Right actions unchanged structurally: `Sounds` button (→ `setSoundDrawerOpen`), `QueueWidget`, `Export` button (→ `setExportModalOpen`). Export button tone changed from `primary` to `success` to match the mock's green Export CTA.
- Body layout (preview+inspector top / timeline bottom, `PageContentTransition`) unchanged. All 6 Zustand slices (`timelineHeightPct`, `previewWidthPct`, `setSoundDrawerOpen`, `setExportModalOpen`, `durationMs`, `setDuration`) referenced verbatim.
- `useEditorHotkeys`, `SoundDrawer`, `ExportModal`, `PreviewPlayer`, `InspectorPanel`, `Timeline` all mounted verbatim.

### Route 3 — Editor (`apps/desktop/src/routes/editor.tsx`)

Top header restyled to the mock's `sc-toolbar`:

- Left group: `ArrowLeft` back link to `/`, `FolderOpen` icon, "Projects" link, `ChevronRight`, bold filename/folder name.
- Diagnostic `ScBadge` pills (record tone for errors, warn tone for warnings) remain wired to `diagnostics` from `useEditorStore`.
- Right group: `Lint clean` `ScBadge` (shown only when `ready && errorCount === 0 && warningCount === 0`), divider, `Dry run` `ScButton`, `Record` primary link → `/recorder/${projectId}`.
- Main workspace (PanelGroup vertical → PanelGroup horizontal with SceneListPanel + StoryEditor + rail + TimelinePanel, voiceover tab switching, motion/react transitions, `VoiceCatalogDialog`) **unchanged — every line preserved**.

## Verification

- `pnpm --filter @storycapture/desktop typecheck` — PASS
- `pnpm --filter @storycapture/desktop build` — PASS (2.25s, pre-existing chunk-size warning unrelated)
- `pnpm --filter @storycapture/desktop test --run` — post-production suite 71/71 PASS (10/10 files). Two pre-existing failing suites untouched by this plan (AccountsPage.test.tsx written for older Vietnamese-copy AccountsPage; ChatPanel.test.tsx empty-state). Verified pre-existing via `git stash` sanity check.

## Deferred Items (per D-09 — preserve wiring, don't invent data)

### Settings

| Feature | Reason | Blocking plan |
| ------- | ------ | ------------- |
| `General` section (Projects folder, Startup, Auto-save, Dock badge) | No general-prefs store wired | Future: general prefs plan |
| `API keys` subsection separated from Accounts | Our `AccountsPage` already groups API keys inside the Accounts category; splitting would fragment the UX and require multi-panel routing not wired | Accounts feature split |
| `Capture backend` section | No capture-backend picker wired; SCK/WGC/xcap chosen automatically by `pick_default_backend()` | Capture settings UI plan |
| `Render defaults` section | Render defaults belong to the Phase 13 output-prefs store, surfaced inside the Export modal (D-07). Moving them to Settings duplicates state. | Defer or merge later |
| `Keyboard` section | No user-customizable hotkey registry; bindings are static in code | Hotkey registry plan |
| `Privacy & telemetry` section | No telemetry store; `AutoUpdaterSettings` lives inside Accounts category today | Privacy settings plan |
| `About` section | No app-version/build-info IPC surfaced | About IPC plan |
| `Reset to defaults` toolbar action | No settings store yet | Same as sections above |
| `Workspace · Eleanor Walsh` workspace badge | No workspace name data | Web-companion multi-tenancy plan |
| `Appearance` category | Owned by Wave 5 (D-02 theme toggle + accent hue) | 14-05 plan |

### Post-production

| Feature | Reason | Blocking plan |
| ------- | ------ | ------------- |
| `SceneList` left pane | No scene model at shell level — shot list lives inside the timeline tracks; the mock's scene-per-capture concept doesn't exist in our data | Scene model plan |
| `AI pass` toolbar button | No AI-pass action implemented | Future AI effects plan |
| `Preview` toolbar button | Preview is rendered in-shell via `PreviewPlayer`; a separate "preview mode" toggle would duplicate | N/A (already covered) |
| `checkout_flow · auto-synced` meta badge | Story auto-sync state not tracked at shell | Sync status plan |
| Transport bar (SkipBack / Play / SkipForward / scrubber / Volume / speed) under the canvas | `PreviewPlayer` owns its own transport internally; injecting a shell-level transport would break the single source of truth | Preview consolidation plan |
| Canvas sub-toolbar (Fit/100%/Zoom, cursor/zoom/AI/mic buttons, resolution meta) | Canvas view model not lifted to shell | Future preview toolbar plan |
| Right Inspector tabs (effects / audio / metadata) replacement | Our `InspectorPanel` already composes these sections in its own layout — replacing would fight Phase 2-12b wiring | N/A |

### Editor

| Feature | Reason | Blocking plan |
| ------- | ------ | ------------- |
| File tabs strip (`checkout_flow.story`, `helpers.story`, `+` new tab) | Multi-buffer editor not implemented; only one `.story` file per project | Multi-buffer plan |
| `Ln X, Col Y · SC-DSL · UTF-8` status meta | Cursor line/col + encoding not surfaced from CodeMirror to the header | Editor status-bar plan |
| `modified` dirty badge | No dirty-state tracking in `useEditorStore`; `autosave` is called on every keystroke | Explicit-save UX plan |
| `Prev scene` / `Next scene` transport | Mock's cross-scene jump via toolbar buttons; we have the `SceneListPanel` for this already (click a scene) | N/A |
| `Run` / `Pause` toolbar transport | Execution lives in `/recorder/${projectId}`; an in-editor runner doesn't exist | Live-run plan |
| `Export` from editor toolbar | Export is a post-production action (Phase 13 output-prefs); re-adding here would duplicate | N/A |
| `ConsoleStrip` (14 events / warnings / Clear) | No event log stream surfaced in the editor; dry-run output goes elsewhere | Event log plan |
| `BrowserMock` preview with animated cursor + zoom frame | We ship the real `PreviewPanel` in the rail tab — stylized mock preview is a design device, not a feature | N/A |
| `Live Preview` viewport switcher (Mobile/Tablet/Desktop) | No viewport-override pipeline in preview | Viewport picker plan |

## Deviations from Plan

### Rule 2 — auto-added

- **`Export` button tone `success` on post-prod shell**: mock shows green export CTA (`variant="success"`); previous tone was `primary`. Changed to match. (Commit: 278b52c)
- **Explicit `aria-current="page"` on Settings nav buttons**: mock doesn't spell it out but the buttons are the page-level nav; CLAUDE.md WCAG AA baseline requires this. (Commit: 56936e1)
- **Lint-clean badge gated on `ready && 0 errors && 0 warnings`**: mock always shows "Lint clean"; rendering it during store hydration or with warnings would be misleading. Gated to be honest. (Commit: ad5417d)

### Scope boundary

- No Sc* primitive extensions were needed — existing `ScBadge` (with `tone` / `icon`) and `ScButton` (with `variant` / `size` / `icon`) already covered all mock surfaces in these three routes.

### Hotkey audit

- Settings: no new hotkeys. Category nav is click-only (matches mock).
- Post-production: unchanged — existing `useEditorHotkeys` wired verbatim.
- Editor: unchanged — existing CodeMirror + scene-list + voiceover hotkeys preserved.
- No collisions with dashboard `⌘N` / `⌘F` (14-03a) or `⌘K` command palette.

## Preservation Check (D-09)

- No edit to: `App.tsx`, `title-bar.tsx`, `sidebar.tsx`, `routes/recorder.tsx`, `routes/index.tsx`, `routes/dashboard.tsx`, `routes/post-production.tsx`, `features/dashboard/*`, `features/export/*`, `features/post-production/export-modal/*`, `features/post-production/state/*`, `packages/ui/src/claude-design/tokens.css`, `packages/ui/src/claude-design/app.css`, any Sc* primitive.
- IPC surface unchanged. `invoke("tts_regenerate_clip")`, `fetchProjectFolder`, `parseStory`, `readTextFile`, `writeTextFile`, `key_get_presence`, export-modal IPC — all preserved.
- Zustand: `useEditorStore` (post-production slice + editor slice), `useVoiceoverStore`, `useDashboardStore`, `useEditorHotkeys` referenced with identical selectors.
- CodeMirror + LSP bridge: `StoryEditor` + `editorJumpTarget` + `EditorJumpTarget` preserved verbatim.
- motion/react: rail-tab pill + panel transitions in editor.tsx preserved verbatim.
- Grep `sc-shell|ScShell|ScTitleBar|ScSideNav` → 0 matches.

## Commits

- `56936e1` refactor(14-03b): port Settings route structure (toolbar + category nav)
- `278b52c` refactor(14-03b): port EditorShell toolbar to sc-toolbar structure
- `ad5417d` refactor(14-03b): port Editor toolbar to sc-toolbar with breadcrumb + lint badge

## Self-Check: PASSED

- [x] `apps/desktop/src/routes/settings.tsx` FOUND (rewritten)
- [x] `apps/desktop/src/features/post-production/editor-shell.tsx` FOUND (toolbar restyled)
- [x] `apps/desktop/src/routes/editor.tsx` FOUND (toolbar restyled)
- [x] Commits 56936e1, 278b52c, ad5417d present in `git log`
- [x] typecheck passes, build passes, post-production test suite 71/71 green
- [x] No `sc-shell|ScShell|ScTitleBar|ScSideNav` references in `apps/desktop/src`
- [x] Dashboard (14-03a), recorder, export modal, post-production state untouched
