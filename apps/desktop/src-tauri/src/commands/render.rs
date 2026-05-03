// Render queue Tauri commands.
//
// The render queue actor (encoder::queue::actor::RenderQueueActor) lives
// in its own tokio task. These commands are thin pass-throughs:
//
//   - render_enqueue       — write a NewRenderJob into the project DB and
//                            poke the actor so it picks it up immediately.
//   - render_cancel        — send QueueMsg::Cancel to the actor.
//   - render_list_active   — read-through storage::render_job_repo::list_active.
//   - stream_render_progress — claim the single RenderProgress mpsc receiver
//                              and forward every snapshot to a per-call
//                              Channel<RenderProgressDto>.
//
// The underlying actor + executor are spawned by the host during `setup()`.
// Tests for the actor itself live in `crates/encoder/tests/queue_actor.rs`.

use std::path::PathBuf;
use std::sync::Arc;

use encoder::queue::actor::{QueueMsg, RenderQueueHandle};
use encoder::RenderProgress;
use serde::{Deserialize, Serialize};
use storage::repos::render_job_repo;
use storage::{Connection, NewRenderJob, RenderJob};
use tauri::ipc::Channel;
use tauri::State;
use tokio::sync::{mpsc, Mutex};
use uuid::Uuid;

use crate::error::AppError;
use crate::state::AppState;

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct NewRenderJobDto {
    pub story_id: String,
    pub preset_id: Option<String>,
    pub format: String,
    pub resolution: String,
    pub output_width: Option<u32>,
    pub output_height: Option<u32>,
    pub fps: u32,
    pub quality: String,
    pub encoder_options_json: Option<String>,
    pub priority: i32,
    pub batch_id: Option<String>,
}

impl From<NewRenderJobDto> for NewRenderJob {
    fn from(d: NewRenderJobDto) -> Self {
        NewRenderJob {
            story_id: d.story_id,
            preset_id: d.preset_id.and_then(|s| Uuid::parse_str(&s).ok()),
            format: d.format,
            resolution: d.resolution,
            output_width: d.output_width,
            output_height: d.output_height,
            fps: d.fps,
            quality: d.quality,
            encoder_options_json: d.encoder_options_json,
            priority: d.priority,
            output_path: None,
            batch_id: d.batch_id,
        }
    }
}

#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct RenderJobDto {
    pub id: String,
    pub story_id: String,
    pub preset_id: Option<String>,
    pub format: String,
    pub resolution: String,
    pub output_width: Option<u32>,
    pub output_height: Option<u32>,
    pub fps: u32,
    pub quality: String,
    pub encoder_options_json: Option<String>,
    pub status: String,
    pub progress_pct: f32,
    pub started_at: Option<i64>,
    pub completed_at: Option<i64>,
    pub error: Option<String>,
    pub priority: i32,
    pub output_path: Option<String>,
    pub batch_id: Option<String>,
    pub created_at: i64,
}

impl From<RenderJob> for RenderJobDto {
    fn from(j: RenderJob) -> Self {
        RenderJobDto {
            id: j.id.to_string(),
            story_id: j.story_id,
            preset_id: j.preset_id.map(|u| u.to_string()),
            format: j.format,
            resolution: j.resolution,
            output_width: j.output_width,
            output_height: j.output_height,
            fps: j.fps,
            quality: j.quality,
            encoder_options_json: j.encoder_options_json,
            status: j.status.as_str().to_string(),
            progress_pct: j.progress_pct,
            started_at: j.started_at,
            completed_at: j.completed_at,
            error: j.error,
            priority: j.priority,
            output_path: j.output_path.map(|p| p.display().to_string()),
            batch_id: j.batch_id,
            created_at: j.created_at,
        }
    }
}

#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct RenderProgressDto {
    pub job_id: String,
    pub pct: f32,
    pub frame: u64,
    pub fps: f32,
    pub speed: f32,
    pub eta_ms: u64,
}

impl From<RenderProgress> for RenderProgressDto {
    fn from(p: RenderProgress) -> Self {
        RenderProgressDto {
            job_id: p.job_id.to_string(),
            pct: p.pct,
            frame: p.frame,
            fps: p.fps,
            speed: p.speed,
            eta_ms: p.eta_ms,
        }
    }
}

// ---------------------------------------------------------------------------
// Host-state bundle
// ---------------------------------------------------------------------------

/// Bundle of handles the render commands need. Created by the host during
/// `setup()` once the project DB is known and parked inside `AppState`
/// via the actor registry / Tauri `manage` API.
#[derive(Clone)]
pub struct RenderQueueState {
    pub handle: RenderQueueHandle,
    pub db: Arc<Mutex<Connection>>,
    pub project_db_path: PathBuf,
    /// One-shot receiver for `stream_render_progress`. Parking it inside a
    /// `Mutex<Option<_>>` enforces single-subscriber semantics.
    pub progress_rx: Arc<Mutex<Option<mpsc::Receiver<RenderProgress>>>>,
}

impl std::fmt::Debug for RenderQueueState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RenderQueueState")
            .field("handle", &self.handle)
            .finish_non_exhaustive()
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
#[specta::specta]
#[tracing::instrument(level = "info", skip_all, fields(cmd = "render_enqueue"), err(Debug))]
pub async fn render_enqueue(
    state: State<'_, AppState>,
    job: NewRenderJobDto,
) -> Result<String, AppError> {
    let queue = state
        .render_queue()
        .ok_or_else(|| AppError::Internal("render queue not initialised".into()))?;
    let new = NewRenderJob::from(job);
    let id = {
        let conn = queue.db.lock().await;
        render_job_repo::enqueue(&conn, &new)?
    };
    // Best-effort nudge to the actor — not load-bearing (the periodic tick
    // also picks the job up).
    let _ = queue.handle.send(QueueMsg::Enqueue(id)).await;
    Ok(id.to_string())
}

#[tauri::command]
#[specta::specta]
#[tracing::instrument(level = "info", skip_all, fields(cmd = "render_cancel"), err(Debug))]
pub async fn render_cancel(state: State<'_, AppState>, job_id: String) -> Result<(), AppError> {
    let uuid =
        Uuid::parse_str(&job_id).map_err(|e| AppError::InvalidArgument(format!("job_id: {e}")))?;
    let queue = state
        .render_queue()
        .ok_or_else(|| AppError::Internal("render queue not initialised".into()))?;
    queue
        .handle
        .send(QueueMsg::Cancel(uuid))
        .await
        .map_err(|e| AppError::Encoder(e.to_string()))?;
    Ok(())
}

#[tauri::command]
#[specta::specta]
#[tracing::instrument(
    level = "info",
    skip_all,
    fields(cmd = "render_list_active"),
    err(Debug)
)]
pub async fn render_list_active(
    state: State<'_, AppState>,
    story_id: String,
) -> Result<Vec<RenderJobDto>, AppError> {
    let queue = state
        .render_queue()
        .ok_or_else(|| AppError::Internal("render queue not initialised".into()))?;
    let conn = queue.db.lock().await;
    let rows = render_job_repo::list_active(&conn, &story_id)?;
    Ok(rows.into_iter().map(Into::into).collect())
}

/// Streams `RenderProgress` snapshots to the renderer. Single-subscriber:
/// the receiver is consumed on first call; subsequent calls return
/// `AppError::Internal("already streaming")` until the receiver is
/// re-armed by the host.
#[tauri::command]
#[specta::specta]
#[tracing::instrument(
    level = "info",
    skip_all,
    fields(cmd = "stream_render_progress"),
    err(Debug)
)]
pub async fn stream_render_progress(
    state: State<'_, AppState>,
    channel: Channel<RenderProgressDto>,
) -> Result<(), AppError> {
    let queue = state
        .render_queue()
        .ok_or_else(|| AppError::Internal("render queue not initialised".into()))?;
    let mut guard = queue.progress_rx.lock().await;
    let mut rx = guard
        .take()
        .ok_or_else(|| AppError::Internal("render progress already streaming".into()))?;
    drop(guard);

    while let Some(p) = rx.recv().await {
        if channel.send(RenderProgressDto::from(p)).is_err() {
            let mut guard = queue.progress_rx.lock().await;
            *guard = Some(rx);
            return Ok(());
        }
    }
    Ok(())
}

/// Host-side helper: re-park a fresh receiver (used by integration tests /
/// when the host re-opens a project).
pub fn park_progress_receiver(state: &RenderQueueState, rx: mpsc::Receiver<RenderProgress>) {
    // This fn is sync — it just drops `rx` into the Mutex. We use
    // blocking_lock because it's called from setup(), not an async task.
    let mut guard = state.progress_rx.blocking_lock();
    *guard = Some(rx);
}

// Silence unused-import lint for PathBuf — kept for ergonomic future use.
#[allow(dead_code)]
fn _unused_pathbuf(_: PathBuf) {}
