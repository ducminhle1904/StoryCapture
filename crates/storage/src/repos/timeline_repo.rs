//! CRUD for `timeline_state`. `layout_json` is an opaque string.

use crate::error::StorageError;
use crate::models::{now_millis, TimelineState};
use rusqlite::{params, Connection, OptionalExtension};

pub fn load(conn: &Connection, story_id: &str) -> Result<Option<TimelineState>, StorageError> {
    let row = conn
        .query_row(
            "SELECT story_id, layout_json, last_modified FROM timeline_state WHERE story_id = ?1",
            params![story_id],
            |r| {
                Ok(TimelineState {
                    story_id: r.get(0)?,
                    layout_json: r.get(1)?,
                    last_modified: r.get(2)?,
                })
            },
        )
        .optional()?;
    Ok(row)
}

pub fn save(conn: &Connection, story_id: &str, layout_json: &str) -> Result<(), StorageError> {
    let now = now_millis();
    conn.execute(
        "INSERT INTO timeline_state (story_id, layout_json, last_modified) \
         VALUES (?1, ?2, ?3) \
         ON CONFLICT(story_id) DO UPDATE SET layout_json = excluded.layout_json, last_modified = excluded.last_modified",
        params![story_id, layout_json, now],
    )?;
    Ok(())
}

pub fn delete(conn: &Connection, story_id: &str) -> Result<(), StorageError> {
    conn.execute(
        "DELETE FROM timeline_state WHERE story_id = ?1",
        params![story_id],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::migrations::project;

    fn conn() -> Connection {
        let mut c = Connection::open_in_memory().unwrap();
        project::migrations().to_latest(&mut c).unwrap();
        c
    }

    #[test]
    fn upsert_roundtrip() {
        let c = conn();
        assert!(load(&c, "s1").unwrap().is_none());
        save(&c, "s1", r#"{"tracks":[]}"#).unwrap();
        let s = load(&c, "s1").unwrap().unwrap();
        assert_eq!(s.layout_json, r#"{"tracks":[]}"#);
        save(&c, "s1", r#"{"tracks":[{"id":1}]}"#).unwrap();
        let s = load(&c, "s1").unwrap().unwrap();
        assert_eq!(s.layout_json, r#"{"tracks":[{"id":1}]}"#);
        delete(&c, "s1").unwrap();
        assert!(load(&c, "s1").unwrap().is_none());
    }
}
