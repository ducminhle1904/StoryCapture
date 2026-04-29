# Phase 25 — Post-Production Polish

**Status:** PROPOSED
**Date drafted:** 2026-04-28
**Depends on:** Phase 22 (cinematic UI) optional, otherwise none
**Blocker level:** 🟢 Polish — last-mile UX improvements, none individually critical

## Why this exists

Phase 18-24 close the major functional gaps. This phase is a bag of small UX improvements that round out post-prod for daily use. None individually blocks a v1 ship; cumulatively they distinguish "works" from "feels good".

## Goal

5 polish items shipped as small atomic commits. Acceptance per item, not phase-level.

## Polish items

### Item 1 — Persist clip edits across sessions

**Why:** Phase 18-B persisted export form. But user edits to the timeline (move, trim, add clip, set effect param) are lost on app reload. Auto-population (Phase 19-03) repopulates from scratch.

**Scope:**
- Extend Zustand persist allowlist in `state/store.ts` to include `tracks` (subset of fields — exclude `playheadMs`, `selectedClipId` which are transient).
- Bump persist `version` (currently 2 → 3). Add migrate fn to drop persisted tracks if shape changed (Phase 19-01 union introduction).
- Phase 19-03 one-shot guard (`tracks.video.length === 0`) means re-mount with persisted tracks → no re-populate. Correct behavior preserved.

**Estimate:** 30 min.

**Acceptance:** Make timeline edits, reload app, edits survive.

### Item 2 — Story parse error surfaces in post-prod

**Why:** Phase 19-03's `parseStory` failure is silently caught. User sees no indication their .story is broken — only "no auto-populated cursor" symptom.

**Scope:**
- EDIT `editor-shell.tsx` parse effect: on `parseStory` reject, set local error state.
- Render a non-blocking banner above timeline: "Story parse error — please fix in editor before exporting" + link to `/editor/<storyId>`.
- Don't block export (video clip can still render).

**Estimate:** 30 min.

**Acceptance:** Open post-prod with broken .story, see banner + link.

### Item 3 — Render queue actions: cancel, retry, error inline

**Why:** Phase 18-B render queue widget shows progress but no actions on failed jobs. Currently user can only restart the export from scratch.

**Scope:**
- EDIT `apps/desktop/src/features/post-production/render-queue/queue-widget.tsx`:
  - Per-job: "Cancel" button while running (calls existing `renderCancel(jobId)` IPC).
  - On failure: "Retry" button (re-submits with same `graph_json` + `outputs`).
  - Error message renders inline (currently truncated / hidden).
- EDIT IPC if needed: `render_retry(job_id)` may not exist; check existing surface. If missing, retry = re-submit via `exportRun`.

**Estimate:** 1h.

**Acceptance:** Failed export shows error message + Retry button. Retry re-runs with same args.

### Item 4 — Window-target capture rect: real window-origin lookup

**Why:** Phase 19-02 commit notes: "Window targets fall back to (0,0,frame_w,frame_h) — per-platform window-origin lookup is a follow-up". Current consequence: cursor positions are off by the window's screen-origin, so cursor renders at wrong place for window captures.

**Scope:**
- EDIT `apps/desktop/src-tauri/src/commands/encode.rs::build_trajectory_capture_rect`:
  - macOS: `CGWindowListCopyWindowInfo(kCGWindowListOptionIncludingWindow)` for the window's bounds. Parse `kCGWindowBounds`.
  - Windows: `GetWindowRect(hwnd)` from windows-rs.
  - On lookup failure: keep existing fallback.
- Tests: unit test on each platform that captures a known window's rect.

**Estimate:** 1h (depends on availability of HWND / CGWindowID at the call site — may need to plumb through CaptureTarget).

**Acceptance:** Window-targeted recording → trajectory rect matches the window's screen position. Cursor renders at correct overlay location.

### Item 5 — Loading state polish

**Why:** Phase 19-03 wires 3 async loads (recording, story parse, trajectory). During load, post-prod shell renders empty timeline + black preview canvas. User sees nothing → confusing.

**Scope:**
- EDIT `editor-shell.tsx`: aggregate `isLoading` from 3 queries.
- Render skeleton timeline (5 empty track rows) + "Loading recording..." overlay on preview while loading.
- Once any required query resolves, show that part. Error state (no recording) is already handled by Phase 18-A.

**Estimate:** 30-45 min.

**Acceptance:** Open post-prod for new project. Loading state shows skeleton + spinner. Smooth transition to populated.

## Sequencing

All 5 items are independent. Pick whatever you have time for.

Suggested order if all 5 ship:
1. Item 5 (loading polish) — most visible UX win, quick.
2. Item 2 (parse error banner) — second-most-visible.
3. Item 1 (persist clip edits) — quick + valuable.
4. Item 3 (queue actions) — moderate complexity.
5. Item 4 (window-origin lookup) — most platform-specific risk; do last after Phase 21 verifies cursor rendering at all.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Persist version bump 2→3 wipes user's persisted form state | Low | one-time UX glitch | Document in commit body; add migrate fn |
| Window-origin lookup needs CaptureTarget extension | Medium | scope creep | If complex, defer Item 4 to dedicated mini-phase |
| Render queue retry semantics ambiguous (re-render vs requeue?) | Medium | UX confusion | Pin down in Item 3 plan: retry = new submission with copied args |

## Out of scope

- Major UX redesigns.
- Theme / dark mode tweaks.
- Onboarding tour for post-prod editor.
- Internationalization.
- Smart suggestions ("Tip: try a zoom on this click").

## Estimated total

| Item | Effort |
|---|---|
| 1. Persist clip edits | 30 min |
| 2. Parse error banner | 30 min |
| 3. Queue actions | 1h |
| 4. Window-origin lookup | 1h |
| 5. Loading state polish | 30-45 min |

**Total: ~3.5-4h** if all 5 ship. Pick subset based on shipping pressure.
