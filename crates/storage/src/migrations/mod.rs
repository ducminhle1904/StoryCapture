//! Migration sets, one per database tier.
//!
//! Each tier exposes `migrations()` returning an already-built
//! `rusqlite_migration::Migrations<'static>` and `LATEST_VERSION: u32` used by
//! the newer-than-supported guard in `AppDb::open` / `ProjectDb::open`.

pub mod app;
pub mod project;
pub mod v2;
pub mod v3;
