//! `storage` — two-tier SQLite (rusqlite + rusqlite_migration): global
//! `app.sqlite` (projects index, app settings, global effect presets) +
//! per-project `project.sqlite` (sessions, steps, exports, presets, timeline
//! state, effect presets/settings, render queue, sound library index).
//!
//! Pure crate: no Tauri imports. Reusable from the future Phase 5 headless CLI.

mod app_db;
mod error;
mod migrations;
mod models;
mod preset_io;
mod project_db;
mod project_folder;
pub mod repos;

pub use app_db::AppDb;
pub use error::StorageError;
pub use models::*;
pub use preset_io::{
    export_preset, import_preset, migrate_preset_v1_to_v2, ScpresetFile, ScpresetMetadata,
    CURRENT_SCPRESET_VERSION, MAX_SCPRESET_BYTES,
};
pub use project_db::{ProjectDb, PROJECT_DB_FILENAME};
pub use project_folder::{
    create_project, list_projects, open_project, ProjectFolder, ASSETS_DIRNAME, DB_FILENAME,
    EXPORTS_DIRNAME, FOLDER_FORMAT_VERSION, META_DIRNAME, STORY_FILENAME, VERSION_FILENAME,
};

use std::path::Path;

/// Convenience: open the global app db at `<app_data_dir>/app.sqlite`. The
/// Tauri host is expected to call this in `setup()` (Plan 03 wires it).
pub fn bootstrap(app_data_dir: &Path) -> Result<AppDb, StorageError> {
    AppDb::open(&app_data_dir.join("app.sqlite"))
}
