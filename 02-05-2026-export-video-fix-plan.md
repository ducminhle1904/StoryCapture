# Export Video Fix Plan

Date: 02-05-2026
Repository: `/Users/locvotuan/git/StoryCapture`

## Goal

Make post-recording video export actually produce files in the user-selected
output folder after the user finishes recording and submits an export from
post-production.

## Problem Summary

The export flow accepted the user's output folder and queued render jobs, but no
video appeared in the selected destination. Investigation showed the production
render queue was still wired to `NoopJobExecutor`, which only marked jobs as
completed with a synthetic path and never invoked FFmpeg.

## Root Cause

1. `open_project` installed the render queue with `NoopJobExecutor`.
2. Export jobs did not persist the concrete output path at enqueue time.
3. The queue could mark a job completed without proving that the expected file
   exists on disk.
4. `render_intermediate` spawned FFmpeg but did not wait for completion, which
   was unsafe for real export execution.

## Implementation Plan

### 1. Persist the Real Output Path

Files:
- `crates/storage/src/models/render_job.rs`
- `crates/storage/src/repos/render_job_repo.rs`
- `apps/desktop/src-tauri/src/commands/render.rs`
- `crates/encoder/src/export/orchestrator.rs`

Steps:
1. Add `output_path: Option<PathBuf>` to `NewRenderJob`.
2. Update `render_job_repo::enqueue` to insert `output_path`.
3. Keep ad-hoc `render_enqueue` jobs compatible by passing `output_path: None`.
4. In export orchestration, pass each `OutputSpec.output_path` into the queued
   job.

Verify:
- Render job rows include the intended file path before the actor runs.
- Existing queue tests still pass.

### 2. Add a Real FFmpeg-Backed Queue Executor

File:
- `crates/encoder/src/queue/fanout_executor.rs`

Steps:
1. Create `FanoutJobExecutor`.
2. Read the graph snapshot from `.export-graph-<batch_id>.json`.
3. Resolve graph source video and audio inputs into FFmpeg `-i` arguments.
4. Render one FFV1 intermediate from the effects graph.
5. Fan out the intermediate into the requested output format.
6. Remove the temporary intermediate file after encode.
7. Check `metadata(output_path)` before returning `JobOutcome::Completed`.

Verify:
- A unit test proves the executor writes the declared output path.
- A missing output file causes failure instead of false completion.

### 3. Make Intermediate Rendering Wait for FFmpeg

Files:
- `crates/encoder/src/fanout/intermediate.rs`
- `crates/encoder/src/sidecar.rs`

Steps:
1. Change `render_intermediate` to call `SidecarCommand::run`.
2. Update default `SidecarCommand::run` to drain stdout/stderr while waiting.
3. Keep tests compatible through scripted sidecar implementations.

Verify:
- Intermediate/fanout tests pass.
- No deadlock risk from undrained FFmpeg stderr.

### 4. Wire Production Queue to the Real Executor

File:
- `apps/desktop/src-tauri/src/commands/projects.rs`

Steps:
1. Replace `NoopJobExecutor` in `install_project_render_queue`.
2. Instantiate `TauriSidecar` from the active `AppHandle`.
3. Wrap it in `FanoutJobExecutor`.
4. Keep the existing test path injectable with `NoopJobExecutor`.

Verify:
- `cargo check -p storycapture --lib` passes.
- Existing project queue installation test still passes.

### 5. Regression Test Coverage

Commands:

```bash
cargo test -p storage render_job_repo --lib
cargo test -p encoder fanout_executor_writes_declared_output_path --lib
cargo test -p encoder export_run --lib
cargo test -p encoder --test queue_actor
cargo test -p encoder --test fanout_intermediate
cargo test -p storycapture install_queue_opens_project_db --lib
cargo check -p storycapture --lib
```

Expected result:
- All listed checks pass.
- No export job can report completed without a real output file.

## Manual UAT Plan

Run this after starting the desktop app on a host with the required recording
permissions.

1. Open an existing project or create a new project.
2. Record a short script that produces a valid recording in the project exports
   folder.
3. Open post-production from `Record & Polish` or the post-production route.
4. Choose a known writable output folder outside protected system paths.
5. Export MP4 at 720p or 1080p.
6. Wait for the render queue to finish.
7. Confirm the selected folder contains the expected file name:
   `<base-name>.<resolution>.<fps>.mp4`.
8. Open the exported video and verify it plays.
9. Repeat with WebM if FFmpeg has VP9/Opus support in the bundled build.
10. Check the app log if any job fails; the job should fail visibly instead of
    silently completing without a file.

## Done Criteria

- Export queue uses the real FFmpeg-backed executor in production.
- Export jobs carry the intended destination path.
- Jobs only complete after the destination file exists.
- Automated checks pass.
- Manual UAT confirms a real export appears in the selected folder.

