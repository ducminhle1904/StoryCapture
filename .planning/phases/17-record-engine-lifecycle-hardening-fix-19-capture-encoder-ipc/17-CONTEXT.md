# Phase 17: Record Engine Lifecycle Hardening — Context

**Gathered:** 2026-04-22
**Status:** Ready for planning
**Source:** Direct investigation (4-agent parallel deep-dive) — see <specifics> for raw findings

<domain>
## Phase Boundary

**In scope:** Fix 19 lifecycle / safety / backpressure / UX-feedback issues surfaced by the 2026-04-22 record-engine investigation. Touches 4 layers:

- `crates/capture/` — SCK, WGC, XCap backends + orchestrator
- `crates/encoder/` — FFmpeg sidecar pipeline + VT writer
- `apps/desktop/src-tauri/src/commands/encode.rs` + `lib.rs` (shutdown lifecycle)
- `apps/desktop/src/features/recorder/` + `src/state/recorder.ts` + `src/ipc/encode.ts`

**Out of scope (defer / do not touch):**
- No changes to DSL grammar, automation driver, effects/post-production, intelligence layer.
- No new recording features (no new capture targets, no new output codecs).
- No `BrowserDriver` / `LlmProvider` / `TtsProvider` trait changes.
- No public IPC contract breakage — only ADDITIVE event variants allowed.
- Post-record auto-navigation to editor (item UX-04 in the investigation) is explicitly **deferred to a UX decision**, NOT this phase.

**Success line:** After phase 17 lands, (a) app quit mid-record produces a valid finalized MP4; (b) double-clicking Start cannot create two sessions; (c) FFmpeg encoder lag produces telemetry events instead of silent drops; (d) audio failures surface to UI; (e) XCap stop is bounded by a timeout; (f) no public-API regressions.

</domain>

<decisions>
## Implementation Decisions (LOCKED)

### Cluster 1 — CLEANUP (shutdown & teardown)

- **D-01 [H1] Recording registry MUST drain on `RunEvent::ExitRequested` / `RunEvent::Exit`.** Pattern to copy: `drain_author_preview_sessions()` in `apps/desktop/src-tauri/src/lib.rs:174-200`. New helper `drain_recording_sessions(state)` that (a) snapshots session IDs from `RecordingRegistry`, (b) for each: calls `stop_recording_inner` with a 5s timeout per session, (c) aborts the `encode_join` task if timeout elapses, (d) logs outcome at `tracing::warn` level. Called from the same exit hook that already handles author-preview. MP4 must have a valid moov atom on graceful quit.
- **D-02 [H2] Orphan spawn tasks on capture start failure MUST be aborted.** In `encode.rs:start_recording`, the two `tokio::spawn` tasks that forward capture status (lines ~542-547) and encoder progress (lines ~802-806) currently leak if `capture.start_orchestrated()` fails (lines 577-584). Fix: collect `JoinHandle`s into a local `Vec<AbortHandle>`; on error path before `return Err(...)`, call `abort()` on each. Acceptance: unit test that forces `start_orchestrated` to fail and asserts no background tasks outlive the function call (via a shared `Arc<AtomicUsize>` alive counter).
- **D-03 [H6] `XcapBackend::stop` MUST have a bounded timeout.** In `crates/capture/src/xcap_backend.rs:179-184`, wrap the `spawn_blocking(move || h.join())` call in `tokio::time::timeout(Duration::from_secs(2), ...)`. On timeout: set a new `AtomicBool` `cancel_flag` that the capture thread's main loop checks each tick; force-drop the `SendMonitor` after timeout. Return `CaptureError::StopTimedOut` variant (new) so orchestrator/encode.rs can log + continue rather than hang.

### Cluster 2 — START-SAFETY (session start races)

- **D-04 [H4] Frontend MUST guard double-start at the UI AND the host MUST have a server-side atomic guard.**
  - Frontend (`recording-view.tsx:340`): add `if (status !== "idle") return;` as first line of the start handler. Also disable the Start button immediately via a synchronous `dispatch("starting")` state BEFORE awaiting `startRecording()`.
  - Backend (`encode.rs:start_recording`): introduce a `AtomicBool GLOBAL_STARTING` (or per-session guard). Use `compare_exchange(false, true)` at the entry of `start_recording`; if it fails, return `AppError::AlreadyStarting`. Release on success (after registry insert) or on error path.
  - New Zustand status value: `"starting"` between `"idle"` and `"recording"` (non-breaking, append to the union type).
- **D-05 [H5] WGC HWND MUST be validated before stream start.** In `crates/capture/src/wgc_backend.rs:300-327`, after casting `WindowId(u64)` to `HWND`, call the Win32 `IsWindow(hwnd)` check. If `false`: return `CaptureError::WindowGone` (new variant) BEFORE calling `Window::from_raw_hwnd`. Orchestrator fallback already handles window-target errors → XCap fallback; this just makes the failure explicit instead of undefined-behavior-in-WGC.
- **D-06 [H7] SCK pause/resume MUST be serialized.** In `crates/capture/src/sck_backend.rs:383-403`, replace the atomic-only pause flag with a `tokio::sync::Mutex<PauseState>` where `PauseState = Running | Paused | Transitioning`. `pause()` acquires the mutex, checks state, sets `Transitioning`, performs `spawn_blocking(stop_stream)`, then sets `Paused`. `resume()` does the symmetric. Concurrent `resume()` during `Transitioning` waits on the mutex. The existing `paused: AtomicBool` can be kept as a fast-path read-side signal for the frame delivery handler.

### Cluster 3 — ENCODER-ROBUST (frame pump & output integrity)

- **D-07 [H3] FFmpeg stdin path MUST implement explicit backpressure, not rely on blocking pipe writes.** In `crates/encoder/src/pipeline.rs:201`, wrap the stdin write in a `try_send`-style pattern: use `tokio::io::AsyncWrite::poll_write` with `tokio::time::timeout` (200ms). On timeout, (a) increment a `frames_dropped_backpressure` counter, (b) emit a `RecordingEvent::FramesDropped` event carrying the new counter, (c) continue to the next frame. Same model as VT writer's `vt_writer.rs:270-283` spin-drop. **No silent drops.**
- **D-08 [M] Output MP4 file MUST be written to a staging path and atomically renamed on success.** In `crates/encoder/src/config.rs` / `pipeline.rs`: change the FFmpeg `-o` argument from the final target path to `<target>.partial`. On FFmpeg exit code 0 AND `child.wait().success()`, `std::fs::rename(partial, target)`. On cancel / error, delete the `.partial` file in a `Drop` or error-path cleanup. Apply the same pattern to VT writer (`vt_writer.rs:136`).
- **D-09 [M] First-frame timeout MUST be configurable.** In `encode.rs:597`, replace the hardcoded `Duration::from_secs(3)` with a value read from `StartRecordingArgs::first_frame_timeout_ms` (new optional field, default 3000). Expose via IPC — non-breaking additive field (serde default).
- **D-10 [M] FIFO-opening handshake MUST replace the 200ms sleep.** In `encode.rs:743`, remove the `tokio::time::sleep(Duration::from_millis(200))`. Replace with: poll `fs::metadata(fifo_path)` every 20ms up to a 2s deadline; only start `AudioCaptureStream` after FFmpeg has actually opened the FIFO (detectable via a sentinel write + read, OR simply check file size > 0, OR use the fd-count trick on Unix). Windows path unaffected (no FIFO there currently).
- **D-11 [L] FFmpeg keyframe interval MUST be tunable via a config knob.** Add `keyframe_interval_sec: Option<u32>` to `EncodeConfig`. When set, emit `-g <fps * interval_sec>` to FFmpeg argv. Default behavior unchanged (omit flag). Surface in future Phase-13-style settings UI (not this phase; backend-only knob here).
- **D-12 [L] VT writer PTS clamp MUST log a warning when clamping occurs.** In `vt_writer.rs:254-255`, replace `(pts_ns - first_pts_ns).max(0)` with an explicit `if pts_ns < first_pts_ns { tracing::warn!(...); 0 } else { pts_ns - first_pts_ns }`. Add a counter exposed via stats; a non-zero clamp count after a run is a telemetry signal for clock-jump bugs.

### Cluster 4 — UX-FEEDBACK (state sync & error surfaces)

- **D-13 [M] Audio-unavailable MUST surface as a new `RecordingEvent::AudioUnavailable { reason: String }` variant.** Additive to `encode.rs:287-310` event enum — regenerate `packages/shared-types/src/ipc.ts` via tauri-specta build. Emit from `encode.rs:635-667` when mic negotiation fails. Frontend handles it in `recording-view.tsx` by showing a `sonner` toast and setting a visible recorder-state badge ("Audio unavailable — recording video only").
- **D-14 [M] Frontend MUST abort in-flight automation and encode channels on component unmount.** In `recording-view.tsx`, the `useEffect` that sets up the recording also returns a cleanup function; that cleanup MUST (a) call `onmessage = null` on the automation `Channel` (line ~437-451), (b) call `stopRecording()` if `sessionRef.current` is non-null (NOT just null the ref), (c) abort any in-flight TanStack Query mutations. Use `AbortController` where applicable.
- **D-15 [M] Host MUST emit a periodic `RecordingEvent::Heartbeat { seq }` every 2s while a session is active.** Add a new spawn in `start_recording` that ticks every 2s via `tokio::time::interval` and sends heartbeat on the per-session channel. Frontend watches for missed heartbeats (>5s since last) and surfaces "Recording state out of sync" + offers a "Force stop" button. Non-breaking additive event.

### Cluster 5 — POLISH (contract & correctness cleanup)

- **D-16 [M] NV12 pixel-format config MUST be rejected explicitly, not silently coerced.** In `crates/capture/src/sck_backend.rs:244-247` and the equivalent WGC path: if `CaptureConfig::pixel_format == PixelFormat::Nv12`, return `CaptureError::UnsupportedPixelFormat` at `start()` time. Remove the "silent coerce to BGRA" comment/branch. Until NV12 is truly supported, the config must fail loudly.
- **D-17 [M] HW encoder probe MUST support re-probe on explicit trigger.** `crates/encoder/src/probe.rs` currently caches the result once at startup (`once_cell::sync::OnceCell` / `OnceLock`). Add a `force_reprobe()` function that bypasses the cache and overwrites it. Called from a new `refresh_hw_encoders` Tauri command (additive, no UI change required in this phase — expose the RPC so future settings UI can wire it). Useful for eGPU dock/undock and driver updates mid-session.
- **D-18 [L] Atomic counter ordering MUST be upgraded to `AcqRel` for telemetry counters read cross-thread.** In `sck_backend.rs:305-312`, `wgc_backend.rs:182-187`, and any other capture-backend stats counters: change `Ordering::Relaxed` to `Ordering::AcqRel` on increments that are later read in `stop()` for stats reporting. `Relaxed` is fine within a single thread but a stop-side read needs acquire semantics. Low impact but correct.
- **D-19 [L] `@ts-ignore` in `TargetThumbnail.test.tsx` MUST be removed.** Replace with a properly typed mock for `URL.revokeObjectURL` (`vi.stubGlobal("URL", { ...URL, revokeObjectURL: vi.fn() })` or similar). No `@ts-ignore` / `@ts-expect-error` allowed in source or tests.

### Claude's Discretion

- Test matrix choice (unit vs. integration vs. feature-gated real-hardware) per fix — follow the existing patterns in `crates/capture/tests/` and `apps/desktop/src/**/*.test.tsx`. Real-capture tests for D-05, D-06 gated behind `real-capture` / `real-capture-windows` features per convention.
- Exact naming of new error variants (`WindowGone`, `StopTimedOut`, `UnsupportedPixelFormat`, `AlreadyStarting`) — pick names consistent with existing `CaptureError` / `AppError` enums.
- Whether to add `#[serde(deny_unknown_fields)]` on the new `StartRecordingArgs` fields — planner decides based on existing pattern.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Project instructions
- `CLAUDE.md` — Project constraints, stack, agent rules (MUST-follow: no workarounds, concise comments, match user language, plan before big changes, keep agent docs in sync)
- `docs/ARCHITECTURE.md` — Cross-crate flows, IPC, trait boundaries
- `docs/CONVENTIONS.md` — Rust/TS/test/commit conventions
- `docs/DOMAIN.md` — DSL + pipeline details

### Direct code references (by cluster)

**CLEANUP:**
- `apps/desktop/src-tauri/src/lib.rs:174-200` — author-preview drain pattern to copy
- `apps/desktop/src-tauri/src/commands/encode.rs:380-402` — `RecordingRegistry` + `RecordingHandle`
- `apps/desktop/src-tauri/src/commands/encode.rs:542-547, 802-806` — orphan-prone spawn tasks
- `apps/desktop/src-tauri/src/commands/encode.rs:577-584` — capture start failure path
- `crates/capture/src/xcap_backend.rs:179-184` — unbounded join

**START-SAFETY:**
- `apps/desktop/src/features/recorder/recording-view.tsx:340` — start handler
- `apps/desktop/src/state/recorder.ts` — Zustand store, status enum
- `apps/desktop/src-tauri/src/commands/encode.rs:422+` — `start_recording` command
- `crates/capture/src/wgc_backend.rs:300-327` — HWND cast site
- `crates/capture/src/sck_backend.rs:383-403` — pause/resume implementation

**ENCODER-ROBUST:**
- `crates/encoder/src/pipeline.rs:201-241` — stdin write + frame pump + wait path
- `crates/encoder/src/config.rs:171+` — FFmpeg argv construction
- `crates/encoder/src/macos/vt_writer.rs:136, 254-255, 270-283` — VT staging, PTS clamp, backpressure
- `apps/desktop/src-tauri/src/commands/encode.rs:597, 743` — first-frame timeout + FIFO sleep
- `crates/encoder/src/probe.rs:66, 144` — HW probe cache

**UX-FEEDBACK:**
- `apps/desktop/src-tauri/src/commands/encode.rs:287-310` — `RecordingEvent` enum (additive-only changes)
- `apps/desktop/src-tauri/src/commands/encode.rs:635-667` — audio negotiation
- `apps/desktop/src/features/recorder/recording-view.tsx:437-451` — automation channel lifecycle
- `apps/desktop/src/ipc/encode.ts:85-94` — IPC wrapper
- `packages/shared-types/src/ipc.ts` — tauri-specta auto-generated (do not hand-edit)

**POLISH:**
- `crates/capture/src/sck_backend.rs:244-247` — NV12 coerce
- `crates/encoder/src/probe.rs` — probe cache
- `crates/capture/src/sck_backend.rs:305-312, wgc_backend.rs:182-187` — atomic counters
- `apps/desktop/src/features/recorder/TargetThumbnail.test.tsx:37` — ts-ignore

### IPC single source of truth
- `apps/desktop/src-tauri/src/ipc_spec.rs` — command + type registration (add `refresh_hw_encoders`, regenerate shared-types)

</canonical_refs>

<specifics>
## Specific Ideas

### Investigation report summary

4 agents ran in parallel on 2026-04-22 covering capture / encoder / IPC / frontend. Key aggregate findings:

- **Design fidelity: ~90%** — 3 backends + orchestrator + fallback work; per-session Channel refactor (commit 673d75a) is correct; zero-copy native frame path is clean.
- **Top 3 production risks:**
  1. Lost video on app quit mid-record (D-01)
  2. No FFmpeg stdin backpressure → silent frame drops (D-07)
  3. Double-start race + registry orphan leak (D-02, D-04)
- **Medium concerns:** XCap hang on stop, WGC HWND race, SCK pause race, silent audio failure, non-atomic output file, stale heartbeats on desync.

### Severity bucket → cluster mapping

| Severity | IDs | Cluster |
|---|---|---|
| HIGH | H1, H2, H3, H4, H5, H6, H7 | mapped to D-01..D-07 |
| MEDIUM | 7 items | D-08..D-14, D-16, D-17 |
| LOW | 4 items | D-11, D-12, D-18, D-19 |

### Test strategy (planner hints)

- Rust unit tests for: task-abort on error (D-02), HWND-validation error (D-05), pause/resume serialization (D-06), backpressure counter increment (D-07), staging → rename (D-08), NV12 reject (D-16), probe re-run (D-17).
- Rust integration tests gated behind `real-capture` / `real-capture-windows` for the actual SCK/WGC behaviors.
- Vitest unit tests for: double-start guard (D-04 FE), unmount cleanup (D-14), `AudioUnavailable` toast (D-13), heartbeat watchdog (D-15).
- Manual QA script for app-quit-mid-record (D-01) with MP4 validity check (ffprobe on the output).

### Non-goals reminders

- Do NOT refactor `CaptureBackend` trait surface.
- Do NOT change `EncodeConfig` beyond the two additive knobs (first-frame timeout, keyframe interval).
- Do NOT touch post-production / intelligence / web.

</specifics>

<deferred>
## Deferred Ideas

- **UX-04 (from investigation): post-record auto-navigation to Post-Production editor.** This is a product UX decision — handled in a future phase after Phase 15's editor boundary cleanup settles.
- **NV12 native implementation** (a true zero-copy NV12 path through capture → encoder) — separate phase; D-16 here just makes the config contract honest by rejecting NV12 until that phase lands.
- **Stealth/anti-bot coverage for chromiumoxide** — unrelated to record-engine lifecycle; tracked separately in PROJECT.md risk flags.
- **Sentry / opt-in crash reporting** — unrelated; PROJECT.md policy defers this.

</deferred>

---

*Phase: 17-record-engine-lifecycle-hardening*
*Context gathered: 2026-04-22 via 4-agent parallel investigation*
