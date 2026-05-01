use crate::driver::BoundingBox;
use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::{Path, PathBuf};
use story_parser::Viewport;

pub const ACTION_TIMELINE_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct ActionPoint {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ActionTarget {
    pub kind: String,
    pub label: Option<String>,
    pub center: ActionPoint,
    pub bounds: BoundingBox,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PointerButton {
    Left,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ActionPointer {
    pub button: PointerButton,
    pub effect: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ActionTimelineEvent {
    pub step_id: Option<String>,
    pub ordinal: u32,
    pub verb: String,
    pub t_start_ms: u64,
    pub t_action_ms: u64,
    pub t_end_ms: u64,
    pub target: Option<ActionTarget>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secondary_target: Option<ActionTarget>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pointer: Option<ActionPointer>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ActionTimelineDto {
    pub version: u32,
    pub recording_path: String,
    pub viewport: Viewport,
    pub capture_rect: ActionCaptureRect,
    pub fps: u32,
    pub frame_count: u32,
    pub events: Vec<ActionTimelineEvent>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct ActionCaptureRect {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

impl ActionCaptureRect {
    pub fn from_viewport(viewport: Viewport) -> Self {
        Self {
            x: 0.0,
            y: 0.0,
            width: viewport.width as f32,
            height: viewport.height as f32,
        }
    }
}

pub fn sidecar_path_for(recording_path: &Path) -> PathBuf {
    recording_path.with_extension("actions.json")
}

pub fn write_atomic(path: &Path, dto: &ActionTimelineDto) -> crate::Result<()> {
    let parent = path.parent().ok_or_else(|| {
        crate::AutomationError::Io(format!("no parent dir for {}", path.display()))
    })?;
    std::fs::create_dir_all(parent)?;
    let bytes = serde_json::to_vec_pretty(dto)?;
    let mut tmp = tempfile::NamedTempFile::new_in(parent)?;
    tmp.write_all(&bytes)?;
    tmp.as_file().sync_data()?;
    tmp.persist(path)
        .map_err(|e| crate::AutomationError::Io(format!("persist to {}: {e}", path.display())))?;
    Ok(())
}

pub fn read(path: &Path) -> crate::Result<ActionTimelineDto> {
    let bytes = std::fs::read(path)?;
    Ok(serde_json::from_slice(&bytes)?)
}
