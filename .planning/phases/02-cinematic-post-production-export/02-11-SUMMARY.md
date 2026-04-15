---
phase: 02-cinematic-post-production-export
plan: "11"
subsystem: encoder
tags: [export, mp4, webm, gif, resolution-presets, quality, batch, psnr, POST-08, EXPORT-01, EXPORT-02, EXPORT-03, EXPORT-04]
requirements:
  - EXPORT-01
  - EXPORT-02
  - EXPORT-03
  - EXPORT-04
  - POST-08
dependency-graph:
  requires:
    - Plan 02-01 (effects::Graph AST + FfmpegEmit)
    - Plan 02-10 (fanout + render queue + render_jobs repo)
    - Plan 01-08 (FFmpeg sidecar contract, ffmpeg path resolution pattern)
  provides:
    - "encoder::export::format — OutputFormat {Mp4, WebM, Gif} + codec_for + container/extension"
    - "encoder::export::resolution — Resolution {R720p, R1080p, R4k} + dimensions_for + res_label + VALID_FPS=[24,30,60]"
    - "encoder::export::quality — Quality {Low, Med, High} + bitrate_for + crf_for"
    - "encoder::export::batch — BatchExportRequest + OutputSpec + build_batch (single batch_id) + validate"
    - "encoder::export::orchestrator — ExportRequest + ExportResult + export_run + validate_folder (T-02-33)"
    - "encoder::export::psnr — compute_psnr + parse_psnr_stats + PsnrResult"
    - "encoder::export::reference_graph — build_reference_graph + BenchmarkFixture"
    - "encoder::export::error::ExportError"
    - "crates/encoder/src/bin/benchmark-render.rs — EXPORT-06 runner (--dry-run)"
    - "crates/encoder/src/bin/generate-psnr-reference.rs — POST-08 Phase A seeder"
    - "apps/desktop/src-tauri/src/commands/export — export_run + export_get_presets + export_validate_config"
    - "scripts/benchmark/fixtures/1min-reference.json + 1min-capture.mp4.placeholder"
    - "crates/encoder/tests/psnr_regression.rs + crates/encoder/tests/fixtures/psnr_reference_frames/README.md"
  affects:
    - Plan 12 (editor render picker UI) — consumes ExportPresetsCatalogue + export_run + build_batch
    - Plan 02-CONTEXT D-29 — PSNR reference harness now live (Phase B CI gate)
tech-stack:
  added:
    - "effects crate as dep of apps/desktop/src-tauri (needed for ExportRequest.graph parsing)"
  patterns:
    - "Export catalogue enums live in encoder::export::* and are distinct from encoder::fanout::* (Plan 10 internal). Orchestrator is the bridge."
    - "batch_id: single Uuid::now_v7 stamped onto every OutputSpec in a batch; render_jobs.batch_id is a TEXT column (hex-hyphenated Uuid)"
    - "validate_folder rejects `/System`, `/usr/`, `/etc/`, `/var/log/`, `/var/db/`, `/var/root/`, `/bin/`, `/sbin/`, `C:\\\\Windows\\\\`, `C:\\\\Program Files\\\\`, `C:\\\\ProgramData\\\\` — but allows `/var/folders` (macOS per-user temp root)"
    - "Reference-graph builder is shared between the benchmark bin, generator bin, and psnr_regression test — prevents graph drift"
    - "PSNR test + meta-test skip gracefully (same pattern as Plan 01-08 probe.rs) when fixture/ffmpeg absent; commit-prefix meta-test enforces [fixture] audit trail T-02-35"
key-files:
  created:
    - crates/encoder/src/export/mod.rs
    - crates/encoder/src/export/format.rs
    - crates/encoder/src/export/resolution.rs
    - crates/encoder/src/export/quality.rs
    - crates/encoder/src/export/batch.rs
    - crates/encoder/src/export/orchestrator.rs
    - crates/encoder/src/export/psnr.rs
    - crates/encoder/src/export/error.rs
    - crates/encoder/src/export/reference_graph.rs
    - crates/encoder/src/bin/benchmark-render.rs
    - crates/encoder/src/bin/generate-psnr-reference.rs
    - crates/encoder/tests/export_integration.rs
    - crates/encoder/tests/psnr_regression.rs
    - crates/encoder/tests/fixtures/psnr_reference_frames/README.md
    - scripts/benchmark/fixtures/1min-reference.json
    - scripts/benchmark/fixtures/1min-capture.mp4.placeholder
    - apps/desktop/src-tauri/src/commands/export.rs
  modified:
    - crates/encoder/src/lib.rs (+ pub mod export;)
    - apps/desktop/src-tauri/src/commands/mod.rs (+ pub mod export;)
    - apps/desktop/src-tauri/src/ipc_spec.rs (+ 3 commands, 4 DTOs)
    - apps/desktop/src-tauri/Cargo.toml (+ effects dep)
    - Cargo.lock
decisions:
  - "Export catalogue enums (OutputFormat/Resolution/Quality) introduced at encoder::export::* level; NOT shared with encoder::fanout::* which keeps its own identically-named enums as the low-level encoder-argv contract. Orchestrator bridges via extension/label strings to avoid exporting fanout's internal API surface to the Tauri boundary."
  - "export_run accepts queue handle as Option<&RenderQueueHandle> so orchestrator is unit-testable without a spawned actor. None path writes DB rows; production path with Some(..) additionally nudges the actor via QueueMsg::Enqueue."
  - "Graph snapshot written once per batch (one .export-graph-<batch_id>.json file); all N jobs in the batch share it. Plan 11's FanoutJobExecutor will load the snapshot per-job when the queue pops."
  - "PSNR reference fixture NOT committed in this plan — the Phase A seeding procedure requires a real FFmpeg binary, which is absent on the executor host (same host-environment limitation as Plan 01-08's ffmpeg-build artifact). The generator binary + documented workflow are committed; first contributor with ffmpeg available runs Phase A and commits the MP4 with [fixture] prefix."
  - "validate_folder uses trailing-slash prefix matching plus an exact-match list for protected roots. /var/folders (macOS tempdir) is explicitly allowed; the test-suite's tempfile::tempdir() lands there."
metrics:
  duration: ~35 minutes
  completed_date: 2026-04-15
  task_count: 3
  test_count: 23 new (18 lib + 6 integration - 1 fixture roundtrip already in lib) + 2 psnr + 3 tauri = 28 new
  total_tests: 68 encoder tests passing (50 lib + 6 export-integ + 7 queue + 5 fanout + 2 psnr-regression; 0 fail)
  file_count: 17 created, 5 modified
---

# Phase 2 Plan 11: Export orchestrator + PSNR regression summary

**One-liner:** EXPORT-01..04 delivered via a typed `encoder::export` module
(format/resolution/quality catalogues + batch builder + orchestrator that
composes Plan 01's Graph with Plan 10's render queue into atomic `render_jobs`
rows sharing one `batch_id`), plus POST-08 PSNR regression harness (FFmpeg
`psnr` filter with ≥38 dB gate + shared reference-graph builder + two-phase
seeding procedure enforced by a `[fixture]` commit-prefix meta-test).

## Outcome

**EXPORT-01** — `export_run(req, queue, db)` takes an `effects::Graph`,
validates the output folder against system-protected prefixes (T-02-33
mitigation), persists the graph snapshot as a sibling JSON, enqueues one
`render_jobs` row per requested output (shared `batch_id`), and nudges the
queue actor via `QueueMsg::Enqueue`. Integration test confirms 3-output batch
lands 3 rows in storage with identical `batch_id` + identical `priority`.

**EXPORT-02** — `OutputFormat::{Mp4, WebM, Gif}` with stable extension /
container / codec mappings (h264+aac / vp9+opus / gif-no-audio).

**EXPORT-03** — `Resolution::{R720p, R1080p, R4k}` + `VALID_FPS = &[24, 30, 60]`
+ `Quality::{Low, Med, High}` with codec-aware `bitrate_for` (H.264 ranges
3M..50M across the 9-cell matrix) and `crf_for` (18/23/28 H.264, 28/32/36
VP9). Research §12 ranges validated by `bitrate_for_h264_in_research_range`
test.

**EXPORT-04** — `build_batch` stamps one `Uuid::now_v7` batch_id across every
`OutputSpec` in the request; `build_batch_assigns_single_batch_id` test proves
all 3 output specs in a multi-format batch share one id while each has a
distinct output `id`. Validation rejects `InvalidFps(15)`, `UnsupportedCombination`
for 4K GIF and GIF>30fps, and `EmptyBatch` for zero outputs.

**POST-08** — Two-phase procedure:

- **Phase A (one-time)**: `generate-psnr-reference` binary + documented
  workflow commit the ~5-10 MB reference MP4 with `[fixture]` prefix.
- **Phase B (every CI run)**: `psnr_regression.rs` re-renders the shared
  reference graph at 1080p30, runs `compute_psnr` (FFmpeg `psnr` filter),
  and asserts `average >= 38.0 dB`. A meta-test enforces the `[fixture]`
  commit-subject prefix via `git log -1 --format=%s -- <fixture>` (T-02-35).
  Both tests skip gracefully when the fixture or FFmpeg are absent, same
  pattern as Plan 01-08 integration tests.

## What landed

### Task 1 — Format / Resolution / Quality catalogues (commit `7b966d3`)

Eight files under `crates/encoder/src/export/`: `mod.rs`, `format.rs`,
`resolution.rs`, `quality.rs`, `batch.rs`, `error.rs`, `orchestrator.rs`
(stub), `psnr.rs`. 18 lib tests pass covering extension mappings,
dimension tables, VALID_FPS, bitrate ranges, CRF monotonicity, batch_id
stamping, FPS validation, 4K-GIF rejection, empty-batch rejection, JSON
roundtrip, and PSNR parser happy/inf/missing-line cases.

### Task 2 — Orchestrator + Tauri commands + benchmark bin (commit `c363d62`)

- `export::orchestrator::export_run` with unit-testable `queue: Option<&...>` parameter.
- `export::orchestrator::validate_folder` — T-02-33 mitigation (protected
  path-prefix matcher). `/var/folders` (macOS tempdir) explicitly allowed.
- `export::reference_graph` — shared builder for benchmark + regression test.
- `src/bin/benchmark-render.rs` — manual arg parsing (no clap dep needed),
  `--dry-run` mode validated by integration test.
- `src/bin/generate-psnr-reference.rs` — Phase A seeder. Synthesises a
  `testsrc2+sine` source MP4 when absent; emits the reference via
  `libx264 -crf 18 -pix_fmt yuv420p` at 1080p30.
- `scripts/benchmark/fixtures/1min-reference.json` + `1min-capture.mp4.placeholder`.
- `apps/desktop/src-tauri/src/commands/export.rs` — 3 Tauri commands
  (`export_run` / `export_get_presets` / `export_validate_config`) +
  4 specta-bound DTOs, + `ExportError → AppError` conversion. `effects`
  added as a dep of `apps/desktop/src-tauri` so the host can parse
  `args.graph_json` into `effects::Graph` before handing off.
- Integration tests (`tests/export_integration.rs`): 3-output batch
  integration, mismatched-batch-id rejection, benchmark fixture JSON
  roundtrip, PSNR parse stub, missing-ffmpeg error path, benchmark-render
  dry-run smoke. 6 pass.
- 3 tauri-side unit tests: preset catalogue shape, validate_config happy
  path, validate_config rejects 4K GIF.

### Task 3 — POST-08 PSNR regression harness (commit `6da8376`)

- `tests/psnr_regression.rs` with `post_08_psnr_regression` (asserts
  `r.average >= 38.0`) and `reference_fixture_committed_with_prefix`
  (enforces `[fixture]` commit-subject prefix via `git log`).
- `tests/fixtures/psnr_reference_frames/README.md` — the full two-phase
  procedure, regeneration commands, and skip semantics.
- Both tests pass in skip mode on the current host (no ffmpeg); will
  become load-bearing once the first contributor with ffmpeg runs
  Phase A and commits the fixture.

## Interfaces emitted (for downstream plans)

```rust
// encoder::export::{format,resolution,quality,batch,orchestrator,psnr}
pub enum OutputFormat { Mp4, WebM, Gif }
pub fn dimensions_for(r: Resolution) -> (u32, u32);
pub const VALID_FPS: &[u32] = &[24, 30, 60];
pub fn bitrate_for(r: Resolution, q: Quality, codec: &str) -> String;
pub fn crf_for(r: Resolution, q: Quality, codec: &str) -> u8;

pub struct BatchExportRequest { outputs: Vec<(OutputFormat, Resolution, u32, Quality)>, out_folder: PathBuf, base_name: String }
pub fn build_batch(req: &BatchExportRequest) -> Result<Vec<OutputSpec>, ExportError>;
pub fn validate(fmt: OutputFormat, res: Resolution, fps: u32) -> Result<(), ExportError>;

pub struct ExportRequest { story_id, graph, outputs, priority, output_folder, preset_id }
pub struct ExportResult  { batch_id: Uuid, job_ids: Vec<Uuid>, graph_snapshot_path: PathBuf }
pub async fn export_run(req: ExportRequest, queue: Option<&RenderQueueHandle>, db: &Arc<Mutex<Connection>>) -> Result<ExportResult, ExportError>;
pub fn validate_folder(folder: &Path) -> Result<(), ExportError>;

pub async fn compute_psnr(ffmpeg_path: &Path, reference: &Path, candidate: &Path) -> Result<PsnrResult, ExportError>;
pub fn parse_psnr_stats(stderr: &str) -> Result<PsnrResult, ExportError>;
```

Tauri surface (specta-bound):

```ts
// packages/shared-types/src/ipc.ts (regenerated by pnpm tauri dev)
exportRun(args: ExportRunArgs): Promise<ExportResultDto>;
exportGetPresets(): Promise<ExportPresetsCatalogue>;
exportValidateConfig(cfg: ExportOutputDto): Promise<void>;
```

## Deviations from Plan

### Auto-fixed issues

**1. [Rule 1 — Bug] `/var/folders` false-positive in `validate_folder`**

- **Found during:** Task 2 first test run — `export_run_enqueues_n_jobs_with_shared_batch_id` failed because macOS's `tempfile::tempdir()` resolves to `/var/folders/...`, which my initial forbidden-prefix list rejected under `/var/`.
- **Fix:** Narrowed the forbidden `/var/` prefix to specific system-state subtrees (`/var/log/`, `/var/db/`, `/var/root/`) so `/var/folders` and `/var/tmp` remain writable. Added a separate `FORBIDDEN_EXACT` list to catch the case where `s == "/etc"` (no trailing slash).
- **Files modified:** `crates/encoder/src/export/orchestrator.rs` (commit `c363d62`).

**2. [Rule 3 — Blocking] `effects` dep missing from `apps/desktop/src-tauri/Cargo.toml`**

- **Found during:** `cargo check -p storycapture --lib` after wiring `commands::export`.
- **Issue:** `export.rs` parses `args.graph_json` into `effects::Graph`, but the Tauri host crate didn't list `effects` as a dep.
- **Fix:** Added `effects = { path = "../../../crates/effects" }` to `apps/desktop/src-tauri/Cargo.toml`. `cargo check -p storycapture` now green (1 pre-existing `tauri-plugin-shell::Shell::open` deprecation warning unchanged).

**3. [Rule 2 — Missing critical functionality] `NodeId` not in `effects` crate root**

- **Found during:** First `cargo build -p encoder --bins` after creating `reference_graph.rs`.
- **Issue:** `use effects::{Graph, NodeId, VideoNode}` — `NodeId` is `effects::ast::NodeId`, not re-exported at the crate root.
- **Fix:** `use effects::ast::NodeId; use effects::{Graph, VideoNode};` — explicit submodule path. Kept consistent with existing Plan 01 test patterns.

**4. [Rule 4 — Architectural decision NOT taken — documented instead]** PSNR reference fixture was NOT generated in this plan.

- **Reason:** The executor host (macOS arm64) does not have FFmpeg available (same limitation documented in Plan 01-08 Summary). Generating the ~5-10 MB reference MP4 locally is impossible without the real sidecar binary.
- **Mitigation:** The `generate-psnr-reference` bin is ready, the shared reference-graph builder is wired, the regression test is in place and skips gracefully with a clear regeneration command. The first contributor with a working FFmpeg install runs Phase A and commits the fixture with `[fixture]` prefix. This matches the Plan 01-08 pattern where `ffmpeg-build.yml` artifact produces the real FFmpeg binary and tests become load-bearing on downstream CI runs.
- **Traceability:** T-02-35 (PSNR integrity) mitigation is the `[fixture]` commit-subject prefix meta-test, which will fail loudly if someone commits a replacement fixture without the prefix.

### Scope-internal choices

- **Manual argv parsing in the two bins** (no `clap` dep). Kept dep footprint unchanged; neither bin has a complex surface.
- **Benchmark-render non-dry-run mode returns "pending FanoutJobExecutor wiring"**. The full spawn path needs the Plan 11 `FanoutJobExecutor` that threads `render_intermediate + fanout_encode` through a real sidecar. Current test surface exercises the dry-run path which is what CI benchmark scripts need.
- **Reference graph is Source-only** in Task 2/3. This is intentional: downstream Plans 02-05/08/09 define richer AST nodes but those depend on recording trajectory data we can't fabricate hermetically. The PSNR reference is about pipeline drift, not coverage — adding more nodes makes sense once Plan 11 wires the real fanout executor.

### Authentication gates

None hit.

## Verification

| Question | Status |
|---|---|
| `cargo check -p encoder` | green (zero warnings on encoder itself) |
| `cargo check -p storycapture --lib` | green (1 pre-existing deprecation warning in capture.rs) |
| `cargo test -p encoder --lib export::` | 23 pass |
| `cargo test -p encoder --test export_integration` | 6 pass |
| `cargo test -p encoder --test psnr_regression` | 2 pass (skip mode — fixture absent) |
| `cargo test -p encoder` (all) | 68 pass / 0 fail |
| `cargo test -p storycapture --lib commands::export` | 3 pass |
| `grep -q "enum OutputFormat" crates/encoder/src/export/format.rs` | green |
| `grep -q "R720p => (1280, 720)" crates/encoder/src/export/resolution.rs` | green |
| `grep -q "R1080p => (1920, 1080)" crates/encoder/src/export/resolution.rs` | green |
| `grep -q "R4k => (3840, 2160)" crates/encoder/src/export/resolution.rs` | green |
| `grep -q "VALID_FPS: &\[u32\] = &\[24, 30, 60\]" crates/encoder/src/export/resolution.rs` | green |
| `grep -q "pub fn build_batch" crates/encoder/src/export/batch.rs` | green |
| `grep -q "pub async fn export_run" crates/encoder/src/export/orchestrator.rs` | green |
| `grep -q "batch_id: Some(batch_id.to_string())" crates/encoder/src/export/orchestrator.rs` | green |
| `grep -q "#\[tauri::command\]" apps/desktop/src-tauri/src/commands/export.rs` | green |
| `grep -q "pub fn export_get_presets" apps/desktop/src-tauri/src/commands/export.rs` | green |
| `test -f scripts/benchmark/fixtures/1min-reference.json` | green |
| `test -f crates/encoder/src/bin/benchmark-render.rs` | green |
| `test -f crates/encoder/src/bin/generate-psnr-reference.rs` | green |
| `grep -q "pub async fn compute_psnr" crates/encoder/src/export/psnr.rs` | green |
| `grep -q "lavfi" crates/encoder/src/export/psnr.rs` | green |
| `grep -q "post_08_psnr_regression" crates/encoder/tests/psnr_regression.rs` | green |
| `grep -q "r.average >= 38.0" crates/encoder/tests/psnr_regression.rs` | green |
| `! grep -q "RUN_PSNR" crates/encoder/tests/psnr_regression.rs` | green (gate removed) |

## Known Stubs

- **PSNR reference fixture `crates/encoder/tests/fixtures/1min_reference_1080p30.mp4` is not committed** — Phase A seeding is required on a host with FFmpeg. See `crates/encoder/tests/fixtures/psnr_reference_frames/README.md`. Until then, `post_08_psnr_regression` skips cleanly with the regeneration command in its output. This is the same pattern Plan 01-08 uses for its `real-ffmpeg`-feature-gated integration tests.
- **`benchmark-render` non-dry-run mode returns a pending-error.** The full `render_intermediate + fanout_encode` spawn path depends on Plan 11's `FanoutJobExecutor`; today's `scripts/benchmark/render-1min.sh` drives FFmpeg directly and passes. The `--dry-run` path exercised by the integration test is sufficient for the current EXPORT-06 gate.
- **Reference graph is Source-only.** Downstream plans (02-05 zoom / 02-08 cursor / 02-09 text) add richer nodes; extending `build_reference_graph` once Plan 11 wires real capture trajectories will tighten the PSNR gate's coverage. Documented in `export/reference_graph.rs` module header.
- **`benchmark-render` and `generate-psnr-reference` use manual argv parsing** rather than `clap`. Simpler surface + no new dep. If the args grow past ~6 flags we can migrate.

## Threat Flags

No new trust boundaries beyond those enumerated in the plan's `<threat_model>`:

- **T-02-33 (output_folder = /System)**: mitigated by `validate_folder` + two tests covering `/System`, `/usr`, `/etc/foo` cases.
- **T-02-34 (graph JSON leaks in export folder)**: the snapshot lives at `.export-graph-<batch_id>.json` per batch; Plan 11 post-job cleanup deletes these once all jobs in a batch terminate. Partial mitigation today (file is written with a leading `.` so it's hidden on macOS Finder by default).
- **T-02-35 (PSNR reference integrity)**: mitigated by the `reference_fixture_committed_with_prefix` meta-test asserting `[fixture]` commit-subject prefix. Fails loudly if someone replaces the fixture under a different commit prefix.

## Next-plan readiness

- **Plan 02-12 (editor render picker UI)** consumes `exportGetPresets()` for the format/resolution/fps/quality picker, `exportValidateConfig(cfg)` for real-time form validation, and `exportRun(args)` for enqueue-and-watch. The `RenderProgressDto` stream (already shipped in Plan 02-10) gives live progress.
- **Plan 11 (host wiring)** installs a `FanoutJobExecutor` that, on each `render_jobs` pop, reads `.export-graph-<batch_id>.json`, calls `FfmpegEmit::emit + collect_extra_inputs`, then `render_intermediate + fanout_encode`. The orchestrator's graph-snapshot sidecar was designed for exactly this lookup.
- **Plan 13 (release/CI)** can wire `scripts/benchmark/render-1min.sh` to invoke `benchmark-render --dry-run` as a smoke test before the real benchmark runs (catches graph loading regressions cheaply).

## Self-Check: PASSED

Files created (verified on disk):

- FOUND: crates/encoder/src/export/mod.rs
- FOUND: crates/encoder/src/export/format.rs
- FOUND: crates/encoder/src/export/resolution.rs
- FOUND: crates/encoder/src/export/quality.rs
- FOUND: crates/encoder/src/export/batch.rs
- FOUND: crates/encoder/src/export/orchestrator.rs
- FOUND: crates/encoder/src/export/psnr.rs
- FOUND: crates/encoder/src/export/error.rs
- FOUND: crates/encoder/src/export/reference_graph.rs
- FOUND: crates/encoder/src/bin/benchmark-render.rs
- FOUND: crates/encoder/src/bin/generate-psnr-reference.rs
- FOUND: crates/encoder/tests/export_integration.rs
- FOUND: crates/encoder/tests/psnr_regression.rs
- FOUND: crates/encoder/tests/fixtures/psnr_reference_frames/README.md
- FOUND: scripts/benchmark/fixtures/1min-reference.json
- FOUND: scripts/benchmark/fixtures/1min-capture.mp4.placeholder
- FOUND: apps/desktop/src-tauri/src/commands/export.rs

Commits (verified in git log):

- FOUND: `7b966d3` — Task 1 (catalogues + batch builder)
- FOUND: `c363d62` — Task 2 (orchestrator + Tauri commands + benchmark bin)
- FOUND: `6da8376` — Task 3 (POST-08 PSNR regression harness)

---
*Phase: 02-cinematic-post-production-export*
*Completed: 2026-04-15*
