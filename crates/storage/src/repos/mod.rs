//! Phase 2 repositories — one module per table. These operate on a raw
//! `rusqlite::Connection` (not `ProjectDb`) so they can be used against both
//! project.sqlite and app.sqlite where appropriate (preset_repo in particular
//! is tier-agnostic).

pub mod preset_repo;
pub mod render_job_repo;
pub mod sound_library_repo;
pub mod timeline_repo;
