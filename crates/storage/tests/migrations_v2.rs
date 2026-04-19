//! Phase 2 Plan 03 — v2 migration integration tests.
//!
//! Covers:
//! - Fresh project db: all 5 v2 tables exist at user_version=LATEST_VERSION.
//! - Fresh app db: effect_presets exists at user_version=2.
//! - Backward-compat: a v1 project db populated with a session upgrades
//!   cleanly and the pre-existing row is preserved.
//! - Idempotence: running migrations again is a no-op.

use storage::{create_project, open_project, AppDb, NewSession, ProjectDb, SessionStatus};
use tempfile::tempdir;

fn table_exists(conn: &rusqlite::Connection, name: &str) -> bool {
    let got: Option<String> = conn
        .query_row(
            "SELECT name FROM sqlite_master WHERE type='table' AND name=?1",
            [name],
            |r| r.get(0),
        )
        .ok();
    got.is_some()
}

#[test]
fn fresh_project_db_has_all_v2_tables() {
    let dir = tempdir().unwrap();
    let _ = ProjectDb::open(dir.path()).unwrap();

    // Re-open raw to inspect sqlite_master.
    let conn = rusqlite::Connection::open(dir.path().join(storage::PROJECT_DB_FILENAME)).unwrap();

    for t in [
        // v1
        "sessions",
        "steps",
        "step_attempts",
        "exports",
        "presets",
        // v2
        "timeline_state",
        "effect_presets",
        "effect_settings",
        "render_jobs",
        "sound_library_index",
    ] {
        assert!(
            table_exists(&conn, t),
            "expected table {t} after migrations"
        );
    }

    let user_version: u32 = conn
        .pragma_query_value(None, "user_version", |r| r.get(0))
        .unwrap();
    assert_eq!(
        user_version, 11,
        "project.sqlite should be at v11 (1 v1 + 5 v2 + 5 v3)"
    );
}

#[test]
fn fresh_app_db_has_effect_presets_at_v2() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("app.sqlite");
    let _ = AppDb::open(&path).unwrap();

    let conn = rusqlite::Connection::open(&path).unwrap();
    assert!(table_exists(&conn, "projects"));
    assert!(table_exists(&conn, "app_settings"));
    assert!(table_exists(&conn, "effect_presets"));

    let user_version: u32 = conn
        .pragma_query_value(None, "user_version", |r| r.get(0))
        .unwrap();
    assert_eq!(user_version, 2, "app.sqlite should be at v2 (1 v1 + 1 v2)");
}

#[test]
fn v1_project_db_upgrades_without_data_loss() {
    let dir = tempdir().unwrap();
    let db_path = dir.path().join(storage::PROJECT_DB_FILENAME);

    // Manually build a v1-only project.sqlite: apply ONLY the v1 migration
    // and set user_version=1.
    {
        let conn = rusqlite::Connection::open(&db_path).unwrap();
        conn.pragma_update(None, "journal_mode", "WAL").unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        let v1_sql = include_str!("../src/migrations/project/001_init.sql");
        conn.execute_batch(v1_sql).unwrap();
        conn.pragma_update(None, "user_version", 1u32).unwrap();

        // Seed a session row so we can verify it survives the upgrade.
        conn.execute(
            "INSERT INTO sessions (id, story_hash, started_at, status, meta_json) \
             VALUES ('v1-seed', 'abc123', 111, 'running', '{}')",
            [],
        )
        .unwrap();
    }

    // Open via ProjectDb — must auto-upgrade v1 -> v10.
    let db = ProjectDb::open(dir.path()).unwrap();
    assert_eq!(db.schema_version().unwrap(), 11);

    // Pre-existing row preserved.
    let conn = rusqlite::Connection::open(&db_path).unwrap();
    let hash: String = conn
        .query_row(
            "SELECT story_hash FROM sessions WHERE id = 'v1-seed'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(hash, "abc123", "v1 session row lost during upgrade");

    // And new v2 tables are present.
    for t in [
        "timeline_state",
        "effect_presets",
        "effect_settings",
        "render_jobs",
        "sound_library_index",
    ] {
        assert!(table_exists(&conn, t), "v2 table {t} missing after upgrade");
    }
}

#[test]
fn migrations_are_idempotent() {
    let dir = tempdir().unwrap();
    let _ = ProjectDb::open(dir.path()).unwrap();
    let db = ProjectDb::open(dir.path()).unwrap();
    assert_eq!(db.schema_version().unwrap(), 11);
    let db = ProjectDb::open(dir.path()).unwrap();
    assert_eq!(db.schema_version().unwrap(), 11);
}

#[test]
fn full_project_folder_reaches_v6() {
    // Sanity: create + open via public API reaches latest (v10) and the
    // existing v1 repo surface (sessions CRUD) continues to function. Test
    // name kept for historical grep stability.
    let dir = tempdir().unwrap();
    let _ = create_project(dir.path(), "My Project").unwrap();
    let folder = dir.path().join("my-project");

    let mut pf = open_project(&folder).unwrap();
    assert_eq!(pf.db().schema_version().unwrap(), 11);

    let sid = pf
        .db_mut()
        .insert_session(NewSession {
            story_hash: "hash".into(),
            meta_json: "{}".into(),
        })
        .unwrap();
    pf.db_mut()
        .complete_session(sid, SessionStatus::Completed)
        .unwrap();
}
