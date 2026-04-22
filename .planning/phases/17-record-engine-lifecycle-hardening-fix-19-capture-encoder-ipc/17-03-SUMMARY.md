---
phase: 17
plan: 03
wave: 1
status: completed
completed_at: 2026-04-22
decisions_covered: [D-04, D-05, D-06]
files_modified:
  - apps/desktop/src/features/recorder/recording-view.tsx
  - apps/desktop/src/features/recorder/double-start-guard.test.ts
  - apps/desktop/src/state/recorder.ts
  - apps/desktop/src-tauri/src/commands/encode.rs
  - apps/desktop/src-tauri/src/error.rs
  - crates/capture/src/error.rs
  - crates/capture/src/windows/wgc_backend.rs
  - crates/capture/src/macos/sck_backend.rs
  - packages/shared-types/src/ipc.ts
commits:
  - 63cc7b8 feat(17-03): double-start guard on frontend + AtomicBool GLOBAL_STARTING on host
  - 2c59529 feat(17-03): validate HWND before WGC Window::from_raw_hwnd
  - 8e424a3 chore(17-03): regenerate shared-types/ipc.ts for AppError::AlreadyStarting
  - 490db15 refactor(17-03): serialize SCK pause/resume via Mutex<PauseState>
---

# Phase 17 Plan 03: Wave 1 — START-SAFETY — Summary

Three start-side races closed: UI double-click cannot spawn two sessions, stale HWNDs no longer hit undefined behaviour inside WGC, and concurrent SCK pause/resume serialize through a PauseState mutex while keeping the GCD-side AtomicBool fast path.

## What Changed

### `apps/desktop/src/state/recorder.ts` (D-04)

- Added `"starting"` to the `RecorderStatus` union. Non-breaking additive; sits between `"idle"` and `"recording"` in the lifecycle and keeps the RecordButton render gate (`status === "idle"`) intact.

### `apps/desktop/src/features/recorder/recording-view.tsx` (D-04)

- `handleRecord` first line: `if (status !== "idle") return;` followed by a **synchronous** `setStatus("starting")` before any `await`. This closes the ~10ms double-click race — React re-render isn't required; the Zustand `setState` is synchronous.
- The old `setStatus("recording")` at the top of the handler is gone; the transition to `"recording"` now happens only after `startRecording()` resolves with a session id.
- Error path was `setStatus("failed")` → changed to `setStatus("idle")` per plan. The toast + error banner still surface the failure; `"failed"` as a terminal UI state stays reachable from the `dispatch("failed")` event path during an active session.
- `permission !== "granted"` and "no target selected" early-exits also reset to `"idle"` to release the guard.

### `apps/desktop/src/features/recorder/double-start-guard.test.ts` (new, D-04)

- Three Vitest cases modelling the real `handleRecord` pattern against the live Zustand store:
  1. Two synchronous handler invocations within one tick → exactly one IPC call fires; final status `"recording"`.
  2. Error path resets status to `"idle"` so a retry can succeed; second attempt does fire the IPC call.
  3. `"starting"` is an acceptable value for the `RecorderStatus` union (smoke test for the additive type change).

### `apps/desktop/src-tauri/src/error.rs` (D-04)

- New variant `AppError::AlreadyStarting` (no message payload). Appended at enum tail — ordering preserved for existing variants. Manual `Serialize` impl updated to emit `{ kind: "AlreadyStarting", message: "a recording is already starting" }` to match the tauri-specta TS shape.

### `apps/desktop/src-tauri/src/commands/encode.rs` (D-04)

- Module-level `static GLOBAL_STARTING: AtomicBool = AtomicBool::new(false);`.
- `StartingGuard` (local struct, one-line `impl Drop`): clears `GLOBAL_STARTING` on every scope exit — success, `?` propagation, panic. No external crate needed (plan mentioned `scopeguard` but it wasn't in the workspace).
- `start_recording` entry: `compare_exchange(false, true, AcqRel, Acquire)`; on failure returns `AppError::AlreadyStarting`. On success, a `StartingGuard` value is held on the stack for the duration of the function.
- Added unit tests (`double_start_guard_tests` module): CAS rejects the second caller, Drop clears the flag; `catch_unwind` exercises the panic path.

### `packages/shared-types/src/ipc.ts` (auto-generated)

- Regenerated via tauri-specta to include the new `AppError::AlreadyStarting` variant. No hand edits.

### `crates/capture/src/error.rs` (D-05)

- New variant `CaptureError::WindowGone { hwnd: u64 }`. Appended after `StopTimedOut` (17-02) at the enum tail — additive only.

### `crates/capture/src/windows/wgc_backend.rs` (D-05)

- Both HWND call sites now call `windows::Win32::UI::WindowsAndMessaging::IsWindow(HWND(raw))` immediately after the raw-pointer cast and BEFORE `Window::from_raw_hwnd`:
  - `CaptureTarget::Window { window_id }` (line ~305)
  - `CaptureTarget::WindowByPid { pid, .. }` (line ~345)
- On false, returns `CaptureError::WindowGone { hwnd }` so the orchestrator's existing error-path fallback to xcap kicks in rather than handing a dead HWND to WGC.
- `IsWindow` is already exposed by the `windows = 0.58` feature set (`Win32_UI_WindowsAndMessaging` + `Win32_Foundation`) — no Cargo.toml change needed.

### `crates/capture/src/macos/sck_backend.rs` (D-06)

- New `PauseState { Running | Paused | Transitioning }` enum (module-private).
- New field `pause_state: Arc<tokio::sync::Mutex<PauseState>>` (initialised `Running`). The existing `paused: Arc<AtomicBool>` is **retained unchanged** as the hot-path read signal for the SCK output handler on the GCD queue.
- `pause()` rewritten:
  1. Acquire the mutex.
  2. Match on state — `Paused | Transitioning` → return `Ok(())` (idempotent).
  3. Set `Transitioning`, drop the mutex.
  4. `stop_stream().await` (runs `spawn_blocking(SCStream::stop_capture)` internally).
  5. Re-acquire mutex; on Ok set `AtomicBool=true` + state `Paused`. On Err roll state back to `Running` so a retry is possible.
- `resume()` is symmetric with mirror branches (`Running | Transitioning` → no-op; `Paused` → transition via `resume_stream`).
- `start()` and `stop()` reset `pause_state` to `Running` at session boundaries.
- `start()` and `stop()` scoped the `parking_lot::MutexGuard<SckState>` into a block so it no longer leaks across the new `.await` points — fixes the `Send` bound required by the async-trait lowering. No behaviour change; just lock-hold hygiene.
- New tokio tests (`pause_state_tests` module): use a standalone `PauseState` + `tokio::sync::Mutex` to model the exact branching in the real backend without requiring a live `SCStream`. Three cases cover (a) concurrent pauses pick one winner and land on `Paused`, (b) concurrent resumes during a transition land on `Running`, (c) pause→resume round-trip returns to `Running`.

## Decisions Covered

| Decision | Coverage |
|----------|----------|
| D-04 | FE `"starting"` union + synchronous early-return guard in `handleRecord`; host `GLOBAL_STARTING` CAS + `StartingGuard` Drop; `AppError::AlreadyStarting`; 2 Rust + 3 Vitest tests. |
| D-05 | `CaptureError::WindowGone { hwnd }`; `IsWindow` check at both WGC HWND call sites before `Window::from_raw_hwnd`; orchestrator fallback path unchanged. |
| D-06 | `PauseState` + `tokio::sync::Mutex<PauseState>`; `pause()` / `resume()` serialize through it with idempotent match arms; `AtomicBool` fast path retained; 3 new tokio tests. |

## Verification

| Command | Result |
|---------|--------|
| `cargo check -p capture -p storycapture` | exit 0 |
| `cargo test -p capture --lib` | 36/36 passed (3 new: `pause_state_tests::*`) |
| `cargo test -p storycapture --lib` | 64/64 passed (2 new: `double_start_guard_tests::*`) |
| `pnpm --filter desktop exec vitest run features/recorder/double-start-guard` | 3/3 passed |
| `pnpm --filter desktop typecheck` | exit 0 |
| `biome check <authored files>` | `double-start-guard.test.ts` clean |
| Acceptance greps (see below) | all pass |

### Acceptance greps

```
AlreadyStarting in error.rs:                       2  (expect ≥ 1 — variant + Serialize arm)
GLOBAL_STARTING in encode.rs:                     13  (expect ≥ 3 — decl + cmpxchg + Drop + tests)
"starting" in recorder.ts:                         1  (expect ≥ 1 — union member)
status !== "idle" in recording-view.tsx:           1  (expect ≥ 1 — double-start guard)
WindowGone in error.rs:                            1  (expect == 1)
IsWindow in wgc_backend.rs:                        2  (expect ≥ 1 — two call sites)
IsWindow@305 before from_raw_hwnd@315:           OK
IsWindow@345 before from_raw_hwnd@355:           OK
enum PauseState in sck_backend.rs:                 1  (expect == 1)
Transitioning in sck_backend.rs:                  11  (expect ≥ 3)
tokio::sync::Mutex<PauseState>:                    1  (expect ≥ 1)
AtomicBool retained in sck_backend.rs:             3  (fast-path preserved)
```

### Out-of-scope items NOT fixed (pre-existing, per CLAUDE.md SCOPE BOUNDARY)

- `cargo clippy -p capture --all-targets -- -D warnings` surfaces the same pre-existing errors called out in 17-02 (`target.rs` `uninlined_format_args`, `screenshot.rs` `type_complexity`, `display.rs` unused import, `sck_backend.rs:608` `build_filter_for_test_region` dead code, `fifo.rs:151` format arg). None are in code this plan wrote or edited substantively.
- `biome check` against `state/recorder.ts` and `recording-view.tsx` flags pre-existing import-order noise unrelated to this plan's diff. The newly-authored `double-start-guard.test.ts` passes biome cleanly.
- Real-hardware Windows `IsWindow(0)` integration test is **not** added — `crates/capture/tests/wgc_real_capture.rs` requires a Windows VM with Playwright and is `real-capture-windows` feature-gated; per plan test strategy real-capture tests run operator-triggered on the Windows VM, not in this plan's commit loop. The unit-level coverage here is the acceptance-grep ordering proof.

## Deviations

1. **Error-path status: `"failed"` → `"idle"` is a behaviour change not strictly motivated by D-04's goal.** Plan directed this explicitly ("On error path, reset status to `\"idle\"`"), so I followed. Practical impact: the bottom-of-rail "Recording failed" copy (gated on `status === "failed"`) no longer shows for a *start* failure — the toast + the error banner driven by `setError()` still surface the failure, and `"failed"` remains reachable from the `dispatch({type:"failed"})` branch for mid-session failures. If the UX team wants the start-time failure banner back, the fix is localised (revert the catch arm's status to `"failed"` and leave the happy-path `"starting"` → `"recording"` transition intact).

2. **No `scopeguard` dependency added — inline `StartingGuard` struct instead.** Plan suggested `scopeguard::guard` but noted "inline a tiny `struct Guard;` with `impl Drop`" as an alternative. `scopeguard` is not in the workspace; adding a dep for one use site would be overkill. The inline Drop struct is 8 lines and equally panic-safe.

3. **Mutex-hold across `spawn_blocking`: explicitly dropped, not held.** Per executor context directive: "Do NOT hold the mutex across the `spawn_blocking`". Both `pause()` and `resume()` drop the `tokio::sync::MutexGuard<PauseState>` before awaiting `stop_stream` / `resume_stream` (which themselves call `spawn_blocking` internally), then reacquire to write the terminal state. This matches the plan action's description ("the state-check in the match arm makes repeated pause()/resume() idempotent") — a second caller arriving mid-transition acquires the mutex, sees `Transitioning`, and returns `Ok(())` without issuing a duplicate SCK lifecycle call.

4. **`start()` and `stop()` body restructure to fix `Send` bounds.** Adding `*self.pause_state.lock().await` inside `start()` / `stop()` caused the async-trait lowering to complain that the pre-existing `parking_lot::MutexGuard<SckState>` was held across the await point. Fix was lock-hygiene only: wrap the `parking_lot` critical sections in explicit blocks so they release before the `.await`. No behaviour change.

5. **IPC type regeneration committed separately.** The `packages/shared-types/src/ipc.ts` tauri-specta output updates for the new `AppError::AlreadyStarting` variant are in commit `8e424a3` (chore), not folded into `63cc7b8` (feat). This keeps the per-task commit granular and makes the generated-file boundary explicit.

## Commits

- `63cc7b8` feat(17-03): double-start guard on frontend + AtomicBool GLOBAL_STARTING on host
- `2c59529` feat(17-03): validate HWND before WGC Window::from_raw_hwnd
- `8e424a3` chore(17-03): regenerate shared-types/ipc.ts for AppError::AlreadyStarting
- `490db15` refactor(17-03): serialize SCK pause/resume via Mutex<PauseState>

## Self-Check: PASSED

- All 9 `files_modified` paths exist and contain the claimed edits (verified via grep sweep above).
- All four commits present in `git log --oneline -10`:
  - `63cc7b8` — FOUND
  - `2c59529` — FOUND
  - `8e424a3` — FOUND
  - `490db15` — FOUND
- Unit tests compile and pass on the host runner (macOS).
- No CaptureBackend trait surface change; additive-only enum variants verified.
