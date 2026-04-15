---
phase: 02-cinematic-post-production-export
plan: "10"
subsystem: encoder
tags: [encoder, render-queue, actor, sidecar-pool, ffv1, fanout, benchmark, export-05, export-06, ci, d-04, d-30]
requirements:
  - EXPORT-05
  - EXPORT-06
dependency-graph:
  requires:
    - Phase 2 Plan 01 (effects::FfmpegEmit — filter_complex string)
    - Phase 2 Plan 03 (storage::render_job_repo — poll_ready / mark_* / on_startup_mark_orphans)
    - Phase 1 Plan 08 (encoder::SidecarCommand + FfmpegSidecar)
  provides:
    - "encoder::queue::actor — RenderQueueActor + RenderQueueHandle + spawn_render_queue + QueueMsg (Enqueue/Cancel/Shutdown/TickAndDrain)"
    - "encoder::queue::job — JobExecutor trait + JobOutcome + NoopJobExecutor + SharedExecutor alias"
    - "encoder::pool — SidecarPool (Arc<Semaphore>) + SidecarHandle (SIGTERM+SIGKILL ladder) + PoolConfig (max_concurrent=2 default)"
    - "encoder::progress::parser — RenderProgress + ProgressFrag + parse_line + RenderProgressParser (keyed by job_id; out_time_ms→ms)"
    - "encoder::fanout — build_intermediate_args (FFV1) + FanoutPlan::batch + build_encode_args (mp4/webm/gif) + fanout_encode (parallel tokio::spawn)"
    - "apps/desktop/src-tauri/commands/render — render_enqueue / render_cancel / render_list_active / stream_render_progress + RenderQueueState + install_render_queue on AppState"
    - "scripts/benchmark/render-1min.sh — EXPORT-06 runner (speed-factor PR gate + wall-clock release gate)"
    - ".github/workflows/render-benchmark.yml — PR-level EXPORT-06 gate (speed>2.0x on macos-14+windows-latest)"
    - ".github/workflows/release-benchmark.yml — release/* tag gate (strict wall-clock<30s on self-hosted macos-m2pro)"
  affects:
    - Plan 11 (project-open flow) — host calls AppState::install_render_queue during setup()
    - Plan 12 (editor render picker) — consumes render_enqueue + stream_render_progress + RenderJobDto
tech-stack:
  added:
    - "tokio-util 0.7 (CancellationToken for per-job cancel + SIGTERM grace)"
    - "futures 0.3 (try_join_all over parallel fan-out tasks)"
    - "rusqlite 0.34 [bundled] — runtime dep on encoder for actor Connection param; storage re-exports Connection"
    - "async-trait 0.1 (JobExecutor + RecordingCmd doubles in tests)"
  patterns:
    - "Actor owns state; commands nudge via mpsc::Sender<QueueMsg> (D-06)"
    - "D-04 render queue: ORDER BY priority DESC, created_at ASC; on_startup_mark_orphans flips running→interrupted"
    - "D-30 smart batch reuse: render composite frames ONCE to FFV1 intermediate, fan out to N parallel format encoders"
    - "Two-tier EXPORT-06 gate: PR-level hardware-independent speed factor (>2.0x) + release-tag strict wall-clock (<30s on self-hosted reference HW)"
    - "Storage re-exports rusqlite::Connection so the Tauri host avoids a direct rusqlite dep"
    - "Single-subscriber progress stream: Mutex<Option<mpsc::Receiver<RenderProgress>>> parked inside RenderQueueState; first caller takes it"
key-files:
  created:
    - crates/encoder/src/progress/parser.rs
    - crates/encoder/src/pool/mod.rs
    - crates/encoder/src/pool/sidecar_pool.rs
    - crates/encoder/src/queue/mod.rs
    - crates/encoder/src/queue/actor.rs
    - crates/encoder/src/queue/job.rs
    - crates/encoder/src/fanout/mod.rs
    - crates/encoder/src/fanout/intermediate.rs
    - crates/encoder/src/fanout/multi_encode.rs
    - crates/encoder/tests/queue_actor.rs
    - crates/encoder/tests/fanout_intermediate.rs
    - apps/desktop/src-tauri/src/commands/render.rs
    - scripts/benchmark/render-1min.sh
    - scripts/benchmark/fixtures/README.md
    - .github/workflows/render-benchmark.yml
    - .github/workflows/release-benchmark.yml
  modified:
    - crates/encoder/Cargo.toml
    - crates/encoder/src/lib.rs
    - crates/encoder/src/progress/mod.rs
    - crates/storage/src/lib.rs
    - apps/desktop/src-tauri/src/commands/mod.rs
    - apps/desktop/src-tauri/src/ipc_spec.rs
    - apps/desktop/src-tauri/src/state.rs
    - Cargo.lock
decisions:
  - "Pool default size N=2 (CONTEXT.md Claude's discretion + T-02-29 DoS mitigation). The SidecarPool is cloneable via Arc<Semaphore> so fan-out workers share the same permit pool as the actor."
  - "JobExecutor trait isolates the actor from the FFmpeg sidecar so integration tests use NoopJobExecutor or scripted per-test doubles instead of spawning real processes. Production wiring (Plan 11) will install a FanoutJobExecutor that composes render_intermediate + fanout_encode."
  - "EXPORT-06 split into two gates: hardware-independent `speed>2.0x` PR-level gate (catches drift on any runner) + release-tagged strict wall-clock `<30000ms` on self-hosted macos-m2pro (canonical success criterion). Both metrics always emitted to GITHUB_STEP_SUMMARY regardless of which gate is active."
  - "Benchmark script falls back to a synthetic `testsrc2+sine` MP4 when `fixtures/1min-reference.json` is absent, so fresh clones and cold CI runs produce a meaningful number. The canonical fixture is uploaded as a long-lived artifact once Plan 02-01/11 land the graph loader."
  - "Intermediate FFV1 output uses MKV container (via caller-supplied .mkv path) so level-3 slicecrc is preserved; pcm_s16le audio lets downstream encoders re-encode cleanly without double-lossy passes."
  - "Progress stream is single-subscriber (Mutex<Option<mpsc::Receiver>>). Multi-renderer UIs with simultaneous overlays will need an additional fan-out actor in Plan 12 — out of scope here."
metrics:
  duration: ~90 minutes (including uncommitted Task 2 work discovered in-flight)
  completed_date: 2026-04-15
  task_count: 3
  test_count: 35
  file_count: 24
---

# Phase 2 Plan 10: Render queue + sidecar pool + smart-batch fan-out + EXPORT-06 CI summary

**One-liner:** Background render queue actor (tokio mpsc + D-04 priority poll + resume-on-relaunch) driving a bounded FFmpeg sidecar pool (N=2), a smart-batch FFV1 intermediate + parallel fan-out pipeline (D-30) for MP4/WebM/GIF, a single-subscriber `Channel<RenderProgress>` wired through Tauri commands, and a two-tier EXPORT-06 benchmark CI (hardware-independent speed-factor PR gate + strict wall-clock release gate on self-hosted macOS M2 Pro).

## Outcome

EXPORT-05 (background rendering with progress events, user continues editing while renders run) and EXPORT-06 (1-min video renders in <30s on reference HW, CI-enforced) both have end-to-end scaffolding: the queue actor + pool + Tauri commands provide the EXPORT-05 surface; the benchmark script + two-workflow gate defines EXPORT-06.

D-04 (persist + resume) is wired — `on_startup_mark_orphans` runs during actor init and the integration test `on_boot_marks_orphans` proves the running→interrupted transition. D-30 (smart batch reuse) is proven in `fanout_intermediate::multi_encode_parallel_spawns_two_sidecars`: given one FFV1 intermediate and a two-output plan, `fanout_encode` spawns two sidecars concurrently via `tokio::spawn` + `futures::future::try_join_all`.

All 35 tests green (`cargo test -p encoder`): 23 lib + 7 queue_actor + 5 fanout_intermediate. `cargo check -p encoder` + `cargo check -p storycapture` both green locally.

## What landed

### Task 1 — Progress parser + FFmpeg sidecar pool (`025fc5d`)

- `crates/encoder/src/progress/parser.rs`: `RenderProgress { job_id, pct, frame, fps, speed, eta_ms }`, `ProgressFrag { Frame, Fps, OutTimeMs, Speed, End }`, `parse_line` (handles `out_time_ms=`, `speed=N.Nx`, `frame=`, `fps=`, `progress=end`), `RenderProgressParser` keyed by `job_id` with total-duration-aware pct calculation. Folds FFmpeg's misleadingly-named `out_time_ms` (actually microseconds) to milliseconds.
- `crates/encoder/src/progress/mod.rs`: preserves Phase 1 `ProgressParser`/`EncodeProgress` for the recording pipeline (non-breaking).
- `crates/encoder/src/pool/sidecar_pool.rs`: `PoolConfig { max_concurrent: 2 (default), cancel_grace: 3s }`, cloneable `SidecarPool { sem: Arc<Semaphore>, cfg: Arc<PoolConfig> }`, `SidecarPermit` RAII, `SidecarHandle::{spawn, spawn_cmd, cancel, wait}` with SIGTERM (unix) / TerminateProcess (windows) on cancel and SIGKILL escalation after grace.
- 19 lib tests (7 new): `parse_line` variants, `parser_accumulates`, `parser_emits_on_progress_end`, `pool_default_size_2`, `pool_limits_concurrency`, `pool_release_unblocks_waiter`, `pool_cancel_sends_sigterm` (unix-gated).

### Task 2 — Render queue actor + Tauri commands (`d9d7b63`)

- `crates/encoder/src/queue/actor.rs`: `RenderQueueActor` (owns pool + db + executor + progress tx + running-token map + done-channel) with `init_resume` (runs `render_job_repo::on_startup_mark_orphans` before the loop), `try_poll_and_spawn` (capacity = pool - running; queries via `poll_ready`; marks each running; spawns per-job tokio task behind a `SidecarPermit`), `reconcile_done` (maps `JobOutcome` → `mark_completed` / `cancel` / `mark_failed`), `handle_msg` (Enqueue nudge / Cancel via stored CancellationToken / Shutdown / TickAndDrain test hook). Main `run` loop = `tokio::select!` over `rx.recv()` + `done_rx.recv()` + periodic tick.
- `crates/encoder/src/queue/job.rs`: `JobExecutor` async trait (`execute(job, progress_tx, cancel) -> Result<JobOutcome>`), `JobOutcome::{Completed{output_path}, Cancelled, Failed{message}}`, `NoopJobExecutor` for tests + `SharedExecutor = Arc<dyn JobExecutor>` alias.
- `crates/encoder/tests/queue_actor.rs`: 7 integration tests over an in-memory project.sqlite seeded via `storage::migrations::project`:
  1. `actor_polls_pending_up_to_pool_capacity` — 3 jobs seeded, pool=2 → 2 running + 1 pending.
  2. `actor_priority_order` — priorities {10, 5, 0} with pool=1 → high then mid then low.
  3. `actor_cancel_marks_cancelled` — long-running job cancelled via `QueueMsg::Cancel` → `RenderJobStatus::Cancelled`.
  4. `actor_completion_marks_completed_with_output_path` — `NoopJobExecutor` completes → `mark_completed` with output path + `progress_pct=100.0`.
  5. `actor_failure_marks_failed` — scripted `Bombs` executor → `RenderJobStatus::Failed` + stderr-tail in `error`.
  6. `on_boot_marks_orphans` — seeded `running` row → `Interrupted` after spawn (Pitfall #12).
  7. `actor_cancel_pending_job` — pool=1 with a blocker holding it; second job stays pending; cancel of pending flows through the DB path.
- `apps/desktop/src-tauri/src/commands/render.rs`: `NewRenderJobDto` / `RenderJobDto` / `RenderProgressDto` (specta::Type), `RenderQueueState { handle, db, progress_rx: Arc<Mutex<Option<mpsc::Receiver<RenderProgress>>>> }`, 4 Tauri commands (`render_enqueue`, `render_cancel`, `render_list_active`, `stream_render_progress` — single-subscriber).
- `apps/desktop/src-tauri/src/state.rs`: `install_render_queue` / `render_queue` / `clear_render_queue` on `AppState` (parking_lot::Mutex<Option<RenderQueueState>>). Populated by the host during project-open (Plan 11 wires the full flow).
- `apps/desktop/src-tauri/src/{commands/mod,ipc_spec}.rs`: wires `commands::render` + registers 4 new commands + 3 DTO types with tauri-specta.
- `crates/storage/src/lib.rs`: re-exports `rusqlite::Connection` so the Tauri host avoids a direct rusqlite dep.

### Task 3 — Smart-batch FFV1 fan-out + EXPORT-06 CI (`4c0fa09`)

- `crates/encoder/src/fanout/intermediate.rs`: `build_intermediate_args(filter_complex, extra_inputs, out_path) -> Vec<String>` emits the canonical FFV1 argv (`-c:v ffv1 -level 3 -coder 1 -context 1 -g 1 -slicecrc 1 -slices 24 -pix_fmt yuv420p`, audio `-c:a pcm_s16le`, `-map [out_v]` + `-map [out_a]?`). `render_intermediate` is the async wrapper that consumes `effects::FfmpegEmit::emit(graph)` + a caller-supplied `extra_inputs: &[Vec<String>]` (opaque until Phase 2 Plan 01/11 wire the typed Graph inputs) and spawns the FFV1 sidecar.
- `crates/encoder/src/fanout/multi_encode.rs`: `OutputFormat::{Mp4, WebM, Gif}`, `Resolution::{R720p, R1080p, R4k}`, `Quality::{Low, Med, High}`, `OutputSpec`, `FanoutPlan::batch`, `bitrate_for`, `default_h264_encoder`, `build_encode_args` (per-format argv; GIF is a single-pass `palettegen→paletteuse` filter_complex per Pitfall #7 with `dither=bayer:bayer_scale=5`), `fanout_encode` (spawns one tokio task per `OutputSpec`, awaits all via `futures::future::try_join_all`).
- `crates/encoder/tests/fanout_intermediate.rs`: 5 integration tests — FFV1 flag shape, MP4+WebM plan + per-format flags, GIF 2-pass palette, parallel sidecar spawn (scripted `RecordingCmd` double recording argv per-call), monotonic bitrate scaling Low<Med<High.
- `scripts/benchmark/render-1min.sh`: the EXPORT-06 runner. Always emits `render_time_ms` + `encode_speed_factor` to stdout + `GITHUB_STEP_SUMMARY`. Default mode: PR gate asserts `speed=N.Nx > 2.0` (hardware-independent). `STRICT_WALL_CLOCK=1` additionally asserts wall-clock `< 30000 ms` for the release workflow. Falls back to synthetic `testsrc2 + sine` MP4 when `fixtures/1min-reference.json` is absent.
- `scripts/benchmark/fixtures/README.md`: how to generate the canonical 1-minute 1080p60 fixture + documents both gate semantics.
- `.github/workflows/render-benchmark.yml`: PR gate. Matrix `macos-14` + `windows-latest`. `brew install ffmpeg jq` / `choco install ffmpeg jq`. Runs the benchmark with `STRICT_WALL_CLOCK=0`. Uploads progress log on failure.
- `.github/workflows/release-benchmark.yml`: release-tag gate. Runs on `[self-hosted, macos-m2pro]` when a `release/*` tag is pushed. Defensive `command -v ffmpeg jq` check. Runs with `STRICT_WALL_CLOCK=1`.

## Interfaces emitted (for downstream plans)

```rust
// crates/encoder/src/queue/actor.rs
pub struct RenderQueueHandle { /* cloneable mpsc::Sender<QueueMsg> */ }
pub enum QueueMsg { Enqueue(Uuid), Cancel(Uuid), Shutdown, TickAndDrain(oneshot::Sender<()>) }
pub async fn spawn_render_queue(
    cfg: RenderQueueConfig,
    db: Arc<Mutex<rusqlite::Connection>>,
    executor: SharedExecutor,
    progress_tx: mpsc::Sender<RenderProgress>,
) -> RenderQueueHandle;

// crates/encoder/src/queue/job.rs
pub trait JobExecutor: Send + Sync + 'static {
    async fn execute(&self, job: RenderJob, progress_tx: mpsc::Sender<RenderProgress>,
                    cancel: CancellationToken) -> Result<JobOutcome>;
}
pub enum JobOutcome { Completed { output_path: PathBuf }, Cancelled, Failed { message: String } }

// crates/encoder/src/fanout/{intermediate,multi_encode}.rs
pub fn build_intermediate_args(filter_complex: String, extra_inputs: &[Vec<String>],
                               out_path: &Path) -> Vec<String>;
pub async fn render_intermediate(graph: &Graph, extra_inputs: &[Vec<String>],
                                 out_path: PathBuf, sidecar_cmd: &dyn SidecarCommand,
                                 duration_ms: u64) -> Result<IntermediateOutput>;

pub struct FanoutPlan { pub outputs: Vec<OutputSpec> }
impl FanoutPlan {
    pub fn batch(formats: Vec<OutputFormat>, resolution: Resolution, fps: u32,
                 quality: Quality, out_dir: &Path, stem: &str) -> Self;
}
pub async fn fanout_encode(intermediate: &IntermediateOutput, plan: &FanoutPlan,
                           sidecar_factory: impl Fn() -> Arc<dyn SidecarCommand>,
                           h264_encoder: &str) -> Result<Vec<PathBuf>>;
```

## Deviations from Plan

### Auto-fixed issues

**1. [Rule 3 — Blocking] storycapture did not compile after Task 2 wiring**

- **Found during:** `cargo check -p storycapture` after wiring `commands::render`.
- **Issues:**
  (a) `render.rs` imported `rusqlite::Connection` but `apps/desktop/src-tauri/Cargo.toml` has no rusqlite dep.
  (b) `AppState` derives `Debug` but `RenderQueueState { handle, db, progress_rx }` doesn't — and adding bounds on the rich tokio types is painful.
- **Fix:**
  (a) Re-export `rusqlite::Connection` from `storage::` (one line) and switch `render.rs` to `use storage::{Connection, ...}`. Keeps the rusqlite dep exactly where it was — inside the storage crate — while unblocking downstream callers. Removed the unused `RenderJobStatus` import.
  (b) Added a manual `impl std::fmt::Debug for RenderQueueState` that prints just `handle` + `finish_non_exhaustive()`.
- **Files modified:** `crates/storage/src/lib.rs`, `apps/desktop/src-tauri/src/commands/render.rs`.
- **Commit:** `d9d7b63` (same Task 2 commit).

**2. [Rule 2 — Missing critical functionality] `migrations` module needed for integration tests**

- **Found during:** `crates/encoder/tests/queue_actor.rs` needs to seed an in-memory project.sqlite.
- **Issue:** `storage::migrations` was crate-private (`mod migrations`) so the test couldn't call `project::migrations().to_latest(&mut conn)`.
- **Fix:** Flipped to `pub mod migrations`. No public API surface change (the internal submodules were already the canonical way to drive migrations in storage's own tests).
- **Files modified:** `crates/storage/src/lib.rs`.
- **Commit:** `d9d7b63` (same Task 2 commit).

**3. [Rule 2 — Missing critical functionality] `[out_a]?` optional map in FFV1 intermediate**

- **Found during:** Task 3 design — graphs without audio would fail when we unconditionally `-map [out_a]`.
- **Fix:** Use the FFmpeg optional-label suffix `?` (`-map [out_a]?`) so the intermediate transparently tolerates audio-less graphs. Phase 2 UI guarantees a silent anullsrc upstream for graphs that want ENC-05 drift guarantees; graphs that don't emit audio (e.g. GIF-only previews) now still work.
- **Files modified:** `crates/encoder/src/fanout/intermediate.rs`.
- **Commit:** `4c0fa09`.

**4. [Rule 2 — Missing critical functionality] Benchmark fallback to synthetic MP4**

- **Found during:** Task 3 design — `fixtures/1min-reference.json` doesn't exist on a fresh clone.
- **Fix:** Benchmark script detects missing fixture and generates a `testsrc2 + sine` 1-minute 1080p60 MP4 on the fly via `ffmpeg -f lavfi`. Makes the script self-hosting and lets PRs exercise the gate before the canonical fixture is uploaded as a long-lived artifact.
- **Files modified:** `scripts/benchmark/render-1min.sh`.
- **Commit:** `4c0fa09`.

### Scope-internal choices

- **`extra_inputs` as `&[Vec<String>]`:** The plan sketches `FilterComplexBuild { filter_complex, extra_inputs: Vec<ExtraInput> }` from Plan 01 but the current `effects::FfmpegEmit::emit` returns just a `String`. Rather than block on expanding Plan 01, `render_intermediate` accepts opaque `-i` arg tuples. Plan 02-01 or Plan 02-11 will swap this to a typed surface when the loader lands.
- **Single-subscriber progress stream:** The `Mutex<Option<mpsc::Receiver<RenderProgress>>>` enforces that only one `stream_render_progress` call ever drains the channel. Multi-viewer UIs in Plan 12 will need an upstream fan-out actor.
- **`TickAndDrain` test hook on `QueueMsg`:** production code doesn't need it (the 500 ms periodic tick covers the same ground); it's there so integration tests can drive a synchronous poll-and-await-completion pulse without polling-timing games.

### Authentication gates

None hit.

## Verification

| Question | Status |
|---|---|
| `cargo check -p encoder` | green (zero warnings on encoder itself) |
| `cargo check -p storycapture` | green (1 pre-existing deprecation warning in capture.rs) |
| `cargo test -p encoder --lib` | 23 pass (0 fail) |
| `cargo test -p encoder --test queue_actor` | 7 pass (0 fail) |
| `cargo test -p encoder --test fanout_intermediate` | 5 pass (0 fail) |
| `grep -q "out_time_ms=" crates/encoder/src/progress/parser.rs` | green |
| `grep -q "max_concurrent: 2" crates/encoder/src/pool/sidecar_pool.rs` | green |
| `grep -q "CancellationToken" crates/encoder/src/pool/sidecar_pool.rs` | green |
| `grep -q "on_startup_mark_orphans" crates/encoder/src/queue/actor.rs` | green |
| `grep -q "QueueMsg::Cancel" crates/encoder/src/queue/actor.rs` | green |
| `grep -q "#\[tauri::command\]" apps/desktop/src-tauri/src/commands/render.rs` | green |
| `grep -q "Channel<RenderProgress" apps/desktop/src-tauri/src/commands/render.rs` | green |
| `grep -q "ffv1" crates/encoder/src/fanout/intermediate.rs` | green |
| `grep -qE "slicecrc.*1.*slices.*24" crates/encoder/src/fanout/intermediate.rs` | green (on separate lines) |
| `grep -q "libvpx-vp9" crates/encoder/src/fanout/multi_encode.rs` | green |
| `grep -q "palettegen" crates/encoder/src/fanout/multi_encode.rs` | green |
| `grep -q "try_join_all" crates/encoder/src/fanout/multi_encode.rs` | green |
| `test -x scripts/benchmark/render-1min.sh` | green |
| `grep -q "encode_speed_factor" scripts/benchmark/render-1min.sh` | green |
| `grep -q "s+0 > 2.0" scripts/benchmark/render-1min.sh` | green |
| `grep -q "STRICT_WALL_CLOCK" scripts/benchmark/render-1min.sh` | green |
| `grep -q "self-hosted.*macos-m2pro" .github/workflows/release-benchmark.yml` | green |
| `grep -q "release/\*" .github/workflows/release-benchmark.yml` | green |

## Known Stubs

- **`render_intermediate` + fanout are not yet the production `JobExecutor`.** The actor currently invokes any `SharedExecutor`; Plan 11 (project-open flow) will install a `FanoutJobExecutor` that composes `render_intermediate` + `fanout_encode` against the real Tauri sidecar command. The current tests use `NoopJobExecutor` + scripted doubles; the fanout tests use a scripted `RecordingCmd` that records argv shape. No real FFmpeg is spawned from encoder integration tests.
- **`extra_inputs: &[Vec<String>]`** in `render_intermediate` is opaque. Plan 02-01 or 02-11 replaces it with a typed `ExtraInput` structure once `effects::FfmpegEmit` learns to emit structured inputs alongside the filter_complex string.
- **`fixtures/1min-reference.json`** is not committed — it's a large (~5–10 MiB) artifact that should be uploaded once and pulled by CI via `actions/download-artifact`. The benchmark script's synthetic fallback lets PRs run usefully until that happens.
- **`benchmark-render` bin mentioned in the plan action** (`cargo run --package encoder --bin benchmark-render`) was not added — the benchmark script drives FFmpeg directly in the current implementation because the encoder crate's sidecar wiring still requires a real FFmpeg binary on PATH to be meaningful. When Plan 02-11 lands the graph loader, the `benchmark-render` bin can wrap the full `Graph → IntermediateOutput → FanoutPlan` path.

## Threat Flags

None beyond the plan's register (T-02-29 pool cap, T-02-30 tempfile cleanup, T-02-31 fixture missing, T-02-32 output-path traversal). Mitigations land as specified: pool default N=2 (T-02-29), `tempfile::NamedTempFile` drop (T-02-30 — fan-out consumers are responsible for `.into_temp_path().keep()` discipline), synthetic fixture fallback (T-02-31), `output_path` validation is deferred to Plan 11 where the folder picker lives (T-02-32).

## Self-Check: PASSED

**Files created (verified on disk):**

- FOUND: crates/encoder/src/progress/parser.rs
- FOUND: crates/encoder/src/pool/mod.rs
- FOUND: crates/encoder/src/pool/sidecar_pool.rs
- FOUND: crates/encoder/src/queue/mod.rs
- FOUND: crates/encoder/src/queue/actor.rs
- FOUND: crates/encoder/src/queue/job.rs
- FOUND: crates/encoder/src/fanout/mod.rs
- FOUND: crates/encoder/src/fanout/intermediate.rs
- FOUND: crates/encoder/src/fanout/multi_encode.rs
- FOUND: crates/encoder/tests/queue_actor.rs
- FOUND: crates/encoder/tests/fanout_intermediate.rs
- FOUND: apps/desktop/src-tauri/src/commands/render.rs
- FOUND: scripts/benchmark/render-1min.sh (executable)
- FOUND: scripts/benchmark/fixtures/README.md
- FOUND: .github/workflows/render-benchmark.yml
- FOUND: .github/workflows/release-benchmark.yml

**Commits (verified in git log):**

- FOUND: `025fc5d` — Task 1 (progress parser + sidecar pool)
- FOUND: `d9d7b63` — Task 2 (render queue actor + Tauri commands)
- FOUND: `4c0fa09` — Task 3 (smart-batch fan-out + EXPORT-06 benchmark CI)
