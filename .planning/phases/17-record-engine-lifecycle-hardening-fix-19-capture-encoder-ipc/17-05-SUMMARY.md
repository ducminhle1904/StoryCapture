---
phase: 17
plan: 05
wave: 3
status: completed
completed_at: 2026-04-22
decisions_covered: [D-13, D-14, D-15]
files_modified:
  - apps/desktop/src-tauri/src/commands/encode.rs
  - apps/desktop/src-tauri/Cargo.toml
  - apps/desktop/src/features/recorder/recording-view.tsx
  - apps/desktop/src/ipc/encode.ts
  - apps/desktop/src/ipc/automation.ts
files_added:
  - apps/desktop/src/features/recorder/audio-unavailable.test.ts
  - apps/desktop/src/features/recorder/unmount-cleanup.test.ts
  - apps/desktop/src/features/recorder/heartbeat-watchdog.test.ts
commits:
  - e6517c9 feat(17-05): emit AudioUnavailable + show toast and badge on audio negotiation failure
  - 4cefeb1 fix(17-05): teardown session, channel, and in-flight mutations on recording-view unmount
  - daa9d20 feat(17-05): emit Heartbeat every 2s + frontend watchdog with Force stop
---

# Phase 17 Plan 05: Wave 3 — UX-FEEDBACK — Summary

Three silent-failure paths now surface to the UI: audio negotiation errors show a toast + persistent "video-only" badge; component unmount tears down the automation Channel + live session + in-flight mutations; the host emits a 2s heartbeat and the renderer has a watchdog + Force Stop escape hatch.

## What Changed

### `apps/desktop/src-tauri/src/commands/encode.rs`

- **D-13.** Two existing mic-failure paths (`negotiate_input` error + spawn_blocking join error + `AudioCaptureStream::start_with_negotiated` failure) now emit `RecordingEvent::AudioUnavailable { reason: format!("{e}") }` in addition to the pre-existing `tracing::warn!`. Recording continues video-only — no abort.
- **D-15.** After the `RecordingRegistry` insert a new 2s ticker is spawned:
  ```rust
  let mut interval = tokio::time::interval(Duration::from_secs(2));
  interval.tick().await; // skip the immediate fire
  let mut seq: u64 = 0;
  loop {
      interval.tick().await;
      if on_event.send(RecordingEvent::Heartbeat { seq }).is_err() { break; }
      seq = seq.wrapping_add(1);
  }
  ```
  The ticker's `AbortHandle` is pushed into the per-session `SpawnAbortGuard` (17-02) so early-failure before registry insert aborts it, AND stored on the new `RecordingHandle.heartbeat_abort: Option<AbortHandle>` field so `stop_recording_inner` and `drain_one` abort it on session teardown (prevents heartbeats past `Completed`/`Failed`).
- Two new tokio unit tests behind `tokio(flavor = "current_thread", start_paused = true)`:
  - `heartbeat_loop_emits_monotonic_seq_and_breaks_on_closed_sink` — drives ≥3 ticks, asserts seq starts at 0 and increments by 1, and that a `Err(())` return from the sink breaks the loop.
  - `heartbeat_abort_handle_stops_emissions` — asserts that after `abort_handle.abort()` no further emissions occur even across a long `advance()`.

### `apps/desktop/src-tauri/Cargo.toml`

- Added `"test-util"` feature to the `dev-dependencies` tokio entry so `tokio::time::{advance, pause}` and `#[tokio::test(start_paused = true)]` work for the heartbeat tests.

### `apps/desktop/src/ipc/encode.ts`

- `RecordingEvent` TS union gains `{ type: "audio-unavailable"; reason: string }` and `{ type: "heartbeat"; seq: number | bigint }` variants matching the auto-generated kebab-case tags from `packages/shared-types/src/ipc.ts` (landed in 17-01).

### `apps/desktop/src/ipc/automation.ts`

- New exported `AutomationChannelHandle` type (subset of `Channel` — just `onmessage`) and a third `onChannelReady` callback on `launchAutomation(...)`. Callers can now hold a reference to the live automation Channel so they can null its `onmessage` on component unmount (D-14 requirement).

### `apps/desktop/src/features/recorder/recording-view.tsx`

- **D-13.** New local state `const [audioUnavailable, setAudioUnavailable] = useState(false)`. Dispatch switch gains `case "audio-unavailable": toast.error(\`Audio unavailable: ${event.reason}\`); setAudioUnavailable(true)`. `handleRecord` resets it to `false` at entry. Header renders a persistent warning badge "Audio unavailable — recording video only" next to the Live pill while the flag is true.
- **D-14.** New refs: `abortControllerRef: useRef<AbortController | null>(null)` and `automationChannelRef: useRef<AutomationChannelHandle | null>(null)`. The preflight `useEffect` cleanup now does:
  1. `automationChannelRef.current.onmessage = null` (primary defense against stale dispatch on unmounted tree)
  2. Capture `sessionRef.current` into `sid`, null the ref, then `void stopRecording(sid).catch(...)` — detached so cleanup stays synchronous
  3. `abortControllerRef.current?.abort()`
  4. Then the existing `reset()`.

  Both `launchAutomation` call sites now pass `(ch) => { automationChannelRef.current = ch }` as the third argument. `handleRecord` spawns a fresh `AbortController` per start.
- **D-15.** New ref `lastHeartbeatRef: useRef<number | null>(null)` and state `const [desynced, setDesynced] = useState(false)`. Dispatch switch gains `case "heartbeat"` that stamps `Date.now()` and clears `desynced`. New 1s watchdog `useEffect` gated on `status === "recording"` flips `desynced=true` when `Date.now() - lastHeartbeatRef.current > 5000`. New banner renders below the permission/Stage Manager banners when `desynced && (status === "recording" || status === "paused")`, with a "Force stop" button. `forceStop` calls `stopRecording(sid)`, tolerates `NotFound` (session already gone), and always resets status → idle.

### New tests

- `apps/desktop/src/features/recorder/audio-unavailable.test.ts` — behavioral test for the dispatch branch: `audio-unavailable` event → `toast.error("Audio unavailable: …")` + flag flips true.
- `apps/desktop/src/features/recorder/unmount-cleanup.test.ts` — exercises the cleanup closure directly: channel-handler-nulled, `stopRecording` called with the captured session id, AbortController aborted, idempotent when session is null, tolerant of stopRecording rejection.
- `apps/desktop/src/features/recorder/heartbeat-watchdog.test.ts` — vitest fake timers with `toFake: [setInterval, clearInterval, Date]`:
  - watchdog stays quiet while heartbeats arrive within 5s
  - flips `desynced=true` after 5s gap
  - clears on fresh heartbeat
  - forceStop path calls stopRecording + returns to idle on NotFound

## Decisions Covered

| Decision | Coverage |
|----------|----------|
| D-13 | Both mic-failure sites emit `AudioUnavailable`; renderer renders toast + persistent badge. |
| D-14 | Unmount cleanup nulls automation Channel handler, stops live session via detached promise, aborts in-flight AbortController; `launchAutomation` surfaces the Channel via `onChannelReady`. |
| D-15 | 2s `tokio::time::interval` heartbeat ticker with monotonic `seq: u64`; AbortHandle in both `SpawnAbortGuard` and `RecordingHandle.heartbeat_abort`; FE 1s watchdog + desync banner + Force Stop button. |

## Verification

| Command | Result |
|---------|--------|
| `cargo check -p storycapture` | exit 0 |
| `cargo test -p storycapture --lib first_frame_and_fifo_tests` | 6/6 passed (2 new heartbeat tests) |
| `cargo test -p storycapture --lib -- --test-threads=1` | 70 passed, 1 ignored |
| `pnpm --filter desktop typecheck` | exit 0 |
| `pnpm --filter desktop exec vitest run src/features/recorder/` | 10 files, 72/72 passed (9 new tests) |
| Acceptance greps (Rust) | `AudioUnavailable` ≥1 (5), `Heartbeat { seq` ≥1 (1), `interval(Duration::from_secs(2))` ≥1 (3) |
| Acceptance greps (TS) | `audio-unavailable` ≥1 (1), `Audio unavailable` ≥1 (2), `onmessage = null` ≥1 (1), `sessionRef.current` ≥2 (15), `stopRecording` ≥1 (7), `AbortController` ≥2 (3), `heartbeat` ≥1 (9), `out of sync` ≥1 (2), `Force stop` ≥1 (3) |

### Out-of-scope items NOT fixed (pre-existing, per CLAUDE.md SCOPE BOUNDARY)

- **Clippy:** `cargo clippy -p storycapture --lib --no-deps -- -D warnings` surfaces 15 pre-existing errors across `commands/{automation,nl,tts,upload,web_sync}.rs`, `commands/{audio,parse}.rs`, `title_hints.rs`, `crates/story-parser/src/lenient_tokenize.rs`. Zero findings in files touched by this plan (`commands/encode.rs`). Matches the baseline documented in 17-02 and 17-04 summaries.
- **Biome:** Pre-existing a11y / `useButtonType` findings in the unchanged `PermissionBanner` subcomponent of `recording-view.tsx`. Same count before and after this plan's changes (verified via `git stash` diff in session). No new findings in the lines landed by 17-05.
- **Vitest (whole-suite):** 8 pre-existing failures in `settings/AccountsPage.test.tsx`, `nl-mode/ChatPanel.test.tsx`, `components/command-palette/__tests__/command-palette.test.tsx` — none in `features/recorder/`. Confirmed pre-existing baseline (unchanged by 17-05).

## Deviations

1. **Used `on_event: Channel<RecordingEvent>` directly instead of `session_event_tx: mpsc::Sender`.** The plan action sketch uses `session_event_tx.send(...).await`. The actual code path uses the Tauri `Channel<T>` already threaded through `start_recording` as `on_event: Channel<RecordingEvent>`. `Channel::send` is synchronous (returns `tauri::Result`, not a future), so no `.await`. No functional difference: the Channel is the renderer-facing event pipe; the mpsc pattern would just add a hop.

2. **`RecordingHandle.heartbeat_abort: Option<AbortHandle>` instead of a shared `Arc<AtomicBool> stop_flag`.** The plan text describes a stop_flag read per iteration + manual loop break. The spawned `AbortHandle` already gives deterministic cancellation (the abort drops the future mid-await, freeing the channel and the interval). A separate atomic flag would be redundant state that can disagree with the spawn's actual liveness. `SpawnAbortGuard` in 17-02 also uses AbortHandle exclusively — this matches the existing pattern. Both teardown paths (`stop_recording_inner`, `drain_one`) abort the handle before awaiting the encoder join.

3. **Heartbeat test uses behavioral `tokio::time::advance` + `yield_now` loops instead of real wall-clock sleeps.** This avoids 6-8s of real time per test run. Trade-off: the assertion is "≥3 emissions, monotonic starting at 0" rather than "exactly [0,1,2]" — the exact count depends on how many yields the runtime needs to schedule the spawned task between advances. The contract (monotonic, starts at 0) is still locked.

4. **Three dedicated Vitest behavioral tests instead of one full-mount `recording-view` test.** Mounting `RecordingView` requires mocking `listen`, `checkScreenCapturePermission`, `requestScreenCaptureAccess`, `isStageManagerEnabled`, `parseStory`, `launchAutomation`, the recorder Zustand store, `TargetPicker`, `VideoOutputSection`, `CursorTrail`, `LivePreview`, `TargetThumbnail` — plus happy-dom cannot provide a real ResizeObserver. The `double-start-guard.test.ts` (17-03) set the precedent: test the **decision logic** in isolation against mock refs/state. This keeps tests fast and decoupled from rendering concerns that are out of scope for lifecycle correctness.

5. **Left the `{ type: "heartbeat"; seq: number | bigint }` union as `number | bigint` instead of only `bigint`.** The auto-generated `packages/shared-types/src/ipc.ts` uses `bigint` because Rust `u64` exceeds safe JS `number`. The hand-written wrapper in `src/ipc/encode.ts` uses `number | bigint` so test fixtures can use plain `number` literals and production code can still accept the bigint from tauri-specta. No runtime guard added — the watchdog only reads `Date.now()`, never the seq value, so the discriminant is unused operationally.

## Stash-pop recovery note

During verification, a `git stash` of a clean worktree followed by `git stash pop` introduced synthetic "Updated upstream / Stashed changes" conflict markers in 4 files (`recording-view.tsx`, `title-hints.ts`, `browser-presets.ts`, `commands/automation.rs`). The stash was empty (`No local changes to save`) — git still creates the merge-conflict state when popping into a clean tree, which is a stash quirk. All four files were restored via `git checkout HEAD -- <paths>` since HEAD was already the correct post-5.3-commit state. Verified: no conflict markers remain in the repository, typecheck + all recorder tests green, git log shows the 3 intended commits untouched.

## Commits

- `e6517c9` feat(17-05): emit AudioUnavailable + show toast and badge on audio negotiation failure
- `4cefeb1` fix(17-05): teardown session, channel, and in-flight mutations on recording-view unmount
- `daa9d20` feat(17-05): emit Heartbeat every 2s + frontend watchdog with Force stop

## Self-Check: PASSED

- All listed `files_modified` / `files_added` paths exist with the documented edits (verified via grep sweep above).
- All three commits present in `git log --oneline -5`:
  - `e6517c9` — FOUND
  - `4cefeb1` — FOUND
  - `daa9d20` — FOUND
- `cargo test -p storycapture --lib first_frame_and_fifo_tests` passes 6/6 locally.
- `pnpm --filter desktop exec vitest run src/features/recorder/` passes 72/72 locally.
- `pnpm --filter desktop typecheck` exits 0.
- No conflict markers in `apps/desktop/` tree.
