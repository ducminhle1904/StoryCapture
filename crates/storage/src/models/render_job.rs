//! Render queue model. Implements D-04 status machine.

use serde::{Deserialize, Serialize};
use std::fmt;
use std::path::PathBuf;
use std::str::FromStr;
use uuid::Uuid;

/// D-04 status machine. String representations MUST match the CHECK constraint
/// in `m004_render_jobs.sql` exactly.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RenderJobStatus {
    Pending,
    Running,
    Completed,
    Failed,
    Cancelled,
    Interrupted,
}

impl RenderJobStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            RenderJobStatus::Pending => "pending",
            RenderJobStatus::Running => "running",
            RenderJobStatus::Completed => "completed",
            RenderJobStatus::Failed => "failed",
            RenderJobStatus::Cancelled => "cancelled",
            RenderJobStatus::Interrupted => "interrupted",
        }
    }
}

impl fmt::Display for RenderJobStatus {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for RenderJobStatus {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "pending" => Ok(RenderJobStatus::Pending),
            "running" => Ok(RenderJobStatus::Running),
            "completed" => Ok(RenderJobStatus::Completed),
            "failed" => Ok(RenderJobStatus::Failed),
            "cancelled" => Ok(RenderJobStatus::Cancelled),
            "interrupted" => Ok(RenderJobStatus::Interrupted),
            other => Err(format!("unknown render job status: {other}")),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RenderJob {
    pub id: Uuid,
    pub story_id: String,
    pub preset_id: Option<Uuid>,
    pub format: String,
    pub resolution: String,
    pub fps: u32,
    pub quality: String,
    pub status: RenderJobStatus,
    pub progress_pct: f32,
    pub started_at: Option<i64>,
    pub completed_at: Option<i64>,
    pub error: Option<String>,
    pub priority: i32,
    pub output_path: Option<PathBuf>,
    pub batch_id: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewRenderJob {
    pub story_id: String,
    pub preset_id: Option<Uuid>,
    pub format: String,
    pub resolution: String,
    pub fps: u32,
    pub quality: String,
    pub priority: i32,
    pub batch_id: Option<String>,
}
