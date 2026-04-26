//! v2 migration set. Registered by both `project` and `app` migration
//! bundles, though `app.sqlite` only installs the subset relevant to
//! globally scoped data (effect_presets); `project.sqlite` installs all
//! five.
//!
//! Pure `rusqlite_migration` — each `M::up` bumps `user_version` by 1. The
//! project tier advances from v1 (5 baseline tables) to v6 (v1 + 5 new
//! tables defined here).

use rusqlite_migration::M;

/// v2 migrations for `project.sqlite` — all 5 tables.
pub fn project_migrations() -> Vec<M<'static>> {
    vec![
        M::up(include_str!("m001_timeline_state.sql")),
        M::up(include_str!("m002_effect_presets.sql")),
        M::up(include_str!("m003_effect_settings.sql")),
        M::up(include_str!("m004_render_jobs.sql")),
        M::up(include_str!("m005_sound_library_index.sql")),
    ]
}

/// v2 migrations for `app.sqlite` — only the effect_presets table (global scope).
pub fn app_migrations() -> Vec<M<'static>> {
    vec![M::up(include_str!("m002_effect_presets.sql"))]
}
