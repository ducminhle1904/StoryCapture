//! Cursor-trajectory IPC (Phase 19-02).
//!
//! Reads the `<recording>.trajectory.json` sidecar that
//! `commands::encode::start_recording` emits when a capture is stopped,
//! and returns it to the renderer for the cursor-track autopopulate
//! flow.
//!
//! Reading the sidecar never touches the MP4. If the sidecar is
//! missing (older recording, trajectory recorder disabled at the time,
//! or the sample loop never wrote out) we return `Ok(None)`.

use std::path::PathBuf;

use capture::trajectory::{
    sidecar_path_for, CaptureRect as TrajectoryCaptureRect, TrajectoryDto as CrateTrajectoryDto,
    TrajectoryFrame as CrateTrajectoryFrame,
};
use serde::{Deserialize, Serialize};
use specta::Type;

use crate::error::AppError;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type)]
pub struct CaptureRectDto {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

impl From<TrajectoryCaptureRect> for CaptureRectDto {
    fn from(r: TrajectoryCaptureRect) -> Self {
        Self {
            x: r.x,
            y: r.y,
            width: r.width,
            height: r.height,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type)]
pub struct TrajectoryFrameDto {
    pub t_ms: u32,
    pub x: f32,
    pub y: f32,
    pub click: bool,
}

impl From<CrateTrajectoryFrame> for TrajectoryFrameDto {
    fn from(f: CrateTrajectoryFrame) -> Self {
        Self {
            t_ms: f.t_ms,
            x: f.x,
            y: f.y,
            click: f.click,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct TrajectoryDto {
    pub recording_path: String,
    pub capture_rect: CaptureRectDto,
    pub fps: u32,
    pub frame_count: u32,
    pub frames: Vec<TrajectoryFrameDto>,
}

impl From<CrateTrajectoryDto> for TrajectoryDto {
    fn from(d: CrateTrajectoryDto) -> Self {
        Self {
            recording_path: d.recording_path,
            capture_rect: d.capture_rect.into(),
            fps: d.fps,
            frame_count: d.frame_count,
            frames: d.frames.into_iter().map(Into::into).collect(),
        }
    }
}

#[derive(Debug, Clone, Deserialize, Type)]
pub struct GetRecordingTrajectoryArgs {
    pub recording_path: String,
}

/// Load the trajectory sidecar that lives alongside an MP4.
///
/// Returns `Ok(None)` when the sidecar does not exist (older
/// recording or trajectory recorder skipped this session).
#[tauri::command]
#[specta::specta]
#[tracing::instrument(
    level = "info",
    skip_all,
    fields(cmd = "get_recording_trajectory"),
    err(Debug)
)]
pub fn get_recording_trajectory(
    args: GetRecordingTrajectoryArgs,
) -> Result<Option<TrajectoryDto>, AppError> {
    let recording_path = PathBuf::from(&args.recording_path);
    let sidecar = sidecar_path_for(&recording_path);
    if !sidecar.exists() {
        return Ok(None);
    }
    let bytes = std::fs::read(&sidecar).map_err(AppError::from)?;
    let dto: CrateTrajectoryDto = serde_json::from_slice(&bytes)
        .map_err(|e| AppError::InvalidArgument(format!("trajectory sidecar parse: {e}")))?;
    Ok(Some(dto.into()))
}
