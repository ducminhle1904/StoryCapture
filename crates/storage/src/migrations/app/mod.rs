//! Migrations for the global `app.sqlite`. Each `M::up(...)` is one schema bump.

use rusqlite_migration::{Migrations, M};

pub fn migrations() -> Migrations<'static> {
    Migrations::new(vec![M::up(include_str!("001_init.sql"))])
}

/// Number of migrations defined — equals the expected `user_version` after
/// `to_latest`. Used by version-mismatch detection.
pub const LATEST_VERSION: u32 = 1;
