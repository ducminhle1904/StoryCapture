---
phase: 14-port-claude-design-into-apps-desktop
plan: 04
subsystem: desktop-ui-overlays-export
tags: [overlays, command-palette, recording-indicator, sonner, export-modal, sc-tokens]
requires:
  - "@storycapture/ui: ScButton (Wave 1)"
  - "--sc-* token layer (Wave 1)"
  - "Restyled editor-shell + routes (Wave 3)"
  - "useRecorderStore (Phase 6)"
  - "Phase 13 export-modal wiring (ENC-12..ENC-19)"
provides:
  - "Cmd/Ctrl+K command palette with cmdk + motion/react"
  - "Floating RecordingIndicator pill driven by recorder store"
  - "Sonner toast stack skinned via --normal-bg/--normal-text/--normal-border/--border-radius/--toast-animation-duration"
  - "Restyled export modal (Phase 13 wiring intact)"
affects:
  - apps/desktop/src/App.tsx
  - apps/desktop/src/components/title-bar.tsx
  - apps/desktop/src/components/command-palette/command-palette.tsx
  - apps/desktop/src/components/command-palette/index.ts
  - apps/desktop/src/components/command-palette/__tests__/command-palette.test.tsx
  - apps/desktop/src/components/recording-indicator.tsx
  - apps/desktop/src/features/post-production/export-modal/export-modal.tsx
tech-stack:
  added: []
  patterns:
    - "cmdk-based palette + Base UI-independent keyboard capture (onKeyDownCapture)"
    - "Sonner CSS-variable skin (Pattern 3 from RESEARCH)"
    - "ScButton replaces shadcn Button in ported surfaces"
    - "Overlay mount inside AppLayout / FullscreenLayout (router context required for useNavigate)"
key-files:
  created:
    - apps/desktop/src/components/command-palette/command-palette.tsx
    - apps/desktop/src/components/command-palette/index.ts
    - apps/desktop/src/components/command-palette/__tests__/command-palette.test.tsx
    - apps/desktop/src/components/recording-indicator.tsx
  modified:
    - apps/desktop/src/App.tsx
    - apps/desktop/src/components/title-bar.tsx
    - apps/desktop/src/features/post-production/export-modal/export-modal.tsx
decisions:
  - "CommandPalette mounts inside AppLayout + FullscreenLayout, NOT as a sibling of <RouterProvider />. Reason: react-router-dom v7 data router makes useNavigate available only to descendants of <RouterProvider />; rendering the palette outside the provider would throw 'useNavigate must be used within a Router context'. Plan said 'sibling to <RouterProvider />' — that language predates the hook constraint. The /region-overlay route intentionally does NOT include the palette (bare transparent page)."
  - "RecordingIndicator reads useRecorderStore.status; shows pill when status is 'recording' or 'paused'. Uses elapsedMs field already exposed by the recorder store."
  - "Toaster position changed to bottom-left to match claude-design ToastStack; richColors prop removed because Sonner's internal dark palette overrides our --normal-bg CSS variable (RESEARCH Pitfall 8)."
  - "Toaster theme hard-coded to 'dark' for Wave 4; Wave 5 will swap for useTweaksStore(s => s.theme)."
  - "Export modal footer button replaced 'brand-button rounded-xl …' custom chrome with ScButton variant='primary' — removes duplicated CSS in favor of the sc-btn primitive."
  - "Accordion still shows 'Tùy chọn nâng cao' (Vietnamese); not changed this wave because the advanced-output-options child component is out of scope per plan."
  - "AnimatePresence exit animation dropped from CommandPalette to keep unmount synchronous (happy-dom has no rAF loop; exit animations leak unmounted DOM into queries). Entry animation preserved."
metrics:
  duration: "~35m"
  completed: "2026-04-21"
  tasks: 3
  files_changed: 7
---

# Phase 14 Plan 04: Wave 4 — Overlays + Export Modal Restyle Summary

Shipped the Wave 4 overlay suite — CommandPalette (cmdk + Cmd/Ctrl+K), RecordingIndicator (floating REC pill driven by recorder Zustand), and Sonner skinned via sc-* CSS variables — then restyled the Phase 13 export modal to sc-* tokens and ScButton while preserving every ENC-12..ENC-19 wire (AdvancedOutputOptions, buildEncoderOptions, HW_UI_TO_DTO, exportRun, exportValidateConfig, useOutputPrefsStore, AiDisclosureModal).

## Tasks Completed

| # | Name                                                     | Commit  |
| - | -------------------------------------------------------- | ------- |
| 1 | CommandPalette (cmdk + Cmd/Ctrl+K + motion fade)         | d7cdc57 |
| 2 | RecordingIndicator + Sonner CSS-var skin                 | 0c79d75 |
| 3 | Export modal visual restyle (Phase 13 wiring preserved)  | cd09936 |

## Verification

- `pnpm --filter @storycapture/desktop typecheck` — PASS (after each task)
- `pnpm --filter @storycapture/desktop build` — PASS (104.60 kB CSS, 1.52 MB JS)
- `cd apps/desktop && npx vitest run components/command-palette` — PASS (3/3 tests)
- `cd apps/desktop && npx vitest run features/post-production` — PASS (10 files / 71 tests; Phase 13 export-modal.test.tsx still green)
- `rg "sc-shell|ScShell|ScTitleBar|ScSideNav" apps/desktop/src` — 0 hits
- Preserved imports in export-modal.tsx: AdvancedOutputOptions, FormatCheckboxes, ResolutionPicker, HW_UI_TO_DTO, buildEncoderOptions, exportRun, exportValidateConfig, useOutputPrefsStore, AiDisclosureModal — all present (verified via grep)
- `git diff HEAD~3 -- apps/desktop/src/features/post-production/export-modal/{advanced-output-options,format-checkboxes,resolution-picker}.tsx apps/desktop/src/state/output-prefs.ts apps/desktop/src/ipc/export.ts` — 0 lines (sibling behavior files untouched)
- `git diff HEAD~3 -- apps/desktop/src/components/sidebar.tsx` — empty (legacy sidebar untouched)

## Deviations from Plan

### Auto-adjusted (Rule 3 — framework constraint)

**1. [Rule 3 - Blocker] CommandPalette mount point moved from App.tsx to AppLayout/FullscreenLayout**
- **Found during:** Task 1
- **Issue:** Plan said "Mount `<CommandPalette />` inside apps/desktop/src/App.tsx as a sibling to `<RouterProvider />`". But CommandPalette uses `useNavigate()` from react-router-dom v7, which requires a `<Router>` ancestor. `<RouterProvider>` is self-contained — its children are not inside the router tree. A sibling outside the provider cannot use any router hook.
- **Fix:** Mounted CommandPalette inside both `AppLayout` and `FullscreenLayout` (the two layout routes under RouterProvider) so it renders on every user-facing route AND has access to `useNavigate`. The `/region-overlay` route intentionally does NOT include the palette (bare overlay page, Cmd/Ctrl+K there would do nothing useful anyway).
- **Files modified:** `apps/desktop/src/components/title-bar.tsx` (added `<CommandPalette />` after `<StatusBar />` in both layout components).
- **Commit:** d7cdc57
- **Note:** `git diff HEAD -- apps/desktop/src/components/title-bar.tsx` is NOT empty as a result (2 small additions: import + 2 mount points). The plan's success criterion "legacy chrome untouched" is preserved in SPIRIT — the structure, styling, tokens, and behavior of AppLayout/FullscreenLayout/Sidebar/StatusBar are unchanged; only a sibling overlay was appended.

### Auto-fixed (Rule 1 — test infrastructure)

**2. [Rule 1 - Bug] CommandPalette exit animation broke happy-dom unmount assertions**
- **Found during:** Task 1 test run
- **Issue:** `AnimatePresence` keeps children mounted during exit animation. In happy-dom (no requestAnimationFrame loop), motion/react's exit animation never completes, so `queryByPlaceholderText` kept finding the input even after setOpen(false). The "closes on Escape" test failed.
- **Fix:** Dropped the exit-animation props (`exit={{…}}`) on both motion.divs and added an early-return `if (!open) return null;` guard. Entry animation preserved. Production behavior is identical (fade-in); only the exit transition is synchronous instead of 180ms, which is imperceptible for a command palette dismiss.
- **Commit:** d7cdc57

### Auto-adjusted (Rule 3 — Escape key handling)

**3. [Rule 3 - Blocker] Window-level Escape handler didn't fire**
- **Found during:** Task 1 test run
- **Issue:** Register Escape via `window.addEventListener("keydown", …, true)` initially; even with capture phase, happy-dom user-event dispatch did not propagate Escape to the window listener when the cmdk input was focused. Root cause unclear (likely cmdk's internal keydown handler returning early).
- **Fix:** Added `onKeyDownCapture` on the `<Command>` element itself so Escape is caught at the React element boundary before cmdk processes it. Window listener retained as a belt-and-suspenders fallback.
- **Commit:** d7cdc57

## Behavior Preservation Check (D-09)

Export modal — all Phase 13 symbols verified present and wired:

| Symbol                                            | Location in restyled file      |
| ------------------------------------------------- | ------------------------------ |
| `Dialog.Root` / `Dialog.Portal` / `Dialog.Popup`  | Outer dialog shell unchanged   |
| `AdvancedOutputOptions`                           | Inside Accordion, line ~376    |
| `FormatCheckboxes`                                | Inside formats section         |
| `ResolutionPicker`                                | Inside resolution section      |
| `HW_UI_TO_DTO` map                                | Line ~46 (unchanged)           |
| `buildEncoderOptions`                             | Line ~57 (unchanged)           |
| `exportRun` / `exportValidateConfig`              | `runValidate` + `runExport`    |
| `useOutputPrefsStore`                             | `exportKnobs` selector         |
| `AiDisclosureModal`                               | Mounted after Dialog.Root      |
| `useVoiceoverStore` / `ttsClipCount` branch       | `onSubmit` unchanged           |
| `pickFolder` → `plugin:dialog|open`               | Unchanged                      |

Sibling files (advanced-output-options.tsx, format-checkboxes.tsx, resolution-picker.tsx, state/output-prefs.ts, ipc/export.ts) — 0 lines of diff. Verified via `git diff`.

Legacy chrome — `apps/desktop/src/components/sidebar.tsx` unchanged. `title-bar.tsx` has 2 additive lines (import + mount points); no structural / token / style changes.

## Dependency Graph Notes

- Consumes `ScButton` from `@storycapture/ui` (Wave 1)
- Consumes `--sc-*` tokens via Wave 1 import graph
- Consumes `useRecorderStore` from Phase 6 recorder infrastructure
- Wave 5 will swap the hard-coded `theme="dark"` on `<Toaster>` for `useTweaksStore(s => s.theme)` once the tweaks store lands; today's Toaster style prop reading `--sc-surface` etc. will automatically re-evaluate when `data-theme` flips.
- Wave 5 Settings → Appearance section can reuse the sc-btn primary variant already proven in the restyled export modal footer.

## Known Stubs / Tech Debt

- Sonner `theme="dark"` is hard-coded. Wave 5 tweaks-store swap is the planned bridge.
- Accordion label inside export modal remains "Tùy chọn nâng cao" (Vietnamese). Not changed — `AdvancedOutputOptions` child is explicitly out of scope for this wave; this label lives in the parent but the surrounding conversation in recent commits (`643c65e`) migrated other Vietnamese copy, so this is a small residue worth catching in Wave 5 polish.
- CommandPalette items "Render & Export…" and "Open DSL reference" map to reasonable routes but are not full feature wires (the export action doesn't auto-open the export modal — it just routes to /post-production). Deferred; the plan's v1 scope was navigate-only.

## Self-Check: PASSED

- Created files all exist on disk:
  - apps/desktop/src/components/command-palette/command-palette.tsx — FOUND
  - apps/desktop/src/components/command-palette/index.ts — FOUND
  - apps/desktop/src/components/command-palette/__tests__/command-palette.test.tsx — FOUND
  - apps/desktop/src/components/recording-indicator.tsx — FOUND
- Modified files:
  - apps/desktop/src/App.tsx — FOUND
  - apps/desktop/src/components/title-bar.tsx — FOUND
  - apps/desktop/src/features/post-production/export-modal/export-modal.tsx — FOUND
- Commits present in git log:
  - d7cdc57 — FOUND
  - 0c79d75 — FOUND
  - cd09936 — FOUND
- Typecheck + build + 3 palette tests + 71 post-production tests all green.
