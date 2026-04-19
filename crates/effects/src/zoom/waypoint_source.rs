//! [`WaypointSource`] abstraction: decouples the planner from storage.
//!
//! The planner (Plan 05) takes a `&[Waypoint]`; production code gets that
//! slice by calling [`WaypointSource::load`] on whichever backend is wired up.
//! Tests use in-memory vectors, production uses [`SqliteWaypointSource`].
//!
//! ## Schema contract
//!
//! [`SqliteWaypointSource`] expects the following columns, in order:
//!
//! ```sql
//! CREATE TABLE steps (
//!     story_id TEXT,     -- matched against the query argument
//!     t_ms     INTEGER,  -- waypoint timestamp in milliseconds
//!     x        REAL,     -- viewport-space x coordinate
//!     y        REAL,     -- viewport-space y coordinate
//!     kind     TEXT      -- one of: click, hover, scroll, type, drag
//! );
//! ```
//!
//! **Note:** Phase 1's production `steps` table uses a different shape
//! (`session_id, ordinal, command_json, ...`). Bridging to that shape
//! requires a JSON-parsing adapter; it is out of scope for Plan 05 and will
//! be added when a later plan wires end-to-end SQLite → zoom. For now,
//! callers with the production schema must build an adapter that projects
//! into the columns above.

use crate::ast::types::Vec2;
use crate::error::EffectsError;
use crate::math::min_jerk::{Waypoint, WaypointKind};

use uuid::Uuid;

/// Trait for any backend that can load an ordered slice of [`Waypoint`]s for a
/// given story.
pub trait WaypointSource {
    fn load(&self, story_id: Uuid) -> Result<Vec<Waypoint>, EffectsError>;
}

/// Parse a storage-level kind string into [`WaypointKind`].
pub fn parse_waypoint_kind(s: &str) -> Result<WaypointKind, EffectsError> {
    match s {
        "click" => Ok(WaypointKind::Click),
        "hover" => Ok(WaypointKind::Hover),
        "scroll" => Ok(WaypointKind::Scroll),
        "type" => Ok(WaypointKind::Type),
        "drag" => Ok(WaypointKind::Drag),
        other => Err(EffectsError::UnknownWaypointKind(other.to_string())),
    }
}

#[cfg(feature = "sqlite")]
mod sqlite_impl {
    use super::*;
    use rusqlite::{Connection, Error as SqlError};

    /// Read [`Waypoint`]s from a SQLite `steps` table with the schema documented
    /// on [`super::WaypointSource`]. The query orders by `t_ms` ascending.
    pub struct SqliteWaypointSource<'a> {
        pub conn: &'a Connection,
    }

    impl<'a> SqliteWaypointSource<'a> {
        pub fn new(conn: &'a Connection) -> Self {
            Self { conn }
        }
    }

    impl<'a> WaypointSource for SqliteWaypointSource<'a> {
        fn load(&self, story_id: Uuid) -> Result<Vec<Waypoint>, EffectsError> {
            let mut stmt = self.conn.prepare(
                "SELECT t_ms, x, y, kind FROM steps WHERE story_id = ?1 ORDER BY t_ms ASC",
            )?;
            let rows = stmt.query_map([story_id.to_string()], |row| {
                let t_ms: i64 = row.get(0)?;
                let x: f64 = row.get(1)?;
                let y: f64 = row.get(2)?;
                let kind_str: String = row.get(3)?;
                let kind = parse_waypoint_kind(&kind_str).map_err(|e| {
                    SqlError::FromSqlConversionFailure(
                        3,
                        rusqlite::types::Type::Text,
                        Box::new(std::io::Error::new(
                            std::io::ErrorKind::InvalidData,
                            e.to_string(),
                        )),
                    )
                })?;
                Ok(Waypoint {
                    t_ms: t_ms as u64,
                    pos: Vec2::new(x as f32, y as f32),
                    kind,
                })
            })?;
            let mut out = Vec::new();
            for r in rows {
                out.push(r?);
            }
            Ok(out)
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn seed_table(conn: &Connection) {
            conn.execute_batch(
                "CREATE TABLE steps (
                    story_id TEXT NOT NULL,
                    t_ms INTEGER NOT NULL,
                    x REAL NOT NULL,
                    y REAL NOT NULL,
                    kind TEXT NOT NULL
                );",
            )
            .unwrap();
        }

        #[test]
        fn sqlite_waypoint_source_round_trip() {
            let conn = Connection::open_in_memory().unwrap();
            seed_table(&conn);
            let story_id = Uuid::from_bytes([0x42; 16]);
            let rows = [
                (100, 10.0, 20.0, "click"),
                (200, 30.0, 40.0, "hover"),
                (300, 50.0, 60.0, "scroll"),
                (400, 70.0, 80.0, "type"),
                (500, 90.0, 100.0, "drag"),
            ];
            for (t_ms, x, y, kind) in rows {
                conn.execute(
                    "INSERT INTO steps (story_id, t_ms, x, y, kind) VALUES (?1, ?2, ?3, ?4, ?5)",
                    rusqlite::params![story_id.to_string(), t_ms, x, y, kind],
                )
                .unwrap();
            }
            let src = SqliteWaypointSource::new(&conn);
            let wps = src.load(story_id).unwrap();
            assert_eq!(wps.len(), 5);
            assert_eq!(wps[0].t_ms, 100);
            assert!((wps[0].pos.x - 10.0).abs() < 1e-3);
            assert_eq!(wps[0].kind, WaypointKind::Click);
            assert_eq!(wps[4].kind, WaypointKind::Drag);
        }

        #[test]
        fn sqlite_waypoint_source_filters_by_story_id() {
            let conn = Connection::open_in_memory().unwrap();
            seed_table(&conn);
            let story_a = Uuid::from_bytes([0x01; 16]);
            let story_b = Uuid::from_bytes([0x02; 16]);
            conn.execute(
                "INSERT INTO steps (story_id, t_ms, x, y, kind) VALUES (?1, ?2, ?3, ?4, ?5)",
                rusqlite::params![story_a.to_string(), 100, 0.0, 0.0, "click"],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO steps (story_id, t_ms, x, y, kind) VALUES (?1, ?2, ?3, ?4, ?5)",
                rusqlite::params![story_b.to_string(), 200, 10.0, 10.0, "click"],
            )
            .unwrap();
            let src = SqliteWaypointSource::new(&conn);
            assert_eq!(src.load(story_a).unwrap().len(), 1);
            assert_eq!(src.load(story_b).unwrap().len(), 1);
        }

        #[test]
        fn sqlite_unknown_kind_errors() {
            let conn = Connection::open_in_memory().unwrap();
            seed_table(&conn);
            let story_id = Uuid::from_bytes([0x03; 16]);
            conn.execute(
                "INSERT INTO steps (story_id, t_ms, x, y, kind) VALUES (?1, ?2, ?3, ?4, ?5)",
                rusqlite::params![story_id.to_string(), 100, 0.0, 0.0, "teleport"],
            )
            .unwrap();
            let src = SqliteWaypointSource::new(&conn);
            assert!(src.load(story_id).is_err());
        }
    }
}

#[cfg(feature = "sqlite")]
pub use sqlite_impl::SqliteWaypointSource;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_waypoint_kind_all_variants() {
        assert_eq!(parse_waypoint_kind("click").unwrap(), WaypointKind::Click);
        assert_eq!(parse_waypoint_kind("hover").unwrap(), WaypointKind::Hover);
        assert_eq!(parse_waypoint_kind("scroll").unwrap(), WaypointKind::Scroll);
        assert_eq!(parse_waypoint_kind("type").unwrap(), WaypointKind::Type);
        assert_eq!(parse_waypoint_kind("drag").unwrap(), WaypointKind::Drag);
        assert!(parse_waypoint_kind("teleport").is_err());
    }
}
