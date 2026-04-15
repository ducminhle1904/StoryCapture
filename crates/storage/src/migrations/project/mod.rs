//! Migrations for per-project `project.sqlite`.

use rusqlite_migration::{Migrations, M};

pub fn migrations() -> Migrations<'static> {
    Migrations::new(vec![M::up(include_str!("001_init.sql"))])
}

pub const LATEST_VERSION: u32 = 1;
