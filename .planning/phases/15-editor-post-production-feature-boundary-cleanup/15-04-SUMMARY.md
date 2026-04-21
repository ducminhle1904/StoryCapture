---
phase: 15-editor-post-production-feature-boundary-cleanup
plan: 04
subsystem: editor
tags: [phase-15, editor, toolbar, scene-list, handoff, wave-4]
wave: 4
requires: [15-01, 15-02, 15-03]
provides:
  - "Send to Post-Production toolbar button wired to /post-production/:projectId"
  - "Always-visible SceneListPanel with parse-error resilience"
affects:
  - apps/desktop/src/routes/editor.tsx
  - apps/desktop/src/features/editor/scene-list-panel.tsx
tech-stack:
  added: []
  patterns: [last-valid-ast-cache-via-useref, dual-link-vs-button-for-disabled-handoff]
key-files:
  created: []
  modified:
    - apps/desktop/src/routes/editor.tsx
    - apps/desktop/src/features/editor/scene-list-panel.tsx
decisions:
  - "Disabled state uses ScButton (Link cannot be disabled); enabled state uses plain anchor <Link className='sc-btn sm'> mirroring the Record link pattern. '.sc-btn.secondary' does not exist in claude-design/app.css — base .sc-btn is the 'secondary' look."
  - "Accent pulse animation on button-enable transition deferred (Claude's Discretion per plan)."
  - "Last-valid AST cached via useRef (not useState) to avoid an extra render on every parse success — cache update is a side-effect read, render reads ref."
metrics:
  duration: "~25m"
  completed_date: "2026-04-21"
  tasks_completed: 2
  commits: 2
---

# Phase 15 Plan 04: Editor additions (Wave 4) Summary

**One-liner:** Add Send-to-Post-Production toolbar button (disabled until a recording exists) and drop the `sceneCount > 0` gate on SceneListPanel with a last-valid-AST parse-error fallback.

## What shipped

### Task 1 — Send to Post-Production toolbar button (D-02, D-07)

`apps/desktop/src/routes/editor.tsx` right-side action cluster (after Record):

```tsx
{(folder?.session_count ?? 0) > 0 ? (
  <Link
    to={`/post-production/${projectId}`}
    className="sc-btn sm"
    aria-label="Send to Post-Production"
  >
    <Scissors size={12} aria-hidden="true" />
    Post-Production
  </Link>
) : (
  <ScButton
    size="sm"
    disabled
    icon={<Scissors size={12} aria-hidden="true" />}
    aria-label="Send to Post-Production"
    title="Record a story first"
  >
    Post-Production
  </ScButton>
)}
```

- Button is always rendered when `projectId` is present (D-07 always-visible).
- Disabled when `folder?.session_count === 0` or `folder` is null.
- Enabled navigates to `/post-production/${projectId}` via React Router `<Link>`.
- Uses `Scissors` from `lucide-react` for parity with the sidebar + Post-Production shell.
- No new IPC; reuses the existing `fetchProjectFolder` call that already populates `folder` on Editor mount.

### Task 2 — Unconditional SceneListPanel + parse-error fallback (D-08, D-11)

`routes/editor.tsx`:
- Dropped the `{sceneCount > 0 && ( ... )}` wrapper around the scene-list `Panel` + `PanelResizeHandle`. The rail mounts unconditionally.
- Removed the now-unused `sceneCount` local and the `sceneCount > 0 ? 54 : 62` / `sceneCount > 0 ? 34 : 38` ternaries on sibling panel `defaultSize` — panels use fixed sizes now that the left rail is always present.

`features/editor/scene-list-panel.tsx`:
- Added `useRef<Story | null>(null)` last-valid-AST cache. Updated in render whenever `currentAst && !hasParseError`.
- `renderAst = currentAst && !hasParseError ? currentAst : lastValidAstRef.current` — stale tree shown while current source has an error diagnostic.
- `showStaleChip = hasParseError && lastValidAstRef.current !== null` renders `<ScBadge tone="warn">parse error — showing last known</ScBadge>` in the header in place of the scene-count pill.
- Empty-state copy refined to "No scenes yet. Add `scene "..."` blocks to your script."
- `layoutId="scene-list-active-pill"` motion pill, click-to-jump handler, existing `useEditorStore` selector, and the `ChevronRight` / active-dot motion bits are preserved verbatim (D-11).

## Deviations from Plan

### Rule 1 — Disabled-state class token

- **Plan suggested** `className="sc-btn secondary sm"` for the enabled Link.
- **Reality:** `packages/ui/src/claude-design/app.css` defines `.sc-btn` (base / secondary look), `.sc-btn.primary`, `.sc-btn.ghost`, `.sc-btn.danger`, `.sc-btn.success`, `.sc-btn.sm`. There is **no `.secondary` modifier** — the bare `.sc-btn` already IS the secondary visual.
- **Fix:** Used `className="sc-btn sm"` on the enabled Link. Matches the Record link's `className="sc-btn primary sm"` cadence.
- **Files:** `apps/desktop/src/routes/editor.tsx`
- **Commit:** ce7e8cb

### Rule 2 — Chip placement minor refactor

- Plan said "render a small chip in the panel header". When the chip is visible, it replaces the scene-count pill (`{scenes.length > 0 && !showStaleChip && ...}`) rather than rendering alongside it — avoids double-right-aligned noise in the 180-px-narrow header.

## Deferred Enhancement

- **Accent pulse on button-enable transition (D-07 optional).** Plan listed this as Claude's Discretion. Skipped this wave — the enabled/disabled Scissors button gives enough affordance and the `session_count === 0 → > 0` transition happens out of view (user is on the Recorder route when it flips). Future enhancement: tie a one-shot pulse class via `useRef` + `useEffect` watching `folder?.session_count` to fire once when it transitions from 0 to non-zero on the active Editor.

## Verification

- `pnpm tsc --noEmit` (apps/desktop) — **PASS** (exit 0).
- `pnpm --filter @storycapture/desktop build` — **PASS** (Vite 2.08s build, 1.52 MB JS / 104 kB CSS, warnings unchanged from baseline).
- `pnpm exec vitest run` — **201/209 pass, 8 pre-existing failures** (command-palette + 2 other suites; baseline preserved from Wave 3 per 15-03-SUMMARY.md).
- Grep checks (all pass):
  - `grep Scissors src/routes/editor.tsx` → match
  - `grep '/post-production/${projectId}'` → match
  - `grep session_count src/routes/editor.tsx` → match
  - `! grep 'sceneCount > 0 &&' src/routes/editor.tsx` → no match (gate removed)
  - `grep 'parse error' src/features/editor/scene-list-panel.tsx` → match
  - `grep lastValidAstRef src/features/editor/scene-list-panel.tsx` → match

## Commits

- `ce7e8cb` — feat(15-04): add Send to Post-Production toolbar button
- `7f5856c` — feat(15-04): scene list always visible + parse-error fallback

## Preservation audit (D-11, D-12)

- Every CodeMirror extension wired through `StoryEditor` — untouched.
- LSP bridge, autosave `writeTextFile`, `parseStory` call site, `resetProjectState`, `setSource`, `setLastParse` — untouched.
- Zustand selectors in `SceneListPanel` — same two reads (`lastParse.ast`, `lastParse.diagnostics`), no new slices.
- Phase 13 export + Phase 14 `.sc-*` tokens + legacy chrome — untouched (two files modified in this wave, both editor-only).
- `layoutId="scene-list-active-pill"` motion pill, active-dot motion — verbatim.
- Timeline + Preview panels — untouched.

## Self-Check: PASSED

- `apps/desktop/src/routes/editor.tsx` — FOUND
- `apps/desktop/src/features/editor/scene-list-panel.tsx` — FOUND
- commit `ce7e8cb` — FOUND
- commit `7f5856c` — FOUND
