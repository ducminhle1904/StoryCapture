//! `storage` — two-tier SQLite (rusqlite + rusqlite_migration): global
//! `app.sqlite` (projects index, app settings) + per-project `project.sqlite`
//! (sessions, steps, exports, presets) inside each project folder.
//!
//! Pure crate: no Tauri imports. Reusable from the future Phase 5 headless CLI.

mod app_db;
mod error;
mod migrations;
mod models;
mod project_db;

pub use app_db::AppDb;
pub use error::StorageError;
pub use models::*;
pub use project_db::{ProjectDb, PROJECT_DB_FILENAME};
