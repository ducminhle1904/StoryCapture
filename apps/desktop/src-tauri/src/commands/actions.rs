//! Semantic action-timeline IPC.
//!
//! Reads the `<recording>.actions.json` sidecar emitted by recording-time
//! automation. Missing sidecars return `Ok(None)` so older recordings keep
//! loading through the legacy cursor trajectory path.

use std::path::PathBuf;

use automation::{
    action_timeline_sidecar_path_for, ActionCaptureRect as CrateActionCaptureRect,
    ActionPoint as CrateActionPoint, ActionTarget as CrateActionTarget,
    ActionTimelineDto as CrateActionTimelineDto, ActionTimelineEvent as CrateActionTimelineEvent,
};
use serde::{Deserialize, Serialize};
use specta::Type;

use crate::error::AppError;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type)]
pub struct ActionPointDto {
    pub x: f64,
    pub y: f64,
}

impl From<CrateActionPoint> for ActionPointDto {
    fn from(point: CrateActionPoint) -> Self {
        Self {
            x: point.x,
            y: point.y,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type)]
pub struct ActionBoundsDto {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl From<automation::BoundingBox> for ActionBoundsDto {
    fn from(bounds: automation::BoundingBox) -> Self {
        Self {
            x: bounds.x,
            y: bounds.y,
            w: bounds.w,
            h: bounds.h,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct ActionTargetDto {
    pub kind: String,
    pub label: Option<String>,
    pub center: ActionPointDto,
    pub bounds: ActionBoundsDto,
}

impl From<CrateActionTarget> for ActionTargetDto {
    fn from(target: CrateActionTarget) -> Self {
        Self {
            kind: target.kind,
            label: target.label,
            center: target.center.into(),
            bounds: target.bounds.into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct ActionPointerDto {
    pub button: String,
    pub effect: String,
}

impl From<automation::ActionPointer> for ActionPointerDto {
    fn from(pointer: automation::ActionPointer) -> Self {
        let button = match pointer.button {
            automation::PointerButton::Left => "left",
        };
        Self {
            button: button.into(),
            effect: pointer.effect,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct ActionTimelineEventDto {
    pub step_id: Option<String>,
    pub ordinal: u32,
    pub verb: String,
    pub t_start_ms: u64,
    pub t_action_ms: u64,
    pub t_end_ms: u64,
    pub target: Option<ActionTargetDto>,
    pub secondary_target: Option<ActionTargetDto>,
    pub pointer: Option<ActionPointerDto>,
}

impl From<CrateActionTimelineEvent> for ActionTimelineEventDto {
    fn from(event: CrateActionTimelineEvent) -> Self {
        Self {
            step_id: event.step_id,
            ordinal: event.ordinal,
            verb: event.verb,
            t_start_ms: event.t_start_ms,
            t_action_ms: event.t_action_ms,
            t_end_ms: event.t_end_ms,
            target: event.target.map(Into::into),
            secondary_target: event.secondary_target.map(Into::into),
            pointer: event.pointer.map(Into::into),
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type)]
pub struct ActionCaptureRectDto {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

impl From<CrateActionCaptureRect> for ActionCaptureRectDto {
    fn from(rect: CrateActionCaptureRect) -> Self {
        Self {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type)]
pub struct ActionViewportDto {
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct ActionTimelineDto {
    pub version: u32,
    pub recording_path: String,
    pub viewport: ActionViewportDto,
    pub capture_rect: ActionCaptureRectDto,
    pub fps: u32,
    pub frame_count: u32,
    pub events: Vec<ActionTimelineEventDto>,
}

impl From<CrateActionTimelineDto> for ActionTimelineDto {
    fn from(dto: CrateActionTimelineDto) -> Self {
        Self {
            version: dto.version,
            recording_path: dto.recording_path,
            viewport: ActionViewportDto {
                width: dto.viewport.width,
                height: dto.viewport.height,
            },
            capture_rect: dto.capture_rect.into(),
            fps: dto.fps,
            frame_count: dto.frame_count,
            events: dto.events.into_iter().map(Into::into).collect(),
        }
    }
}

#[derive(Debug, Clone, Deserialize, Type)]
pub struct GetRecordingActionsArgs {
    pub recording_path: String,
}

#[tauri::command]
#[specta::specta]
#[tracing::instrument(
    level = "info",
    skip_all,
    fields(cmd = "get_recording_actions"),
    err(Debug)
)]
pub fn get_recording_actions(
    args: GetRecordingActionsArgs,
) -> Result<Option<ActionTimelineDto>, AppError> {
    let recording_path = PathBuf::from(&args.recording_path);
    let sidecar = action_timeline_sidecar_path_for(&recording_path);
    let bytes = match std::fs::read(&sidecar) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(AppError::from(e)),
    };
    let dto: CrateActionTimelineDto = serde_json::from_slice(&bytes)
        .map_err(|e| AppError::InvalidArgument(format!("actions sidecar parse: {e}")))?;
    Ok(Some(dto.into()))
}
