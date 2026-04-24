# Phase 11-04 — Deferred items (out of scope)

## Pre-existing unrelated test failures observed during 11-04 execution

Vitest run at commit `ea20c56` shows 8 failing tests across 3 files that are
unrelated to Phase 11-04 (no Phase 11-04 file touches the failing code paths):

| File                                                    | Failures | Domain              |
| ------------------------------------------------------- | -------- | ------------------- |
| `apps/desktop/src/features/nl-mode/ChatPanel.test.tsx`  | several  | NL-mode chat panel  |
| `apps/desktop/src/features/settings/AccountsPage.test.tsx` | several | Settings / accounts |
| `apps/desktop/src/components/command-palette/__tests__/command-palette.test.tsx` | several | Cmd-K palette   |

Root causes appear to be shifted copy strings (Vietnamese text assertions
on English strings) and route-context setup expectations unrelated to
`preview-panel`, `PreviewPickerButton`, `authorDriverStore`, `codemirror-setup`,
`editor/controller`, `routes/editor.tsx`, or the deleted `pick-element-button`.

These pre-date the Phase 11-04 worktree base (`7771158`) and should be
handled by the team owning those surfaces. Documented here per the
execute-plan `SCOPE BOUNDARY` rule.
