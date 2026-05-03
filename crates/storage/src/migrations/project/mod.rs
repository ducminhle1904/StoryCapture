//! Migrations for per-project `project.sqlite`.
//!
//! v1: 001_init.sql — sessions, steps, step_attempts, exports, presets.
//! v2: 5 new tables (timeline_state, effect_presets, effect_settings,
//!   render_jobs, sound_library_index). Each is one M::up.
//! v3: 4 AI tables + session_rollup view (nl_conversations,
//!   tts_cache_index, llm_turn_metrics, tts_clip_metrics). View is bundled
//!   with the last table migration.

use rusqlite_migration::{Migrations, M};

use super::{v2, v3};

pub fn migrations() -> Migrations<'static> {
    let mut all: Vec<M<'static>> = vec![M::up(include_str!("001_init.sql"))];
    all.extend(v2::project_migrations());
    all.extend(v3::project_migrations());
    Migrations::new(all)
}

/// Count of migrations applied at `to_latest`. v1 contributes 1, v2
/// contributes 5, v3 contributes 6 → total 12.
pub const LATEST_VERSION: u32 = 12;
