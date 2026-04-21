---
phase: 14
plan: 03c
subsystem: desktop-ui
tags: [settings, claude-design, gap-closure, placeholders]
requires: [14-03b]
provides: [settings-full-category-port]
affects:
  - apps/desktop/src/routes/settings.tsx
  - apps/desktop/src/features/settings/
created:
  - apps/desktop/src/features/settings/settings-row.tsx
  - apps/desktop/src/features/settings/categories/general-category.tsx
  - apps/desktop/src/features/settings/categories/api-keys-category.tsx
  - apps/desktop/src/features/settings/categories/capture-category.tsx
  - apps/desktop/src/features/settings/categories/render-category.tsx
  - apps/desktop/src/features/settings/categories/keyboard-category.tsx
  - apps/desktop/src/features/settings/categories/privacy-category.tsx
  - apps/desktop/src/features/settings/categories/about-category.tsx
modified:
  - apps/desktop/src/routes/settings.tsx
deleted: []
decisions:
  - All 7 mock categories land simultaneously with visible but disabled placeholders where no store exists (user override of D-09)
  - Accounts stays as an 8th category rather than being split; it owns Web account, Updates, Automation — surfaces the 7-category mock doesn't model
  - Render defaults wires Resolution + HW encoder to the Phase 13 output-prefs store; Codec + Parallel renders remain placeholders
  - About reads live app version and Tauri version via @tauri-apps/api/app
  - SettingsRow + SettingsPanel + SettingsCard + NotWiredCaption extracted into a local primitive file (reused >= 3x)
  - Workspace chip shows "Workspace · Local" (neutral, honest — no fake user/workspace name)
metrics:
  commits: 2
  completed: 2026-04-21
---

# Phase 14 Plan 03c: Full Settings Category Port Summary

One-liner: Port the Claude Design `settings.jsx` mock's 7 categories (General / API keys / Capture backend / Render defaults / Keyboard / Privacy & telemetry / About) into `apps/desktop/src/routes/settings.tsx` with wired state where it exists today and disabled placeholders where it doesn't, keeping the existing Accounts category as an app-specific 8th entry.

## What Changed

### Route — `apps/desktop/src/routes/settings.tsx`

- Section registry expanded from 1 to 8 entries (7 mock + existing Accounts).
- Initial selected section switched from `accounts` to `keys` (matches the mock's default).
- Header gains:
  - `ScBadge tone="muted"` with "Workspace · Local" meta (honest placeholder — no real workspace data).
  - Right-aligned `ScButton variant="ghost" size="sm" disabled` "Reset to defaults" with a `title` tooltip explaining it's coming soon.
- Left nav keeps the same `sc-nav-item` styling wired in 14-03b; icons use lucide-react (`Settings`, `Key`, `Monitor`, `Download`, `Keyboard`, `Lock`, `Info`, `UserCircle`).
- Content area stays inside `PageContentTransition`; each category renders a dedicated component.

### New — `apps/desktop/src/features/settings/settings-row.tsx`

Local primitives used by every category (kept out of `@storycapture/ui` since they are page-specific, not design-system primitives):

- `SettingsPanel({ title, desc, children })` — panel shell with header + optional description.
- `SettingsCard({ children })` — bordered surface wrapping a group of rows.
- `SettingsRow({ label, hint, control, last })` — label/hint/control grid with bottom hairline (suppressed on the last row).
- `NotWiredCaption({ children })` — muted italic caption that signals "this section is visual only".

### New — `apps/desktop/src/features/settings/categories/`

Per-category components. Each is a self-contained file; all imports route through `@storycapture/ui` primitives (`ScInput`, `ScSegmented`, `ScSwitch`, `ScSlider`, `ScBadge`, `ScButton`). Layout mirrors the mock.

### Per-category wiring map

| Category | Status | Wiring notes |
|---|---|---|
| General | Placeholder | Projects folder / Startup / Auto-save / Dock badge all disabled. No general-prefs store exists. |
| API keys | **Wired** | Reuses existing `ApiKeyRow` + `key_get_presence` / `key_set` / `key_test` / `key_delete` IPC from AccountsPage. LLM vs TTS grouping preserved. |
| Capture backend | Placeholder | Three-option picker maintains local state but does not persist; `pick_default_backend()` still chooses at runtime. All sub-toggles (fps, cursor, color space, audio) disabled. |
| Render defaults | **Partial** | Resolution segmented control writes to `useOutputPrefsStore.setRecordingKnob('resolution', …)`. HW encoder switch writes to `setExportKnob('hwEncoder', 'auto' \| 'none')`. Codec + Parallel renders are disabled placeholders. |
| Keyboard | **Live read** | Static list reflects hotkeys actually registered today (Dashboard 14-03a: ⌘N, ⌘F; CommandPalette: ⌘K; EditorHotkeys). No rebind affordance. |
| Privacy & telemetry | Placeholder | Toggles disabled by design — telemetry is off per CLAUDE.md; opt-in upload UI lands later. |
| About | **Wired** | Reads live app version (`getVersion()`) and Tauri version (`getTauriVersion()`) from `@tauri-apps/api/app`. |
| Accounts (kept) | **Wired** | Existing `AccountsPage` unchanged — Web account, API keys (legacy grouping), Updates, Automation. |

Note: API keys appear twice — once as a mock-shaped dedicated category (new) and once inside AccountsPage's mixed layout (unchanged). Both render the same `ApiKeyRow` component against the same keychain state, so they stay in sync automatically. Future cleanup can consolidate; for this gap closure, preserving AccountsPage wiring trumps dedupe.

## Verification

- `pnpm --filter @storycapture/desktop typecheck` — PASS.
- `pnpm --filter @storycapture/desktop build` — PASS (2.29 s; pre-existing chunk-size warning unrelated).
- `rg "sc-shell|ScShell|ScTitleBar|ScSideNav" apps/desktop/src` — 0 matches.
- `AccountsPage.test.tsx` — 6 failing, identical to the pre-existing failures documented in 14-03b (Vietnamese copy expectations against English AccountsPage). Not touched.
- Out-of-scope files verified untouched: `App.tsx`, `title-bar.tsx`, `sidebar.tsx`, `recorder.tsx`, `dashboard.tsx`, `routes/editor.tsx`, `routes/post-production.tsx`, `features/dashboard/*`, `features/export/*`, `features/post-production/*`, `packages/ui/src/claude-design/tokens.css`, `packages/ui/src/claude-design/app.css`, all Sc\* primitives.

## Deviations from Plan

### Rule 1 — fixed-in-place

- Render category initially typed 4K resolution as `p4k`; the shared-types DTO uses `p2160`. Replaced the local key alias and kept the user-facing label "4K". (Caught by typecheck.)
- Initial `PageContentTransition` call passed a `transitionKey` prop that does not exist on the component. Removed — the existing motion behavior is tied to mount, which is still correct because each category component remounts on section switch.

### Rule 2 — auto-added

- `title` attribute on the disabled "Reset to defaults" button explaining why it's disabled (WCAG AA — don't strand users at a disabled control with no context).
- `aria-pressed` on capture-backend picker buttons (they function as a radio group visually).
- `NotWiredCaption` under every placeholder section so users aren't misled into thinking an inert toggle is broken.

### Scope decisions (documented, not deviations)

- **Appearance category** is **not** added — the mock doesn't include it, and Wave 5 (plan 14-05) is the planned home. The 8-slot nav has no obstacle to adding it as item #2 later.
- **Workspace chip** shows "Workspace · Local" instead of a fake user name ("Eleanor Walsh" from the mock). Honest placeholder per CLAUDE.md's no-fake-data rule.
- **API keys dedicated category vs. AccountsPage grouping**: Both render. Rationale above.

## Placeholder Inventory (for future wiring plans)

Disabled controls future waves must revisit:

- General: Projects folder input (needs projects-folder pref IPC), Startup segmented, Auto-save switch, Dock badge switch.
- Capture: Backend picker (needs capture-backend pref), Capture fps, Capture cursor, Color space, Audio input.
- Render: Codec segmented (needs multi-codec pipeline), Parallel renders slider (needs job-cap pref).
- Privacy: Crash reports, Usage analytics, Auto-update (already wired under Accounts), Prompt redaction.
- Toolbar: "Reset to defaults" action.

## Preservation Check (D-09)

- IPC surface unchanged — no new commands, no existing command deleted.
- Zustand: `useOutputPrefsStore` used read + write for resolution and hwEncoder only; no schema change.
- Existing AccountsPage / ApiKeyRow / WebAccountPanel / AutoUpdaterSettings / BrowserRow untouched.
- No change to `@storycapture/ui` package.
- No scope bleed outside `apps/desktop/src/routes/settings.tsx` and `apps/desktop/src/features/settings/`.

## Commits

- `cb5a4f0` feat(14-03c): add SettingsRow primitive for settings categories
- `ae6dccc` feat(14-03c): port all 7 Settings categories with header + workspace meta

## Self-Check: PASSED

- [x] `apps/desktop/src/routes/settings.tsx` FOUND (rewritten).
- [x] `apps/desktop/src/features/settings/settings-row.tsx` FOUND (new).
- [x] `apps/desktop/src/features/settings/categories/` FOUND (7 new files).
- [x] Commits `cb5a4f0`, `ae6dccc` present in `git log`.
- [x] typecheck PASS, build PASS.
- [x] `rg "sc-shell|ScShell|ScTitleBar|ScSideNav" apps/desktop/src` → 0.
- [x] No touch outside the declared scope.
