# Phase 2 Plan 12b — RESUME (checkpoint pending)

**Plan:** 02-12b
**Status:** Tasks 1 + 2 complete and committed. Task 3 is a blocking
`checkpoint:human-verify` gate — **awaiting operator walk-through**.

## Completed work

| Task | Name | Commit | Tests |
| ---- | ---- | ------ | ----- |
| 1 | Editor shell + 5-track timeline + preview + inspector + sound drawer | `9a2879b` | `timeline.test.tsx` (4/4) |
| 2 | Export modal + render queue widget + progress channel | `a6a22bf` | `export-modal.test.tsx` (3/3) |

Full gate matrix:

| Check | Result |
| ----- | ------ |
| `pnpm --filter @storycapture/desktop typecheck` | PASS (exit 0) |
| `pnpm --filter @storycapture/desktop exec vitest run src/features/post-production/` | PASS — 29/29 |
| Task 1 acceptance greps (A1-A6) | 6/6 PASS |
| Task 2 acceptance greps (B1-B5) | 5/5 PASS |

## What the checkpoint verifies (Task 3 — operator)

**Run:** `pnpm --filter @storycapture/desktop tauri dev`

Open an existing Phase 1 project (create one via Dashboard if none exist),
then navigate to `/post-production/<story-id>`.

### Steps

1. **Scrub at 60 fps (no jank).** DevTools → Performance. Drag playhead across
   the full duration for ~10 s. Expect sustained ~60 fps (frame time ≤ 16.6 ms)
   on reference hardware. Console should log the active backend (`webgpu`
   preferred, `webgl2` fallback).
2. **Apply 3 presets.** Inspector → Presets tab. Apply three bundled presets
   in sequence; preview should reflect change within ~500 ms each.
3. **Export MP4 + WebM + GIF.** Open Export drawer. Check MP4, WebM, GIF.
   1080p, 60 fps, Medium. GIF should trigger Plan 11 validator warning
   (auto-fallback to 720p30). Pick a folder. Click Export. Queue badge
   should show 3. Open each emitted file (QuickTime / VLC / browser).
4. **Undo/redo.** Perform 5 undoable actions (move clip, trim clip, apply
   preset, drag BGM, change overlay). cmd+z × 5 → state reverts in order.
   cmd+shift+z × 5 → re-applies in order. *Note:* Plan 13 owns the real
   history buffer; the undo-bridge today is a pass-through. If cmd+z does
   nothing, the checkpoint is still gated on P13's history landing. Call
   this out in the resume signal.
5. **Accessibility smoke.** Tab through timeline — every clip shows a visible
   focus ring. VoiceOver (mac) or NVDA (win) announces clips with the
   `Cursor clip at 12.50s, 3.20s duration` pattern.

## Known deferrals / dependencies for the checkpoint

- **Real source video.** `PostProductionRoute` does not yet resolve a
  recording path. The preview canvas will be black until the Phase 1
  recording IPC (`project_get_recording_path` or equivalent) is threaded
  through. Operator workaround: set `videoSrc` prop manually in
  `post-production.tsx` before starting `tauri dev`, or load any local
  MP4 via `convertFileSrc`.
- **Undo/redo (Step 4).** P13's history-ring replaces `undo-bridge.ts`;
  P12b wired the hotkeys but the effect is a no-op until P13 lands.
- **Real AST graph.** Export modal submits `graph_json: "{}"`; Plan 13's
  `computeGraph()` on the store replaces this.

## Deferred out-of-scope items

None logged in `deferred-items.md` for this plan. The above three are
**expected** cross-plan handoffs, not defects.

## Resume signal

Operator types `approved` if all 5 steps pass (with noted deferrals
accepted), or describes failures to spawn a patch plan via
`/gsd-plan-phase --gaps`.
