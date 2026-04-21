// projects.rs — dashboard + project IPC commands (Phase 1 plan 01-09).
//
// Thin wrappers around `storage::AppDb` + `storage::project_folder`. The
// `AppDb` connection is lazily opened inside each command — SQLite
// connections are cheap on desktop and this keeps `AppState` minimal (D-06:
// no `Arc<Mutex<BigState>>`). Each command opens → performs op → drops; the
// file is created on first access under `<app_data_dir>/app.sqlite`.
//
// Error mapping: every `storage::StorageError` is folded into
// `AppError::Storage`. NotFound cases use `AppError::NotFound`.

use crate::error::AppError;
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use storage::StorageError;
use tauri::State;

/// DTO mirror of `storage::Project`. Serializes `Uuid` as a string and
/// `PathBuf` as a string so the renderer sees plain JSON. `last_opened_at`
/// is `i64` millis since epoch (the renderer converts to `Date`).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct ProjectDto {
    pub id: String,
    pub name: String,
    pub folder_path: String,
    pub created_at: i64,
    pub last_opened_at: Option<i64>,
    pub thumbnail_path: Option<String>,
}

impl From<storage::Project> for ProjectDto {
    fn from(p: storage::Project) -> Self {
        ProjectDto {
            id: p.id.to_string(),
            name: p.name,
            folder_path: p.folder_path.to_string_lossy().into_owned(),
            created_at: p.created_at,
            last_opened_at: p.last_opened_at,
            thumbnail_path: p.thumbnail_path.map(|p| p.to_string_lossy().into_owned()),
        }
    }
}

/// Returned by `open_project` — enough context for the editor to load
/// the story file and show recent-session counts. The renderer uses
/// `folder_path` + `story_path` to read/write via `tauri-plugin-fs`.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct ProjectFolderInfoDto {
    pub id: String,
    pub name: String,
    pub folder_path: String,
    pub story_path: String,
    pub exports_dir: String,
    pub session_count: u64,
}

fn map_storage_err(e: StorageError) -> AppError {
    match e {
        StorageError::NotFound(m) => AppError::NotFound(m),
        StorageError::InvalidProjectFolder(m) => AppError::InvalidArgument(m),
        other => AppError::Storage(other.to_string()),
    }
}

fn open_app_db(state: &AppState) -> Result<storage::AppDb, AppError> {
    storage::bootstrap(&state.data_dir).map_err(map_storage_err)
}

#[tauri::command]
#[specta::specta]
pub fn list_projects(state: State<'_, AppState>) -> Result<Vec<ProjectDto>, AppError> {
    let db = open_app_db(&state)?;
    let rows = db.list_projects().map_err(map_storage_err)?;
    Ok(rows.into_iter().map(Into::into).collect())
}

#[derive(Debug, Clone, Deserialize, Type)]
pub struct CreateProjectArgs {
    pub name: String,
    /// Parent directory to create the project folder under. The folder
    /// name itself is derived from `name` via slugification (see
    /// `storage::project_folder::create_project`).
    pub parent: String,
}

#[tauri::command]
#[specta::specta]
pub fn create_project(
    state: State<'_, AppState>,
    args: CreateProjectArgs,
) -> Result<ProjectDto, AppError> {
    if args.name.trim().is_empty() {
        return Err(AppError::InvalidArgument("project name required".into()));
    }
    let parent = PathBuf::from(&args.parent);
    let folder = storage::create_project(&parent, &args.name).map_err(map_storage_err)?;
    let folder_path = folder.root().to_path_buf();
    // Register in AppDb.
    let mut db = open_app_db(&state)?;
    let id = db
        .insert_project(storage::NewProject {
            name: args.name.clone(),
            folder_path: folder_path.clone(),
        })
        .map_err(map_storage_err)?;
    // Touch so it sorts to the top of the dashboard.
    db.touch_project(id).map_err(map_storage_err)?;

    // Re-fetch to return the row the DB now owns (consistent last_opened_at).
    let projects = db.list_projects().map_err(map_storage_err)?;
    projects
        .into_iter()
        .find(|p| p.id == id)
        .map(Into::into)
        .ok_or_else(|| AppError::Internal("project vanished after insert".into()))
}

#[derive(Debug, Clone, Deserialize, Type)]
pub struct ProjectIdArg {
    pub id: String,
}

#[tauri::command]
#[specta::specta]
pub fn open_project(
    state: State<'_, AppState>,
    args: ProjectIdArg,
) -> Result<ProjectFolderInfoDto, AppError> {
    let id = uuid::Uuid::parse_str(&args.id)
        .map_err(|e| AppError::InvalidArgument(format!("invalid project id: {e}")))?;

    let mut db = open_app_db(&state)?;
    let row = db
        .list_projects()
        .map_err(map_storage_err)?
        .into_iter()
        .find(|p| p.id == id)
        .ok_or_else(|| AppError::NotFound(format!("project {id}")))?;

    let folder = storage::open_project(&row.folder_path).map_err(map_storage_err)?;
    let story_path = folder.story_path();
    let exports_dir = folder.exports_dir();
    let session_count = folder
        .db()
        .list_sessions()
        .map(|v| v.len() as u64)
        .unwrap_or(0);

    // Update last-opened so the dashboard reorders.
    let _ = db.touch_project(id);

    Ok(ProjectFolderInfoDto {
        id: row.id.to_string(),
        name: row.name,
        folder_path: row.folder_path.to_string_lossy().into_owned(),
        story_path: story_path.to_string_lossy().into_owned(),
        exports_dir: exports_dir.to_string_lossy().into_owned(),
        session_count,
    })
}

/// File-system metadata for a single `.mp4` under `<project>/exports/`.
/// Dimensions/duration are left `None` in this first pass — the frontend
/// falls back to hardcoded strings when absent.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct RecordingInfoDto {
    pub path: String,
    pub captured_at: i64,
    pub duration_ms: Option<u64>,
    pub width: Option<u32>,
    pub height: Option<u32>,
}

/// Pure scan of a directory: enumerates `*.mp4` (case-insensitive), pulls
/// `modified` (then `created`, then now) as unix millis, sorts newest-first.
/// Non-existent dirs and non-mp4 entries yield an empty/filtered result.
fn scan_exports_dir(dir: &Path) -> Vec<RecordingInfoDto> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut out: Vec<RecordingInfoDto> = entries
        .filter_map(|e| e.ok())
        .filter_map(|entry| {
            let path = entry.path();
            if !path.is_file() {
                return None;
            }
            let ext_ok = path
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| e.eq_ignore_ascii_case("mp4"))
                .unwrap_or(false);
            if !ext_ok {
                return None;
            }
            let meta = entry.metadata().ok()?;
            let ts = meta
                .modified()
                .or_else(|_| meta.created())
                .unwrap_or_else(|_| SystemTime::now());
            let captured_at = ts
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0);
            Some(RecordingInfoDto {
                path: path.to_string_lossy().into_owned(),
                captured_at,
                duration_ms: None,
                width: None,
                height: None,
            })
        })
        .collect();
    out.sort_by(|a, b| b.captured_at.cmp(&a.captured_at));
    out
}

#[tauri::command]
#[specta::specta]
pub fn list_project_recordings(
    state: State<'_, AppState>,
    args: ProjectIdArg,
) -> Result<Vec<RecordingInfoDto>, AppError> {
    let id = uuid::Uuid::parse_str(&args.id)
        .map_err(|e| AppError::InvalidArgument(format!("invalid project id: {e}")))?;

    let db = open_app_db(&state)?;
    let row = db
        .list_projects()
        .map_err(map_storage_err)?
        .into_iter()
        .find(|p| p.id == id)
        .ok_or_else(|| AppError::NotFound(format!("project {id}")))?;

    let exports_dir = row.folder_path.join("exports");
    if !exports_dir.exists() {
        return Ok(Vec::new());
    }
    Ok(scan_exports_dir(&exports_dir))
}

#[tauri::command]
#[specta::specta]
pub fn remove_project(state: State<'_, AppState>, args: ProjectIdArg) -> Result<(), AppError> {
    let id = uuid::Uuid::parse_str(&args.id)
        .map_err(|e| AppError::InvalidArgument(format!("invalid project id: {e}")))?;
    let mut db = open_app_db(&state)?;
    db.remove_project(id).map_err(map_storage_err)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::thread::sleep;
    use std::time::Duration;

    #[test]
    fn scan_missing_dir_returns_empty() {
        let tmp = tempfile::tempdir().unwrap();
        let missing = tmp.path().join("exports");
        assert!(scan_exports_dir(&missing).is_empty());
    }

    #[test]
    fn scan_empty_dir_returns_empty() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(scan_exports_dir(tmp.path()).is_empty());
    }

    #[test]
    fn scan_filters_non_mp4_and_sorts_newest_first() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        let older = dir.join("older.mp4");
        fs::write(&older, b"x").unwrap();
        // Ensure a detectable mtime difference across filesystems.
        sleep(Duration::from_millis(20));
        let newer = dir.join("newer.MP4");
        fs::write(&newer, b"x").unwrap();
        fs::write(dir.join("readme.txt"), b"x").unwrap();
        fs::write(dir.join("frame.png"), b"x").unwrap();

        let got = scan_exports_dir(dir);
        assert_eq!(got.len(), 2, "only .mp4 files should appear");
        assert!(got[0].path.ends_with("newer.MP4"), "newest-first");
        assert!(got[1].path.ends_with("older.mp4"));
        assert!(got[0].captured_at >= got[1].captured_at);
        assert!(got[0].duration_ms.is_none());
        assert!(got[0].width.is_none());
        assert!(got[0].height.is_none());
    }
}
