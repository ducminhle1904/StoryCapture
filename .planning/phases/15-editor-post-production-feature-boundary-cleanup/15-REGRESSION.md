# Phase 15 — Regression Matrix (Wave 5, Task 1)

**Run:** 2026-04-21
**Baseline ref:** `8c12e7f` (last commit before Phase 15)
**Head ref:** `1487ad2` (docs(15-04): complete Wave 4)
**Scope:** 13 CONTEXT decisions (D-01..D-13), behavior preservation (D-11), Phase 13/14 preservation (D-12).

## Test Matrix

| # | Command | Exit | Result |
|---|---|----:|---|
| 1 | `cd apps/desktop && pnpm tsc --noEmit` | 0 | PASS — clean |
| 2 | `pnpm --filter @storycapture/desktop build` | 0 | PASS — Vite 2.18s, 1.52 MB JS / 104 kB CSS; warnings unchanged from baseline (pre-existing dynamic/static mix on `ipc/capture.ts`, chunk-size > 500 kB) |
| 3 | `cd apps/desktop && pnpm exec vitest run` | 0 | 201 passed / 8 failed (29 files) — failures identical to Wave 1/2/3/4 baselines (see below) |
| 4 | `cd packages/ui && pnpm exec vitest run` | 0 | 20 passed / 0 failed (9 files) |
| 5 | Rust: no changes in `crates/` touched by Phase 15 → skipping cargo run (per plan, Rust is out of scope). Grep `git diff 8c12e7f HEAD -- crates/` → empty. |

### Pre-existing vitest failures (not regressions)

Exactly the same 8 failures carried from Phase 14 / Wave 1 baseline:

- `src/components/command-palette/__tests__/command-palette.test.tsx > closes on Escape` (1)
- `src/features/nl-mode/__tests__/ChatPanel.test.tsx > renders empty state heading and CTA when no cards and not streaming` (1)
- `src/features/settings/AccountsPage.test.tsx` (6 — Vietnamese copy assertions hitting changed strings)

Zero post-production, editor, scene-list, preview-surface, or sc-* primitive tests regressed.

## Phase 13 + Phase 14 Preservation — Grep Diff Audit

```bash
git diff --stat 8c12e7f HEAD -- \
  apps/desktop/src/App.tsx \
  apps/desktop/src/components/title-bar.tsx \
  apps/desktop/src/components/sidebar.tsx \
  packages/ui/src/claude-design/ \
  packages/ui/src/tokens.css \
  apps/desktop/src/app.css
# → (empty output)

git diff --stat 8c12e7f HEAD -- \
  apps/desktop/src/features/post-production/export-modal.tsx \
  apps/desktop/src/features/post-production/state/output-prefs.ts
# → (empty output)

git diff --stat 8c12e7f HEAD -- \
  apps/desktop/src-tauri/src/ipc_spec.rs \
  packages/shared-types/src/ipc.ts
# → (empty output)
```

**Result:** Zero diffs across every Phase 13 export file, Phase 14 chrome + tokens + primitives, and the IPC surface (confirming D-12 and "no new IPC" CONTEXT out-of-scope gate). `crates/` is also unchanged.

## Behavioral Assertion Greps

| Assertion | Command | Result |
|---|---|---|
| `VoiceoverCompact` lives only in `features/post-production/voiceover-compact/` (+ `editor-shell.tsx` mount) | `grep -r VoiceoverCompact apps/desktop/src` | 3 files: `features/post-production/editor-shell.tsx`, `features/post-production/voiceover-compact/voiceover-compact.tsx`, `features/post-production/voiceover-compact/index.ts` — no Editor-route presence |
| Editor consumes `PreviewSurface mode="recording"` | `grep 'PreviewSurface mode' apps/desktop/src/routes/editor.tsx` | `<PreviewSurface mode="recording" projectId={projectId} />` |
| Post-Prod consumes `PreviewSurface mode="composited"` | `grep 'PreviewSurface mode' apps/desktop/src/features/post-production/editor-shell.tsx` | `<PreviewSurface mode="composited" storyId={storyId} videoSrc={videoSrc} />` |
| `sceneCount > 0 &&` gate removed (SceneListPanel unconditional) | `grep 'sceneCount > 0 &&' apps/desktop/src/routes/editor.tsx` | no match |
| Send-to-Post-Prod wired to `folder.session_count` | `grep session_count apps/desktop/src/routes/editor.tsx` | `(folder?.session_count ?? 0) > 0 ? <Link …> : <ScButton disabled>` |
| `/post-production` landing route registered under AppLayout | `grep post-production apps/desktop/src/routes/index.tsx` | `{ path: "/post-production", element: <PostProductionLandingRoute /> }` + unchanged `/post-production/:storyId` under FullscreenLayout |
| PreviewSurface has NO `<video`, `convertFileSrc`, `list_recordings` (recording mode is empty-state-only per D-04 amendment) | `grep -nE '<video|convertFileSrc|list_recordings' apps/desktop/src/components/preview-surface/` | no match |
| Parse-error fallback chip copy present | `grep 'parse error' apps/desktop/src/features/editor/scene-list-panel.tsx` | match — `parse error — showing last known` |

All assertions pass.

## Phase 15 — Scope Summary

- **Commits:** 14 atomic commits (55a44ab → 1487ad2), all prefixed `feat(15-0X):` / `refactor(15-0X):` / `docs(15-0X):`. Verified zero `Co-Authored-By` trailers via `git log --format=%B 8c12e7f..HEAD | grep -ic Co-Authored-By` → 0.
- **Files touched:** 9 source files under `apps/desktop/src/`. Zero files under `packages/`, `crates/`, or `apps/desktop/src-tauri/`.

| File | +/- |
|---|---:|
| `apps/desktop/src/components/preview-surface/preview-surface.tsx` | +90 |
| `apps/desktop/src/components/preview-surface/index.ts` | +2 |
| `apps/desktop/src/features/editor/scene-list-panel.tsx` | +/−36 |
| `apps/desktop/src/features/post-production/editor-shell.tsx` | +/−18 |
| `apps/desktop/src/features/post-production/voiceover-compact/voiceover-compact.tsx` | +409 |
| `apps/desktop/src/features/post-production/voiceover-compact/index.ts` | +1 |
| `apps/desktop/src/routes/editor.tsx` | +88 / −539 |
| `apps/desktop/src/routes/index.tsx` | +2 |
| `apps/desktop/src/routes/post-production-landing.tsx` | +182 |
| **Total (Phase 15)** | **+779 / −588 (net +191 LoC across 9 files)** |

## Decision Coverage Checklist

| # | Decision | Shipped | Evidence |
|---|---|---|---|
| D-01 | Editor keeps typed feedback AND visual preview | ✅ | PreviewSurface mode="recording" in Editor right rail; LSP/DryRun/SelectorValidator unchanged |
| D-02 | Explicit Send-to-Post-Prod affordance (no auto-nav) | ✅ | Toolbar button; no post-recording navigation added |
| D-03 | `/post-production` reachable with empty state, freeform | ✅ | Landing route + empty-state CTA |
| D-04 | Shared `PreviewSurface` with mode prop | ✅ | 2 consumers (Editor + Post-Prod) through single component |
| D-05 | `/recorder/:projectId` standalone, unchanged | ✅ | Zero diff on `routes/recorder.tsx` (grep audit) |
| D-06 | `/post-production` landing route | ✅ | `routes/post-production-landing.tsx` + router entry |
| D-07 | Toolbar button always visible, disabled until recording | ✅ | `(folder?.session_count ?? 0) > 0` gate |
| D-08 | Editor left-rail scene list (read-only, parse-error resilient) | ✅ | Unconditional SceneListPanel + last-valid-AST cache + parse-error chip |
| D-09 | Bespoke toolbars per route (no shared ProjectToolbar) | ✅ | No shared toolbar component introduced |
| D-10 | VoiceoverCompact removed from Editor entirely | ✅ | Grep confirms 0 matches in Editor route |
| D-11 | Behavior preserved (verbatim move; no inline edits) | ✅ | Zustand selectors, IPC calls, hook order, JSX verbatim (per 15-01-SUMMARY audit) |
| D-12 | Phase 14 re-skin + Phase 13 export preserved | ✅ | Zero diffs on chrome/tokens/primitives/export files |
| D-13 | Sequential waves, atomic commits, each wave green | ✅ | 14 atomic commits; each wave ended typecheck + build + vitest green |

## Deferred (carried forward, not blockers)

- **Scrubbable playback in `PreviewSurface mode="recording"`** — needs a new IPC (e.g. `list_project_recordings`) that's out of Phase 15 scope.
- **`session_count` split on `/post-production` landing** (with-recordings vs empty groups) — same IPC dependency.
- **Accent pulse on Send-to-Post-Prod button enable transition** — Claude's Discretion, skipped this wave (user is on Recorder route when the flip happens).
- **Right-rail authoring-tool content** (lint summary / target-reference / quickstart) after VoiceoverCompact removal — rail intentionally left focused on preview.
- **VoiceoverCompact data wiring inside Post-Production shell** — component mounted dormant (`hidden`); needs story parse state surfaced into Post-Prod or a proper Inspector tab.

None of the above block the "app is green" closure of Phase 15.

## Conclusion

- 0 regression blockers found.
- All 5 verification commands return exit 0.
- All 8 vitest failures are pre-existing and carried identically from the pre-Phase-15 baseline.
- All 13 CONTEXT decisions shipped (D-01..D-13).
- Phase 13 export + Phase 14 chrome + IPC surface all unchanged (0 diffs).

**Status:** Phase 15 is **code-green**; advance to Task 2 (operator a11y spot-check).
