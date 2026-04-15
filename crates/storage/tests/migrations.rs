use rusqlite::Connection;
use storage::{AppDb, ProjectDb, StorageError};
use tempfile::tempdir;

#[test]
fn fresh_db_runs_to_latest() {
    let td = tempdir().unwrap();
    let app_path = td.path().join("app.sqlite");
    let app = AppDb::open(&app_path).unwrap();
    // Phase 2 Plan 03: app.sqlite -> v2, project.sqlite -> v6.
    assert_eq!(app.schema_version().unwrap(), 2);

    let project_dir = td.path().join("proj");
    let proj = ProjectDb::open(&project_dir).unwrap();
    assert_eq!(proj.schema_version().unwrap(), 6);
}

#[test]
fn idempotent_rerun() {
    let td = tempdir().unwrap();
    let path = td.path().join("app.sqlite");
    let v1 = AppDb::open(&path).unwrap().schema_version().unwrap();
    let v2 = AppDb::open(&path).unwrap().schema_version().unwrap();
    assert_eq!(v1, v2, "second open must not bump version");
    assert_eq!(v1, 2);
}

#[test]
fn downgrade_detected_app() {
    let td = tempdir().unwrap();
    let path = td.path().join("app.sqlite");
    {
        let _ = AppDb::open(&path).unwrap();
    }
    // Bump user_version to a value higher than supported (simulates an older
    // build of the app trying to open a DB written by a newer build).
    {
        let conn = Connection::open(&path).unwrap();
        conn.pragma_update(None, "user_version", 99u32).unwrap();
    }
    let result = AppDb::open(&path);
    match result {
        Ok(_) => panic!("expected SchemaVersionMismatch"),
        Err(StorageError::SchemaVersionMismatch { expected, found }) => {
            assert_eq!(expected, 2);
            assert_eq!(found, 99);
        }
        Err(other) => panic!("expected SchemaVersionMismatch, got {other:?}"),
    }
}

#[test]
fn downgrade_detected_project() {
    let td = tempdir().unwrap();
    let folder = td.path().join("p");
    {
        let _ = ProjectDb::open(&folder).unwrap();
    }
    let path = folder.join("project.sqlite");
    {
        let conn = Connection::open(&path).unwrap();
        conn.pragma_update(None, "user_version", 42u32).unwrap();
    }
    let result = ProjectDb::open(&folder);
    let err = match result {
        Ok(_) => panic!("expected SchemaVersionMismatch"),
        Err(e) => e,
    };
    assert!(matches!(err, StorageError::SchemaVersionMismatch { found: 42, .. }));
}
