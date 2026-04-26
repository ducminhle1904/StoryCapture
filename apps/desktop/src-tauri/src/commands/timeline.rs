// Timeline Tauri commands.
//
// Wraps `storage::repos::timeline_repo::{load,save}` so the Post-Production
// editor can persist its Zustand layout snapshot per story.
//
// `timeline_save` rejects payloads larger than `MAX_LAYOUT_BYTES` (1 MiB)
// to bound DoS exposure.

use serde::Serialize;
use storage::repos::timeline_repo;
use storage::TimelineState;
use tauri::State;

use crate::error::AppError;
use crate::state::AppState;

/// Maximum accepted `layout_json` size in bytes. 1 MiB is ~ 50x larger than
/// the realistic post-production layout snapshot (tracks + clip metadata),
/// leaving ample headroom for future fields while bounding DoS exposure.
pub const MAX_LAYOUT_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct TimelineStateDto {
    pub story_id: String,
    pub layout_json: String,
    pub last_modified: i64,
}

impl From<TimelineState> for TimelineStateDto {
    fn from(t: TimelineState) -> Self {
        Self {
            story_id: t.story_id,
            layout_json: t.layout_json,
            last_modified: t.last_modified,
        }
    }
}

#[tauri::command]
#[specta::specta]
#[tracing::instrument(level = "info", skip_all, fields(cmd = "timeline_load"), err(Debug))]
pub async fn timeline_load(
    state: State<'_, AppState>,
    story_id: String,
) -> Result<Option<TimelineStateDto>, AppError> {
    let queue = state
        .render_queue()
        .ok_or_else(|| AppError::Internal("render queue not initialised".into()))?;
    let conn = queue.db.lock().await;
    let row = timeline_repo::load(&conn, &story_id)?;
    Ok(row.map(Into::into))
}

#[tauri::command]
#[specta::specta]
#[tracing::instrument(level = "info", skip_all, fields(cmd = "timeline_save"), err(Debug))]
pub async fn timeline_save(
    state: State<'_, AppState>,
    story_id: String,
    layout_json: String,
) -> Result<(), AppError> {
    if layout_json.len() > MAX_LAYOUT_BYTES {
        return Err(AppError::InvalidArgument(format!(
            "layout_json is {} bytes; refusing > {} (T-02-38)",
            layout_json.len(),
            MAX_LAYOUT_BYTES
        )));
    }
    let queue = state
        .render_queue()
        .ok_or_else(|| AppError::Internal("render queue not initialised".into()))?;
    let conn = queue.db.lock().await;
    timeline_repo::save(&conn, &story_id, &layout_json)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn max_layout_bytes_is_1_mib() {
        assert_eq!(MAX_LAYOUT_BYTES, 1024 * 1024);
    }
}
