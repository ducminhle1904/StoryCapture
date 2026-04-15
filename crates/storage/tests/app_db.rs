use std::path::PathBuf;
use storage::{AppDb, NewProject};
use tempfile::tempdir;

fn fresh_db_path() -> (tempfile::TempDir, PathBuf) {
    let td = tempdir().unwrap();
    let p = td.path().join("nested").join("app.sqlite");
    (td, p)
}

#[test]
fn open_creates_db_if_missing() {
    let (_td, path) = fresh_db_path();
    assert!(!path.exists());
    let db = AppDb::open(&path).unwrap();
    assert!(path.exists(), "db file should be created");
    assert_eq!(db.schema_version().unwrap(), 1);
}

#[test]
fn insert_and_list_projects() {
    let (_td, path) = fresh_db_path();
    let mut db = AppDb::open(&path).unwrap();
    let id_a = db
        .insert_project(NewProject {
            name: "Alpha".into(),
            folder_path: PathBuf::from("/tmp/alpha"),
        })
        .unwrap();
    let id_b = db
        .insert_project(NewProject {
            name: "Beta".into(),
            folder_path: PathBuf::from("/tmp/beta"),
        })
        .unwrap();
    let _id_c = db
        .insert_project(NewProject {
            name: "Gamma".into(),
            folder_path: PathBuf::from("/tmp/gamma"),
        })
        .unwrap();

    // Touch alpha last so it should appear first. Sleep to ensure distinct
    // millisecond timestamps so the ORDER BY last_opened_at is deterministic.
    db.touch_project(id_b).unwrap();
    std::thread::sleep(std::time::Duration::from_millis(5));
    db.touch_project(id_a).unwrap();

    let list = db.list_projects().unwrap();
    assert_eq!(list.len(), 3);
    assert_eq!(list[0].id, id_a);
    assert_eq!(list[1].id, id_b);
}

#[test]
fn setting_roundtrip() {
    let (_td, path) = fresh_db_path();
    let mut db = AppDb::open(&path).unwrap();
    assert!(db.get_setting("theme").unwrap().is_none());
    db.set_setting("theme", "dark").unwrap();
    assert_eq!(db.get_setting("theme").unwrap().as_deref(), Some("dark"));
    db.set_setting("theme", "light").unwrap();
    assert_eq!(db.get_setting("theme").unwrap().as_deref(), Some("light"));
}

#[test]
fn reopen_preserves_data() {
    let (_td, path) = fresh_db_path();
    {
        let mut db = AppDb::open(&path).unwrap();
        db.insert_project(NewProject {
            name: "Persist".into(),
            folder_path: PathBuf::from("/tmp/persist"),
        })
        .unwrap();
        db.set_setting("k", "v").unwrap();
    }
    let db = AppDb::open(&path).unwrap();
    assert_eq!(db.list_projects().unwrap().len(), 1);
    assert_eq!(db.get_setting("k").unwrap().as_deref(), Some("v"));
}
