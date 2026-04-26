//! Migrations for the global `app.sqlite`. Each `M::up(...)` is one schema bump.
//!
//! v1: 001_init.sql — projects, app_settings.
//! v2: effect_presets (global-scope presets mirror).

use rusqlite_migration::{Migrations, M};

use super::v2;

pub fn migrations() -> Migrations<'static> {
    let mut all: Vec<M<'static>> = vec![M::up(include_str!("001_init.sql"))];
    all.extend(v2::app_migrations());
    Migrations::new(all)
}

/// v1 contributes 1 migration, v2 contributes 1 → total 2.
pub const LATEST_VERSION: u32 = 2;
