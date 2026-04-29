# Phase 23 — Click Events + Auto-Zoom

**Status:** PROPOSED
**Date drafted:** 2026-04-28
**Depends on:** Phase 19-02 (trajectory recorder)
**Blocker level:** 🟢 Enhancement — not blocking E2E ship; rounds out Phase 19-02 + 19-03 deferrals

## Why this exists

Phase 19-02 ships trajectory recording but `TrajectoryFrame.click: bool` is always false (deferred per its commit message). Phase 19-03 ships Story → Timeline producer but skips auto-zoom because timing-based zoom heuristic was unreliable without click events.

This phase closes both deferrals: capture real click events during recording, then derive ZoomClip auto-population from them.

## Goal

`TrajectoryFrame.click` is true at frames where a real OS click happened. `buildTimelineFromStory` emits a ZoomClip per click that visually highlights the click position.

## Acceptance criteria

1. **AC1** — During recording, OS click events (left + right mouse button) are captured. The trajectory frame at click time has `click: true`.
2. **AC2** — `buildTimelineFromStory` derives ZoomClips from click frames: each click produces 1 ZoomClip with start = click_t - 200ms, end = click_t + 600ms, scale 1.3, center on (x, y) at click time, preset CALM.
3. **AC3** — Debounce: clicks within 800ms of a prior click are merged (skip duplicate ZoomClips).
4. **AC4** — Existing trajectory tests still pass. New tests verify click capture + auto-zoom emission.
5. **AC5** — Window-target captures: clicks outside the captured window are NOT recorded (they would shift the trajectory off-canvas).
6. **AC6** — `cargo check --workspace` + `cargo test -p capture` + `pnpm typecheck` + `pnpm vitest run build-timeline-from-story` PASS.

## Architecture decisions

**D-1 LOCKED: OS-level click capture, not browser-level.**
- macOS: `CGEventTap` on `kCGSessionEventTap` for `kCGEventLeftMouseDown` + `kCGEventRightMouseDown`. Run in background thread.
- Windows: `SetWindowsHookEx` with `WH_MOUSE_LL`. Filter on `WM_LBUTTONDOWN` + `WM_RBUTTONDOWN`.
- Reasoning: OS-level catches clicks anywhere on screen, including outside the automated browser. Same level as cursor position polling in Phase 19-02 (consistent abstraction).

**D-2 LOCKED: Click events stored alongside trajectory frames, not separately.**
- Existing `TrajectoryFrame.click: bool` field gets populated. No schema change.
- Implication: click is associated with the polled cursor position at the nearest 60Hz tick (max 16.67ms drift). Acceptable for zoom timing.

**D-3 LOCKED: Auto-zoom heuristic v1.**
- Window: `[click_t - 200ms, click_t + 600ms]` = 800ms total.
- Scale: 1.3 (modest zoom, doesn't disorient).
- Center: `(x, y)` from the click frame.
- Preset: CALM.
- Debounce: skip clicks within 800ms of a prior emitted ZoomClip (prevents zoom-on-zoom for rapid clicks like double-click or drag).

## Plan breakdown — 2 plans, sequential

### Plan 23-01 — OS click event capture

**Files:**
- EDIT `crates/capture/src/macos/cursor.rs` — add `pub fn install_click_tap() -> Result<ClickTap, ClickTapError>`. Returns a handle that holds the CGEventTap. On drop, removes the tap. Spawns a background CFRunLoop (or attaches to existing).
- EDIT `crates/capture/src/windows/cursor.rs` — analogous `install_click_hook` using `SetWindowsHookEx`.
- EDIT `crates/capture/src/trajectory.rs` — `TrajectoryRecorder::start` now also installs the click tap. Pass click events to the sample loop via `Arc<AtomicBool>` (latest-click-pending flag — set to true when click happens, consumed at next sample tick).
- EDIT `crates/capture/Cargo.toml` — may need additional macOS deps (`core-foundation`, `objc2-core-foundation` — likely already present via core-graphics).

**Click → frame association strategy:**
- When a click event arrives, set `latest_click_at: AtomicU64` to current millis.
- At each sample tick (60Hz), if `latest_click_at > prev_tick_time`, mark this frame's `click: true`. Reset `latest_click_at` to 0 (atomic swap).
- Edge case: 2 clicks in 1 tick → only 1 marked. Acceptable for v1.

**Tests:**
- Unit: `install_click_tap` returns Ok on supported OS, can be installed + removed without panic.
- Integration test (macOS-only, gated by feature flag): post a synthetic click via CGEventCreateMouseEvent, verify trajectory recorder picks it up.

**Risks:**
- macOS Accessibility permission (TCC) required for global event taps. Handle gracefully: log warning if permission denied, skip click capture (trajectory still records positions).
- Windows global hooks are slow if hook callback does heavy work; keep hook minimal (just set atomic flag).

**Estimate:** 1.5-2h.

### Plan 23-02 — Auto-zoom heuristic in producer

**Files:**
- EDIT `apps/desktop/src/features/post-production/state/build-timeline-from-story.ts`:
  - Add zoom emission: walk `trajectory.frames`, find ones with `click: true`. Apply 800ms debounce. Emit one `ZoomClip` per surviving click.
  - Output shape: `BuildTimelineOutput.zoom: ZoomClip[]` (currently only video + cursor; extend output type).
- EDIT `apps/desktop/src/features/post-production/editor-shell.tsx` — wire zoom into `setTracks` call.
- EDIT `apps/desktop/src/features/post-production/__tests__/build-timeline-from-story.test.ts` — add tests:
  - Trajectory with 0 clicks → 0 zoom clips.
  - Trajectory with 3 clicks at t=1000, 5000, 10000 → 3 zoom clips at expected times.
  - Trajectory with 2 clicks at t=1000, 1500 (within 800ms debounce) → 1 zoom clip (the first).
  - Determinism: same input → same output (UUID hash on click t_ms).

**Estimate:** 1-1.5h.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| TCC permission for CGEventTap is denied | High on first run | click capture silently fails | Log + degrade gracefully; document TCC prompt in user-facing onboarding (Phase 25) |
| 60Hz sampling miss-aligns with click event | Low | 16ms drift visible? | Acceptable for v1; precise alignment is a Phase 24 concern |
| Auto-zoom feels intrusive (every click → camera move) | Medium | UX feedback | Operator-tune via Phase 21 walkthrough; expose toggle in Phase 25 polish |
| Window-target capture: click outside captured window emits ZoomClip with off-canvas center | Medium | broken render | Filter clicks: only mark `click: true` if (x, y) falls within `capture_rect` |

## Out of scope

- Click visualization on cursor overlay (ripple, scale-up). Future polish.
- Differentiating left vs right click for different zoom behavior.
- Detecting drag (mouse-down + move + mouse-up sequence) for different highlight.
- Manual disable / threshold tweak in Settings UI.

## Estimated total

- 23-01: 1.5-2h
- 23-02: 1-1.5h
- **Total: 2.5-3.5h**

Sequential — 23-02 depends on click events from 23-01.
