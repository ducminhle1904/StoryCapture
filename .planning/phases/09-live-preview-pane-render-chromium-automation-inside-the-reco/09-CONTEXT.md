# Phase 9: Live Preview pane (CDP) — Context

**Gathered:** 2026-04-21 (backfilled from ROADMAP.md + existing plan files)
**Status:** Planned, not started
**Source:** ROADMAP.md §Phase 9 + existing `09-0{1..4}-PLAN.md` + `09-RESEARCH.md`

<domain>
## Phase Boundary

Render the Playwright-driven Chromium visually inside the StoryCapture Recorder window while it automates, eliminating the need for the user to watch an external browser window. Preview is **cosmetic only** — the final recording still uses real-Chromium pixels via SCK/WGC window capture (NOT screencast frames).

Backed by Chrome DevTools Protocol `Page.startScreencast` (base64 JPEG frames @ ≤25 fps), bridged through the existing `scripts/playwright-sidecar/server.mjs` into a Tauri event stream consumed by a React canvas renderer.

**Out of scope:**
- Using screencast frames for the final video (quality regression)
- Input forwarding from the preview canvas back into Chromium
- Cursor-overlay compositing on the preview (CursorTrail stays on final video)
- Preview for non-Playwright capture targets (display / generic window)

</domain>

<decisions>
## Implementation Decisions (locked — derived from ROADMAP + PLAN files)

### Sidecar CDP plumbing
- **D-01:** Add JSON-RPC verbs `startPreviewStream(streamId?)` / `stopPreviewStream(streamId?)` to `scripts/playwright-sidecar/server.mjs`. Wrap `Page.startScreencast` + `Page.screencastFrameAck`.
- **D-02:** Sidecar emits `notification` messages carrying base64 JPEG frames. Ack each frame back through `Page.screencastFrameAck` to maintain flow.
- **D-03:** Backpressure: drop frames under load. Preview failure MUST NOT affect capture or recording.
- **D-04:** Graceful fallback when CDP unavailable (non-Chromium backends) — preview canvas shows "Live preview unavailable" muted state.

### Rust bridge
- **D-05:** Add `SidecarMsg::Notification` enum variant to sidecar message parsing in `crates/automation/src/playwright_driver.rs`.
- **D-06:** Add `subscribe_preview(streamId) -> watch::Receiver<PreviewFrame>` method on `PlaywrightSidecarDriver`. Add `PreviewFrame { stream_id, seq, mime, data_base64, width, height, timestamp_ms }` struct.
- **D-07:** Tauri event `preview://frame` carries frames to the frontend. One event per frame; backpressure handled via watch-channel coalescing.

### Frontend canvas
- **D-08:** `<LivePreview />` React component in `apps/desktop/src/features/recorder/live-preview.tsx` (kebab-case).
- **D-09:** Canvas-based renderer, not `<img>` — allows per-frame pixel control and avoids GC pressure from decoded-image objects.
- **D-10:** Mounted in RecordingView left zone; shares layout with the existing capture-target preview.
- **D-11:** Options toggle "Live preview" (default ON).

### Multi-stream + author-session extensions (09-04)
- **D-12 (PHASE-9.8):** Multi-stream sidecar — `streamId` param on `startPreviewStream`. Allows recording-session stream (single) and author-time ephemeral session streams (multiple) to coexist.
- **D-13 (PHASE-9.8):** Ephemeral author-time Playwright session separate from the recording session. Never reuses the recording driver.
- **D-14 (PHASE-9.8):** Expose the author-session `Page` handle to Rust via `attach_author_driver(streamId)` command. Required prerequisite for Phase 10 simulator.
- **D-15 (PHASE-9.9):** Add `pauseStream(streamId)` / `resumeStream(streamId)` sidecar RPCs + Tauri commands. Required for exclusive-lock concurrency between simulator (Phase 10) and picker (Phase 11).
- **D-16:** Viewport switcher in Editor page drives `page.setViewportSize()` via new `setViewport` RPC.
- **D-17:** Editor Live Preview default-off toggle to preserve cold-start budget.

### Performance
- **D-18:** ≥15 fps target on a 2023 M2 MBP; graceful degradation under load (frame-rate drops first, then backpressure-drop frames).
- **D-19:** CPU cost of preview ≤15% (single-pane, Recording view).
- **D-20:** Occluded / offscreen / background Chromium still streams (PID-bound, not window-bound) — CDP runs regardless of window visibility.

### Behavior preservation
- **D-21:** All Phase 5 capture tests remain green.
- **D-22:** Final video bitrate, frame count, encoder selection unchanged vs. pre-phase.
- **D-23:** Toggling "Live preview" off does not disturb recording behavior.

### Rollout strategy
- **D-24:** Four waves (per existing plan files):
  - Wave 1 (09-01) — Sidecar CDP verbs + Rust event bridge
  - Wave 2 (09-02) — React `<LivePreview />` canvas renderer + Options toggle
  - Wave 3 (09-03) — Perf / backpressure hardening + fallback UX
  - Wave 4 (09-04) — Editor-surface preview + viewport switcher + PHASE-9.8/9.9 author-session extensions (Phase 10 prerequisites)

</decisions>

<canonical_refs>
## Canonical References

### Plan files (already locked)
- `.planning/phases/09-live-preview-pane-render-chromium-automation-inside-the-reco/09-01-PLAN.md`
- `.planning/phases/09-live-preview-pane-render-chromium-automation-inside-the-reco/09-02-PLAN.md`
- `.planning/phases/09-live-preview-pane-render-chromium-automation-inside-the-reco/09-03-PLAN.md`
- `.planning/phases/09-live-preview-pane-render-chromium-automation-inside-the-reco/09-04-PLAN.md`
- `.planning/phases/09-live-preview-pane-render-chromium-automation-inside-the-reco/09-RESEARCH.md`
- `.planning/phases/09-live-preview-pane-render-chromium-automation-inside-the-reco/09-UI-SPEC.md`

### Subjects of this phase
- `scripts/playwright-sidecar/server.mjs` (add CDP verbs)
- `crates/automation/src/playwright_driver.rs` (add SidecarMsg notification + subscribe_preview)
- `crates/automation/src/driver.rs` (BrowserDriver trait — if preview subscription is exposed)
- `apps/desktop/src-tauri/src/commands/` (new `preview_*` commands; `attach_author_driver` in 09-04)
- `apps/desktop/src-tauri/src/ipc_spec.rs` (register new commands)
- `apps/desktop/src/features/recorder/` (new live-preview component)
- `apps/desktop/src/features/editor/` (09-04: editor-surface live preview + viewport switcher)

### Dependencies shipped (prerequisites)
- Phase 5 (window-target capture) — shipped 2026-04-17
- Phase 6 (`CaptureConfig` + chrome-hiding) — shipped 2026-04-17
- Phase 7 (locator engine + `.story.targets.json`) — shipped 2026-04-19 (required by Phase 10 but not strictly by Phase 9)
- quick task 260418-ios (focus-steal fix) — shipped

### Downstream consumers (phases blocked by this one)
- Phase 10 (author-time simulator) requires PHASE-9.8 (`attach_author_driver`) + PHASE-9.9 (`pauseStream`/`resumeStream`) from 09-04
- Phase 11 (element picker relocation) requires Phase 10 — transitively requires Phase 9

### Project standards
- `CLAUDE.md` — no workarounds, no Co-Authored-By, concise comments, kebab-case, motion/react, Base UI
- `docs/ARCHITECTURE.md` — sidecar + Tauri IPC boundary
- `docs/CONVENTIONS.md`

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable assets
- **`playwright-sidecar`** — existing Node SEA with JSON-RPC 2.0 over stdio; extend with new verbs.
- **`PlaywrightSidecarDriver`** — existing Rust driver; add notification-channel plumbing.
- **Tauri event bus** — existing pattern for streaming runtime events to frontend.
- **`RegionOverlay`** — existing transparent overlay window pattern (Phase 6); reference for any future preview-window work though this phase lands inside the main window.

### Integration points
- Sidecar message enum in `playwright_driver.rs` — new `Notification` variant.
- `ipc_spec.rs` — register new `preview_start` / `preview_stop` / `attach_author_driver` commands.
- Recording view + Editor page layouts — new live-preview slot.

### Risks
- CDP frame rate varies by page complexity; backpressure + coalescing needed.
- Author-session + recording-session concurrency (D-13/D-14/D-15) is the hardest part; bugs here cascade into Phase 10 + 11. Spec carefully.
- macOS native backend (SCK) vs Playwright CDP are independent pipelines — cognitive load for future contributors.

</code_context>

<specifics>
## Specific Ideas

- Base64-encoded JPEG frames over IPC cost ~30% more bytes than raw binary. Acceptable given ≤25 fps and ≤15% CPU budget. If this becomes a bottleneck, switch to Tauri's binary IPC or a shared-memory channel in a follow-up.
- Frame ack pattern: every N frames (e.g. 4), not every frame, to reduce round-trip latency while still maintaining CDP's requested ack discipline.
- Author-session stream IDs should be short-lived UUIDs; expired stream IDs must not leak CDP resources — teardown on `AuthorDriverRegistry` drop (Phase 11 concern, but the contract is set here).

</specifics>

<deferred>
## Deferred Ideas

- **Shared-memory frame transport** to bypass base64 encoding. Not needed at v1 perf targets.
- **Input forwarding from preview back into Chromium** (out of scope — preview is cosmetic).
- **Cursor-overlay on preview frames** (out of scope — CursorTrail is final-video only).
- **Preview for non-Playwright targets** (display / generic window) — Playwright/CDP only.
- **Per-preview quality settings** (JPEG quality, fps cap in UI) — ship with sensible defaults first.

</deferred>

---

## Amendment log

- **2026-04-21** — CONTEXT.md backfilled from ROADMAP.md §Phase 9 and existing PLAN files. Phase 9 had been planned without a canonical CONTEXT artifact; this document makes D-01..D-24 explicit so future planners/executors have a single source of truth.

---

*Phase: 09-live-preview-pane-render-chromium-automation-inside-the-reco*
*Context backfilled: 2026-04-21*
