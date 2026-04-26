//! Public data model types. Baseline types (Project, Session, Step,
//! Export, Preset, ...) live inline here; later additions live in their
//! own submodules.
//!
//! All structs derive `Debug, Clone, Serialize, Deserialize`. UUID v7 is used
//! for all IDs (time-ordered, monotonic per process — preferred over v4 for
//! index locality on `id`-keyed tables).

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use uuid::Uuid;

pub mod effect_preset;
pub mod effect_settings;
pub mod render_job;
pub mod sound_library_entry;
pub mod timeline_state;

pub use effect_preset::{EffectPreset, NewEffectPreset, PresetTier};
pub use effect_settings::EffectSettings;
pub use render_job::{NewRenderJob, RenderJob, RenderJobStatus};
pub use sound_library_entry::{SoundCategory, SoundLibraryEntry};
pub use timeline_state::TimelineState;

// ---------- app.sqlite ----------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Project {
    pub id: Uuid,
    pub name: String,
    pub folder_path: PathBuf,
    pub created_at: i64,
    pub last_opened_at: Option<i64>,
    pub thumbnail_path: Option<PathBuf>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewProject {
    pub name: String,
    pub folder_path: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppSetting {
    pub key: String,
    pub value: String,
    pub updated_at: i64,
}

// ---------- project.sqlite ----------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionStatus {
    Running,
    Completed,
    Failed,
    Aborted,
}

impl SessionStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            SessionStatus::Running => "running",
            SessionStatus::Completed => "completed",
            SessionStatus::Failed => "failed",
            SessionStatus::Aborted => "aborted",
        }
    }

    pub fn parse(s: &str) -> Result<Self, String> {
        match s {
            "running" => Ok(SessionStatus::Running),
            "completed" => Ok(SessionStatus::Completed),
            "failed" => Ok(SessionStatus::Failed),
            "aborted" => Ok(SessionStatus::Aborted),
            other => Err(format!("unknown session status: {other}")),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Session {
    pub id: Uuid,
    pub story_hash: String,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    pub status: SessionStatus,
    pub meta_json: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewSession {
    pub story_hash: String,
    pub meta_json: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StepStatus {
    Running,
    Succeeded,
    Failed,
    Skipped,
}

impl StepStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            StepStatus::Running => "running",
            StepStatus::Succeeded => "succeeded",
            StepStatus::Failed => "failed",
            StepStatus::Skipped => "skipped",
        }
    }

    pub fn parse(s: &str) -> Result<Self, String> {
        match s {
            "running" => Ok(StepStatus::Running),
            "succeeded" => Ok(StepStatus::Succeeded),
            "failed" => Ok(StepStatus::Failed),
            "skipped" => Ok(StepStatus::Skipped),
            other => Err(format!("unknown step status: {other}")),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Step {
    pub id: Uuid,
    pub session_id: Uuid,
    pub ordinal: u32,
    pub command_json: String,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    pub status: StepStatus,
    pub error_message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewStep {
    pub ordinal: u32,
    pub command_json: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StepAttempt {
    pub id: Uuid,
    pub step_id: Uuid,
    pub selector_strategy: String,
    pub selector_value: String,
    pub attempted_at: i64,
    pub outcome: String,
    pub screenshot_path: Option<PathBuf>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewAttempt {
    pub selector_strategy: String,
    pub selector_value: String,
    pub outcome: String,
    pub screenshot_path: Option<PathBuf>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Export {
    pub id: Uuid,
    pub session_id: Uuid,
    pub format: String,
    pub path: PathBuf,
    pub size_bytes: u64,
    pub duration_ms: Option<u64>,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewExport {
    pub session_id: Uuid,
    pub format: String,
    pub path: PathBuf,
    pub size_bytes: u64,
    pub duration_ms: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PresetScope {
    Global,
    Project,
}

impl PresetScope {
    pub fn as_str(&self) -> &'static str {
        match self {
            PresetScope::Global => "global",
            PresetScope::Project => "project",
        }
    }

    pub fn parse(s: &str) -> Result<Self, String> {
        match s {
            "global" => Ok(PresetScope::Global),
            "project" => Ok(PresetScope::Project),
            other => Err(format!("unknown preset scope: {other}")),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Preset {
    pub id: Uuid,
    pub name: String,
    pub scope: PresetScope,
    pub config_json: String,
    pub created_at: i64,
}

// ---------- helpers ----------

/// Current unix epoch milliseconds. All timestamps in storage are i64 millis.
pub fn now_millis() -> i64 {
    let nanos = time::OffsetDateTime::now_utc().unix_timestamp_nanos();
    (nanos / 1_000_000) as i64
}
