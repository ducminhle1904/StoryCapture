//! Shared command helpers used across NL and TTS command modules.

use std::path::{Path, PathBuf};

use crate::state::AppState;

/// Resolve the SQLite database path for a given project from AppState.
pub fn project_db_path(app_state: &AppState, project_id: &str) -> PathBuf {
    project_db_path_from_dir(&app_state.data_dir, project_id)
}

/// Resolve the SQLite database path for a given project from a data directory.
pub fn project_db_path_from_dir(data_dir: &Path, project_id: &str) -> PathBuf {
    data_dir.join(format!("projects/{project_id}/project.sqlite"))
}

/// Current time as milliseconds since the Unix epoch.
pub fn now_epoch_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

/// Current time as seconds since the Unix epoch.
pub fn now_epoch_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

/// Default web companion URL; overridable via STORYCAPTURE_WEB_URL env var.
pub fn web_url() -> String {
    std::env::var("STORYCAPTURE_WEB_URL")
        .unwrap_or_else(|_| "https://storycapture.app".to_string())
}
