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
use std::path::PathBuf;
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

#[tauri::command]
#[specta::specta]
pub fn remove_project(state: State<'_, AppState>, args: ProjectIdArg) -> Result<(), AppError> {
    let id = uuid::Uuid::parse_str(&args.id)
        .map_err(|e| AppError::InvalidArgument(format!("invalid project id: {e}")))?;
    let mut db = open_app_db(&state)?;
    db.remove_project(id).map_err(map_storage_err)
}
