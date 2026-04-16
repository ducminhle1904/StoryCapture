---
phase: 03-intelligence-layer-ai-authoring-voiceover
plan: 18
subsystem: editor, ui
tags: [react, zustand, dry-run, selector-fallback, tauri-ipc, motion, phase3]
requires:
  - phase: 03-intelligence-layer-ai-authoring-voiceover/14
    provides: LSP integration + gutter markers
  - phase: 03-intelligence-layer-ai-authoring-voiceover/16
    provides: Dry-Run backend (dryrun_start / dryrun_cancel Tauri commands)
provides:
  - DryRunPanel bottom drawer component with per-step status rows
  - DryRunStepRow component with status badge + timing + fallback chain chips
  - SelectorFallbackPopover with winning strategy display + "Cap nhat selector" CTA
  - dryRunStore Zustand store for dry-run state management
  - useDryRun hook wiring dryrun_start / dryrun_cancel via Tauri Channel
affects:
  - Phase 3 editor integration -- DryRunPanel embeds below story editor
  - Phase 3 eval harness (Plan 21) -- can verify dry-run UI renders events correctly
tech-stack:
  added: []
  patterns:
    - "Tauri Channel<DryRunEvent> subscription pattern: Channel.onmessage dispatches to Zustand handleEvent"
    - "Esc hold 400ms destructive cancel pattern per UI-SPEC destructive table"
    - "Arrow key row navigation with focused index state in panel components"
key-files:
  created:
    - apps/desktop/src/features/editor/dryRunStore.ts
    - apps/desktop/src/features/editor/useDryRun.ts
    - apps/desktop/src/features/editor/DryRunPanel.tsx
    - apps/desktop/src/features/editor/DryRunStepRow.tsx
    - apps/desktop/src/features/editor/SelectorFallbackPopover.tsx
    - apps/desktop/src/features/editor/dryRunStore.test.ts
    - apps/desktop/src/features/editor/DryRunPanel.test.tsx
  modified: []
key-decisions:
  - "Unicode escape sequences for Vietnamese UI copy -- ensures consistent rendering across all environments without file encoding issues"
  - "DryRunEvent uses snake_case fields (step_id, duration_ms, fallback_chain) to match Rust serde defaults from backend"
  - "Panel auto-opens on Summary event to surface results immediately after dry-run completes"
  - "motion/react animate on DryRunStepRow for 160ms easeInOut background transition per UI-SPEC motion spec"
requirements-completed: [UI-07, AI-04, AI-06]
duration: ~5 min
completed: 2026-04-16
---

# Phase 03 Plan 18: Dry-Run UI + Selector Fallback Popover Summary

**Editor-side Dry-Run bottom drawer panel with per-step status/timing/fallback-chain rows, Zustand store + Channel subscription hook for dryrun_start/dryrun_cancel IPC, and LSP selector-fallback HoverCard popover with winning strategy display.**

## Performance

- **Duration:** ~5 min
- **Tasks:** 2 (both TDD)
- **Commits:** 2 (`2322a2b` store+hook, `4ba7d9c` components)
- **Files created:** 7 (2 store/hook, 3 components, 2 test files)
- **Files modified:** 0

## What Was Built

**Task 1 -- dryRunStore + useDryRun hook (`dryRunStore.ts`, `useDryRun.ts`).**

- **`dryRunStore`** -- Zustand store tracking: `taskId`, `statusByStep` (queued/running/pass/fail/skipped), `timingByStep`, `fallbackChainByStep` (array of SelectorAttempt), `summary` (total/passed/failed/totalMs), `panelOpen`.
- **`handleEvent(ev)`** -- dispatches DryRunEvent by kind (Queued, Running, Pass, Fail, Skipped, Summary) into store state. Summary event auto-opens panel.
- **`useDryRun(projectId)`** -- hook returning `start(steps)`, `cancel()`, `state`. Start creates a `Channel<DryRunEvent>`, wires `onmessage` to `handleEvent`, invokes `dryrun_start` Tauri command. Cancel invokes `dryrun_cancel` with stored `taskId`.
- **5 unit tests:** Queued sets status, Pass updates status+timing+chain, Fail persists chain, Summary populates summary, cancel() calls dryrun_cancel.

**Task 2 -- DryRunPanel + DryRunStepRow + SelectorFallbackPopover components.**

- **`DryRunPanel`** -- Bottom drawer with:
  - Header: title + "Chay thu" accent button (idle) / "Huy" destructive button (running)
  - Body: ScrollArea with DryRunStepRow list or empty state ("Chua co lan chay thu nao")
  - Footer: summary stats (X pass / Y fail / Zms total)
  - Keyboard: Cmd+Shift+D starts dry-run; Esc hold 400ms cancels (morphs button text to "Giu de huy...")
  - Accessibility: `role="region"`, `aria-labelledby`, arrow key row navigation
- **`DryRunStepRow`** -- Row with step number, status badge (color-coded per UI-SPEC), label, timing, fallback chain chips (green=succeeded, muted=failed with tooltip). Click handler fires `onStepClick`. motion/react 160ms easeInOut background animation for running state.
- **`SelectorFallbackPopover`** -- Tooltip-style card showing "Selector qua chung" warning, winning strategy info ("strategy N thang trong Xms"), fallback chain chips, and "Cap nhat selector" CTA button.
- **6 component tests:** Empty state copy, step row badges, start button click, step row click, keyboard nav (arrows+Enter), popover copy+CTA.

## Decisions Made

1. **Unicode escape sequences** for Vietnamese copy -- avoids file encoding issues across editors/CI.
2. **snake_case DryRunEvent fields** -- matches Rust serde defaults from the dryrun backend (Plan 16).
3. **Auto-open panel on Summary** -- ensures users see results without manual panel toggle.
4. **160ms easeInOut row animation** -- matches UI-SPEC motion table for gutter status transitions.

## Task Commits

| Task | Message | Hash |
|---|---|---|
| 1 | `feat(03-18): dryRunStore + useDryRun hook with Channel subscription` | `2322a2b` |
| 2 | `feat(03-18): DryRunPanel + DryRunStepRow + SelectorFallbackPopover components` | `4ba7d9c` |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Removed unused React import from SelectorFallbackPopover.**
- **Found during:** Task 2 typecheck.
- **Issue:** `import * as React from "react"` was unused, causing TS6133 error.
- **Fix:** Removed the import.
- **Files modified:** `SelectorFallbackPopover.tsx`.
- **Commit:** `4ba7d9c`.

---

**Total deviations:** 1 auto-fixed (Rule 1 -- unused import). All plan acceptance criteria pass.

## Verification

```bash
npx vitest run src/features/editor/dryRunStore.test.ts   # 5/5 passed
npx vitest run src/features/editor/DryRunPanel.test.tsx   # 6/6 passed
```

**Task 1 acceptance criteria:**
- All 5 tests green - PASS
- `grep -c "dryrun_start\|dryrun_cancel" useDryRun.ts` -> 2 (>= 2) - PASS

**Task 2 acceptance criteria:**
- All 6 tests green - PASS
- Empty state copy present - PASS (unicode escape verified in test)
- "Chay thu" copy present - PASS (unicode escape verified in test)
- "Cap nhat selector" CTA present - PASS (unicode escape verified in test)

## Threat Register Disposition

| Threat ID | Disposition | Evidence |
|---|---|---|
| T-03-18-01 (Tampering / XSS via error message) | mitigated | All dynamic content rendered via React text nodes (JSX expressions); no innerHTML/dangerouslySetInnerHTML used anywhere. No `react/no-danger` violations. |
| T-03-18-02 (Info Disclosure / fallbackChain echoes selectors) | accepted | User-authored selectors displayed to the same user; no cross-user exposure. |

## Known Stubs

None. All components are fully functional with real store integration and IPC wiring.

## Threat Flags

None. No new network endpoints, auth paths, or schema changes. All components are IPC-only (webview-to-host via existing dryrun_start/dryrun_cancel commands).

## Issues Encountered

None beyond the auto-fixed unused import.

## Authentication Gates

None -- all tests use mocked Tauri IPC. No API keys or auth flows involved.

## Next Plan Readiness

- **Editor integration:** DryRunPanel can be embedded below the StoryEditor via the split-pane layout. Wire `useDryRun(projectId)` to get `start`/`cancel` callbacks and pass to DryRunPanel props.
- **LSP gutter integration:** SelectorFallbackPopover can be triggered from CodeMirror gutter widgets (Plan 14's `storyLanguageExtension`) via custom widget rendering.
- **Eval harness (Plan 21):** Can render DryRunPanel with mocked store state to verify UI behavior end-to-end.

## Handoff Notes

- `useDryRun` returns `state` which is the full Zustand store. Components should use `useDryRunStore` directly for selective subscriptions to avoid unnecessary re-renders.
- `DryRunEvent.kind` uses PascalCase variants matching the Rust enum serialization (`#[serde(tag = "kind")]`).
- The panel has `min-h-[120px] max-h-[40vh]` constraints per UI-SPEC. A resizable handle is not yet wired (would need shadcn `resizable` integration in the parent layout).
- Keyboard shortcut `Cmd+Shift+D` is registered at window level. If conflicts arise with other shortcuts, scope it to the editor panel container.

## Self-Check: PASSED
