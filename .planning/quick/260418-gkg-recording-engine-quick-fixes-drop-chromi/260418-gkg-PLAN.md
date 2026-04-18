---
phase: 260418-gkg
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - apps/desktop/src-tauri/src/commands/encode.rs
  - crates/encoder/src/pipeline.rs
  - crates/capture/src/pipeline.rs
autonomous: true
requirements:
  - QUICK-RECFIX-01
  - QUICK-RECFIX-02
  - QUICK-RECFIX-03
must_haves:
  truths:
    - "A user recording a real Chromium-titled window is not redirected to Playwright PID lookup."
    - "If the FFmpeg frame-pump task panics or errors early, ffmpeg stdin is closed deterministically (no ~15s SHUTDOWN_TIMEOUT wait)."
    - "The UI receives per-session frame-drop telemetry events emitted from the capture pipeline."
  artifacts:
    - path: apps/desktop/src-tauri/src/commands/encode.rs
      provides: "Playwright sentinel match restricted to 'storycapture-playwright'; new FramesDropped RecordingEvent variant."
    - path: crates/encoder/src/pipeline.rs
      provides: "RAII/scope-based guarantee that ffmpeg stdin is dropped on any unwind or early return."
    - path: crates/capture/src/pipeline.rs
      provides: "Periodic (~500ms) delta poll of QueueStats.dropped_frames, emitted via a drop-event callback."
  key_links:
    - from: "crates/capture/src/pipeline.rs"
      to: "apps/desktop/src-tauri/src/commands/encode.rs on_event Channel<RecordingEvent>"
      via: "callback / channel supplied by start_recording when constructing the CapturePipeline"
      pattern: "FramesDropped \\{"
---

<objective>
Three independent, atomically-committable fixes in the recording pipeline:

1. Drop stale "Chromium" Playwright sentinel in start_recording.
2. Guarantee FFmpeg stdin is dropped on panic / early-return in the encoder frame pump.
3. Surface per-session frame-drop telemetry to the UI via RecordingEvent.

Purpose: correctness (stop misdirecting real Chromium captures), reliability (prevent 15s sidecar hang on unwind), and observability (UI can show dropped frames).
Output: three focused commits on the main branch, each independently buildable and testable.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@CLAUDE.md
@.planning/STATE.md
@apps/desktop/src-tauri/src/commands/encode.rs
@crates/encoder/src/pipeline.rs
@crates/capture/src/queue.rs
@crates/capture/src/pipeline.rs

<interfaces>
From crates/capture/src/queue.rs:
```rust
#[derive(Debug, Clone, Copy, Default)]
pub struct QueueStats {
    pub total_pushed: u64,
    pub total_popped: u64,
    pub dropped_frames: u64,
    pub max_bytes_seen: usize,
}
impl ByteBoundedQueue {
    pub fn stats(&self) -> QueueStats;
}
```

From crates/capture/src/pipeline.rs:
```rust
pub struct CapturePipeline { /* owns queue: Arc<ByteBoundedQueue>, forwarder + consumer JoinHandles */ }
impl CapturePipeline {
    pub fn queue(&self) -> &Arc<ByteBoundedQueue>;
    pub async fn start(&mut self, cfg: CaptureConfig, out: mpsc::Sender<Frame>) -> Result<(), CaptureError>;
    pub async fn stop(&mut self) -> Result<CaptureStats, CaptureError>;
}
```

From apps/desktop/src-tauri/src/commands/encode.rs (current):
```rust
// RecordingEvent is the variant used by the on_event: Channel<RecordingEvent> parameter of start_recording.
// Locate its definition in this file (or re-export) and add a FramesDropped variant additively.
// Existing match around L290 treats Some("storycapture-playwright") | Some("Chromium") as sentinels — remove the "Chromium" arm.
```
</interfaces>
</context>

<tasks>

<task type="auto">
  <name>Task 1: Drop stale "Chromium" Playwright sentinel in start_recording</name>
  <files>apps/desktop/src-tauri/src/commands/encode.rs</files>
  <action>
In `start_recording` (around line 290), the `WindowByPid { title_hint, .. }` arm matches
`Some("storycapture-playwright") | Some("Chromium")` as the sentinel that triggers the
Playwright PID stash lookup. Commit f899d6a already removed the "Chromium" hint from
`resolve_playwright_target` in crates/automation, so the encode-side branch is now stale
and actively wrong — a user recording a real Chromium-titled window would be redirected
to PID stash lookup.

Remove ONLY the `Some("Chromium")` arm. Keep `Some("storycapture-playwright")` as the
sole explicit sentinel. Do not touch the fallback `_ => args.target.clone().into()` arm.
Do not rename the sentinel. Do not touch surrounding error text or logging.

Read lines ~285-320 first to confirm exact syntax before editing.

Commit message (no Co-Authored-By trailer, per CLAUDE.md):
  fix(recording): drop stale 'Chromium' Playwright sentinel in start_recording
  </action>
  <verify>
    <automated>cargo check -p storycapture-desktop 2>&amp;1 | tail -20</automated>
  </verify>
  <done>
- Match arm in `start_recording` contains only `Some("storycapture-playwright")` as the Playwright sentinel.
- `cargo check -p storycapture-desktop` succeeds.
- No other behavior changes in this file.
- Commit created with message above, no Co-Authored-By trailer.
  </done>
</task>

<task type="auto">
  <name>Task 2: RAII guard to close FFmpeg stdin on unwind / early return</name>
  <files>crates/encoder/src/pipeline.rs</files>
  <action>
Problem: in `EncodePipeline::start`, the spawned frame-pump task owns `stdin` by move.
On normal channel-close it executes `drop(stdin)` explicitly (L181). But on panic OR on
early `return Err(EncoderError::Io(format!("stdin write: {e}")))` (L174), `stdin` is
still live at function exit — dropped at task teardown, but in the error path the
`child.wait()` path below is skipped, and in the panic path Tokio's drop order for
captured locals is not guaranteed to close stdin before other teardown. The practical
symptom is that on any non-normal exit FFmpeg may wait for EOF until SHUTDOWN_TIMEOUT
(~15s) before being force-killed.

Fix: introduce a small RAII guard inside the spawned task that owns the stdin handle
and explicitly closes/drops it in `Drop`. Pattern:

```rust
struct StdinGuard(Option<tokio::process::ChildStdin>);
impl StdinGuard {
    fn as_mut(&mut self) -> &mut tokio::process::ChildStdin {
        self.0.as_mut().expect("stdin guard used after take")
    }
    fn take(&mut self) -> Option<tokio::process::ChildStdin> { self.0.take() }
}
impl Drop for StdinGuard {
    fn drop(&mut self) {
        // Dropping ChildStdin closes the pipe, signaling EOF to ffmpeg.
        // Explicit drop here also runs on panic unwind.
        let _ = self.0.take();
    }
}
```

Usage inside the spawned task:
- Wrap `stdin` as `let mut stdin = StdinGuard(Some(stdin));` right at the top of the task.
- Replace `stdin.write_all(...)` with `stdin.as_mut().write_all(...)`.
- Replace the explicit normal-path `drop(stdin);` (L181) with `drop(stdin.take());` OR
  simply let the guard drop at end of scope — whichever keeps the "frame channel closed;
  signaling FFmpeg EOF" tracing::info ordering intact (EOF must happen BEFORE `child.wait()`).
- Ensure the error path `return Err(EncoderError::Io(format!("stdin write: {e}")))`
  still fires the `Drop` impl (it will, since the guard is a local).

Verification that panic propagation is preserved: do not wrap in `catch_unwind`; the
guard's `Drop` runs during stack unwind, and the panic continues to propagate to the
JoinHandle as before.

Do NOT touch the macOS VT fast path (try_start_vt_fast_path) — it has no stdin.

Commit message:
  fix(encoder): close ffmpeg stdin via RAII guard on unwind/early-return
  </action>
  <verify>
    <automated>cargo build -p encoder &amp;&amp; cargo test -p encoder 2>&amp;1 | tail -40</automated>
  </verify>
  <done>
- A guard struct (or equivalent RAII pattern) owns stdin inside the pump task.
- Explicit `drop` of the guard still happens before `child.wait()` on the normal path (preserving the existing EOF-before-wait ordering and tracing log).
- Any error return (`stdin write: ...`) or panic causes stdin to close via `Drop` before the task finishes.
- Existing test `bgra_bytes_of_frame_owned_round_trip` still passes.
- `cargo build -p encoder` succeeds; no new clippy warnings introduced.
- Commit created with message above, no Co-Authored-By trailer.
  </done>
</task>

<task type="auto">
  <name>Task 3: Export per-session frame-drop telemetry as RecordingEvent</name>
  <files>
apps/desktop/src-tauri/src/commands/encode.rs
crates/capture/src/pipeline.rs
  </files>
  <action>
Part A — Define the event (apps/desktop/src-tauri/src/commands/encode.rs):
- Locate the `RecordingEvent` enum used by `on_event: Channel<RecordingEvent>`.
- Add a new variant ADDITIVELY (do not rename/remove/reorder existing variants):
  ```rust
  FramesDropped { total: u64, delta: u64 }
  ```
- If the enum is `#[serde(tag = "type", ...)]` or has specta derives, follow the same
  derives/attributes pattern as existing variants so TS bindings regenerate cleanly.

Part B — Emit from capture pipeline (crates/capture/src/pipeline.rs):
- Extend `CapturePipeline::start` signature with an optional drop-event callback:
  ```rust
  pub async fn start(
      &mut self,
      cfg: CaptureConfig,
      out: mpsc::Sender<Frame>,
      on_drop: Option<Box<dyn Fn(u64, u64) + Send + Sync>>, // (total, delta)
  ) -> Result<(), CaptureError>
  ```
  Keep this trait-object-flavored (not a generic) so the signature stays object-safe
  and the caller in encode.rs can pass `None` or a closure without churn.
- Spawn a lightweight tokio task alongside the forwarder/consumer that polls
  `queue.stats().dropped_frames` every 500ms:
  - Track `last_total: u64`.
  - Compute `delta = total - last_total`.
  - If `delta >= 1` and the callback is `Some`, invoke it with `(total, delta)` and
    update `last_total`.
  - Exit the task when the queue is closed (detect via a cheap `queue.stats` tick +
    checking that both forwarder and consumer have completed, OR via a cancellation
    token owned by the pipeline — whichever matches existing shutdown idiom; simplest
    is a `tokio::select!` against a oneshot cancel channel, stored on `CapturePipeline`
    and fired in `stop()`).
- Store the cancel handle on `CapturePipeline` so `stop()` can signal the telemetry
  task to exit, then await it (drop errors silently — telemetry is best-effort).
- Callback invocation MUST NOT block capture: the callback is expected to be a cheap
  non-blocking send (e.g. Tauri `Channel::send`, which returns a `Result` we ignore).

Part C — Wire in start_recording (apps/desktop/src-tauri/src/commands/encode.rs):
- At the call site where `CapturePipeline::start(...)` is invoked (locate via grep
  within encode.rs), build the callback:
  ```rust
  let on_event_for_drops = on_event.clone(); // Channel<RecordingEvent> is Clone
  let drop_cb: Option<Box<dyn Fn(u64, u64) + Send + Sync>> =
      Some(Box::new(move |total, delta| {
          let _ = on_event_for_drops.send(RecordingEvent::FramesDropped { total, delta });
      }));
  ```
  If `Channel<RecordingEvent>` is not `Clone` in this Tauri version, wrap it in `Arc`
  once and clone the Arc.
- Pass `drop_cb` as the new pipeline.start() argument. All other `CapturePipeline::start`
  call sites in the repo (if any) pass `None`.

Constraints:
- Telemetry is best-effort. If the Channel send fails, log at `tracing::debug` and
  continue — never block, never retry, never panic.
- Do not change cadence if the codebase already emits progress at a different fixed
  interval that can piggyback; in that case reuse the existing tick. Default: 500ms
  interval in its own task.
- Do not alter `QueueStats` or `ByteBoundedQueue` public API.

Commit message:
  feat(recording): emit per-session FramesDropped telemetry to UI
  </action>
  <verify>
    <automated>cargo build -p capture -p storycapture-desktop &amp;&amp; cargo test -p capture 2>&amp;1 | tail -40</automated>
  </verify>
  <done>
- `RecordingEvent::FramesDropped { total, delta }` exists with matching serde/specta attributes.
- `CapturePipeline::start` takes an optional drop callback; all existing call sites compile.
- A 500ms-cadence task emits `(total, delta)` only when `delta >= 1` and exits cleanly on `stop()`.
- `start_recording` wires the callback to send `RecordingEvent::FramesDropped` on `on_event`.
- Capture is never blocked by a slow/failed event channel.
- `cargo build` + `cargo test -p capture` succeed.
- Commit created with message above, no Co-Authored-By trailer.
  </done>
</task>

</tasks>

<verification>
- `cargo build --workspace` succeeds.
- `cargo test -p encoder -p capture` succeeds.
- `cargo check -p storycapture-desktop` succeeds.
- `git log --oneline -3` shows three commits, one per task, each buildable on its own (Task 1 and Task 2 are fully independent; Task 3 may sit on top of either).
- No commit message contains `Co-Authored-By`.
</verification>

<success_criteria>
- Three atomic commits land on main in conventional-commit style matching recent history.
- Recording a real window with title containing "Chromium" goes through normal pid-capture (no Playwright stash redirect).
- When the encoder frame-pump returns early with an error (simulate by closing stdin mid-stream in a manual test, OR infer via code review), ffmpeg receives EOF immediately; no 15s SHUTDOWN_TIMEOUT in the log.
- During a recording where the capture queue drops frames, the UI's RecordingEvent channel receives at least one `FramesDropped { total, delta }` event with `delta >= 1`.
</success_criteria>

<output>
After completion, create `.planning/quick/260418-gkg-recording-engine-quick-fixes-drop-chromi/260418-gkg-SUMMARY.md` capturing:
- The three commit SHAs and messages.
- File-level diff summary.
- Any follow-ups or deferred telemetry surfaces.
</output>
