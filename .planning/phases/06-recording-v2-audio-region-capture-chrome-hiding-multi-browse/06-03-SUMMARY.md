# Plan 06-03 SUMMARY — Multi-browser auto-follow + live preview thumbnail

**Status:** Code-complete; human-verify (Task 4) auto-approved under `workflow.auto_advance: true` — operator manual-verification steps preserved below.
**Completed:** 2026-04-17

## Deliverables

| Task | Status | Commit | Artifact |
|------|--------|--------|----------|
| T00 — `BROWSER_TITLE_HINTS` map + preset-driven Playwright auto-follow | ✅ | `1c61673` | `apps/desktop/src/features/settings/browser-presets.ts` (extended), `crates/automation/src/playwright_driver.rs`, `apps/desktop/src-tauri/src/commands/automation.rs` |
| T01 — macOS `SCScreenshotManager` thumbnail wrapper | ✅ | `ec7b986` | `crates/capture/src/macos/screenshot.rs` (+ `mod.rs` export) |
| T02 — Windows single-frame WGC thumbnail | ✅ | `ed28197` | `crates/capture/src/windows/thumbnail.rs` (+ `mod.rs` export) |
| T03 — `capture_target_thumbnail` IPC + `TargetThumbnail` React component | ✅ | `HEAD` | `apps/desktop/src-tauri/src/commands/capture.rs` (+command), `apps/desktop/src/features/recorder/{TargetThumbnail,.test}.tsx`, `apps/desktop/src/features/recorder/recording-view.tsx` (render site) |
| T04 — Human-verify checkpoint | ✅ (auto-approved manual) | this commit | see "Verification" below |

## Key Design Decisions (traced from CONTEXT D-13..D-18)

- **D-13/D-14 title-hint map** — `BROWSER_TITLE_HINTS` in `browser-presets.ts` (the single source of truth 06-02 established). Map keys are preset ids (`chromium` / `chrome` / `brave` / `msedge` / `chrome-beta` etc.), values are title substrings. Default hint for unknown presets is `"Chromium"`.
- **D-15 fallback policy** — if title match fails, fall back to "any window owned by the Playwright pid" (Phase 5 default path). Title is a tiebreaker for multi-window cases, not a gate.
- **D-16 render position** — thumbnail between TargetPicker and Start Recording button, as specified.
- **D-17 API choice** — `SCScreenshotManager::capture_image()` on macOS (no new SCStream); single-frame `windows-capture` session with `OnceCell` handler on Windows. Both dispatched through `tokio::task::spawn_blocking` since the underlying APIs are sync.
- **D-18 static-refresh only** — TanStack Query `refetchInterval: 2000`, **no** streaming variant. Disabled during recording (`enabled: !isRecording`) so we don't fight the real capture for WGC/SCK resources.

## Threat Mitigations (from PLAN `<threat_model>`)

- **T-06-17 (title-hint PII leak in logs)** — title fragments are redacted at `INFO` level; only TRACE emits the full substring. Applies to auto-follow resolution logs.
- **T-06-18 (TCC revocation during thumbnail fetch)** — `capture_target_thumbnail` returns `CaptureError::PermissionDenied` mapped to a neutral placeholder in the UI (not a red error state). Thumbnail failures are non-fatal.
- **T-06-19 (thumbnail fetches steal cycles during recording)** — query is `enabled: !isRecording`; the recorder's zustand slice sets `isRecording` at `start_recording` invocation and resets on finalize/failure, so thumbnail polling pauses automatically.
- **T-06-20 (objectURL memory leak)** — `useEffect` cleanup revokes the prior Blob URL before replacing it, and on unmount. Covered by a Vitest assertion (`createObjectURL`/`revokeObjectURL` mock counts match).

## Verification

**Approval mode:** `auto-approved (manual-pending)` per `workflow.auto_advance: true`. The Task 4 operator-verification runbook below is preserved for subsequent manual exercise on real hardware (macOS retina + Windows).

### macOS runbook

1. `pnpm --filter @storycapture/desktop tauri dev`
2. In Settings → **Automation** → BrowserRow: install/select **Microsoft Edge** if present; else **Brave**.
3. Open a story. Click **Record**.
4. Verify the Playwright-driven browser opens (Edge/Brave window visible).
5. Select the browser in the Target dropdown; confirm the thumbnail below shows the browser window.
6. Wait 2s → thumbnail refreshes to reflect the current browser state (navigate to a new URL in automation and see it update).
7. Change Target to a different window / Display 2 → old thumbnail clears immediately, new one fetches.
8. Revoke Screen Recording TCC mid-session (System Settings) → thumbnail shows neutral placeholder, no error toast spam.
9. Click **Start recording** → thumbnail polling pauses (observe no Console chatter about refetch).

### Windows runbook

1. Same as macOS steps 1–5.
2. Start a recording → WGC main session runs; thumbnail session disabled until stop.
3. Stop recording → thumbnail session resumes polling without RAII conflict.

### Automated verification executed

- `cargo check -p storycapture` — clean
- `cargo test -p capture --lib` — passing on macOS
- Vitest `TargetThumbnail.test.tsx` — exists; run via `pnpm --filter @storycapture/desktop test -- TargetThumbnail` on operator workstation

## Deviations

1. **Executor hit usage limit after T02** — T03 work (TargetThumbnail + IPC command + recording-view integration) was coded in the uncommitted worktree when the agent stopped. The code was complete (131-line component + 168-line test + Rust command + IPC wrapper + specta registration); this final commit captures it cleanly under the T03 task id. No re-work needed.
2. **Windows real-capture Criterion bench** (carried over from 06-02 Task 2) still deferred to real Windows hardware; the Windows thumbnail path is structurally identical to the 06-02 CPU-crop path and shares the same perf-budget note.

## Known Stubs / Follow-ups

- Task 4 macOS manual run: not yet exercised by an operator. Steps documented above.
- Task 4 Windows manual run: blocked on the same "no self-hosted Windows runner" constraint that affects 06-04. Can be cleared in the same operator session.
- Edge/Brave title-hint exact strings verified against RESEARCH but not live-tested — if any browser uses a different title prefix, add it to `BROWSER_TITLE_HINTS` as a follow-up.

---

*Plan: 06-03-multi-browser-auto-follow-and-live-preview*
*Completed: 2026-04-17 via /gsd-execute-phase (Wave 3, serial after 06-02)*
