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

use std::io::ErrorKind;
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

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type)]
pub struct TimingPointDto {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type)]
pub struct TimingBBoxDto {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TimingTargetDto {
    pub selector: Option<String>,
    pub bbox: Option<TimingBBoxDto>,
    pub match_kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RecordingStepTimingDto {
    pub ordinal: u32,
    pub step_id: Option<String>,
    pub scene_name: String,
    pub verb: String,
    pub start_ms: u64,
    pub end_ms: u64,
    pub duration_ms: u64,
    pub status: String,
    pub cursor: Option<TimingPointDto>,
    pub target: Option<TimingTargetDto>,
    pub confidence: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RecordingStepTimingSidecarDto {
    pub version: u32,
    pub recording_path: String,
    pub story_hash: String,
    pub timebase: String,
    pub status: String,
    pub steps: Vec<RecordingStepTimingDto>,
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
    let bytes = match std::fs::read(&sidecar) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(AppError::from(e)),
    };
    let dto: CrateTrajectoryDto = serde_json::from_slice(&bytes)
        .map_err(|e| AppError::InvalidArgument(format!("trajectory sidecar parse: {e}")))?;
    Ok(Some(dto.into()))
}

/// Load `<recording>.steps.json`, the recording-relative timing sidecar
/// emitted by `launch_automation` for Record & Polish runs.
/// Returns `Ok(None)` for older recordings or manual recording sessions.
#[tauri::command]
#[specta::specta]
#[tracing::instrument(
    level = "info",
    skip_all,
    fields(cmd = "get_recording_step_timing"),
    err(Debug)
)]
pub fn get_recording_step_timing(
    args: GetRecordingTrajectoryArgs,
) -> Result<Option<RecordingStepTimingSidecarDto>, AppError> {
    let recording_path = PathBuf::from(&args.recording_path);
    let sidecar = recording_path.with_extension("steps.json");
    let bytes = match std::fs::read(&sidecar) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(AppError::from(e)),
    };
    let dto: RecordingStepTimingSidecarDto = serde_json::from_slice(&bytes)
        .map_err(|e| AppError::InvalidArgument(format!("step timing sidecar parse: {e}")))?;
    Ok(Some(dto))
}
