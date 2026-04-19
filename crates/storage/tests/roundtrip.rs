//! Project-folder portability + integration tests. Proves the folder is the
//! portable unit (zip + move + open just works) and that the starter story
//! file parses cleanly through `story-parser`.

use std::path::{Path, PathBuf};
use storage::{
    create_project, list_projects, open_project, NewExport, NewSession, StorageError,
    ASSETS_DIRNAME, DB_FILENAME, EXPORTS_DIRNAME, META_DIRNAME, STORY_FILENAME, VERSION_FILENAME,
};
use tempfile::tempdir;

fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if from.is_dir() {
            copy_dir_recursive(&from, &to)?;
        } else {
            std::fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

#[test]
fn create_project_produces_full_layout() {
    let parent = tempdir().unwrap();
    let folder = create_project(parent.path(), "My Demo Story").unwrap();
    let root = folder.root();
    assert!(root.join(DB_FILENAME).is_file(), "project.sqlite missing");
    assert!(root.join(STORY_FILENAME).is_file(), "story.story missing");
    assert!(root.join(ASSETS_DIRNAME).is_dir(), "assets/ missing");
    assert!(root.join(EXPORTS_DIRNAME).is_dir(), "exports/ missing");
    assert!(
        root.join(META_DIRNAME).join(VERSION_FILENAME).is_file(),
        ".storycapture/version.txt missing"
    );
    // Slug derivation
    assert!(root
        .file_name()
        .unwrap()
        .to_string_lossy()
        .contains("my-demo-story"));
}

#[test]
fn reopen_project_after_move() {
    let parent_a = tempdir().unwrap();
    let parent_b = tempdir().unwrap();

    let mut folder = create_project(parent_a.path(), "Movable").unwrap();
    let session_id = folder
        .db_mut()
        .insert_session(NewSession {
            story_hash: "deadbeef".into(),
            meta_json: "{}".into(),
        })
        .unwrap();
    drop(folder);

    let src = parent_a.path().join("movable");
    let dst = parent_b.path().join("relocated");
    copy_dir_recursive(&src, &dst).unwrap();

    let opened = open_project(&dst).unwrap();
    let sessions = opened.db().list_sessions().unwrap();
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0].id, session_id);
    assert_eq!(sessions[0].story_hash, "deadbeef");
}

#[test]
fn version_mismatch_rejected() {
    let parent = tempdir().unwrap();
    let folder = create_project(parent.path(), "Versioned").unwrap();
    let version_file = folder.root().join(META_DIRNAME).join(VERSION_FILENAME);
    drop(folder);

    std::fs::write(&version_file, "99").unwrap();

    let parent_path = parent.path().join("versioned");
    let result = open_project(&parent_path);
    match result {
        Ok(_) => panic!("expected InvalidProjectFolder"),
        Err(StorageError::InvalidProjectFolder(msg)) => {
            assert!(msg.contains("99") || msg.contains("version"), "msg: {msg}");
        }
        Err(other) => panic!("expected InvalidProjectFolder, got {other:?}"),
    }
}

#[test]
fn starter_story_parses() {
    let parent = tempdir().unwrap();
    let folder = create_project(parent.path(), "Story Test").unwrap();
    let source = std::fs::read_to_string(folder.story_path()).unwrap();
    let result = story_parser::parse(&source);
    assert!(
        result.diagnostics.is_empty(),
        "starter story produced diagnostics: {:#?}",
        result.diagnostics
    );
    assert!(result.ast.is_some(), "starter story produced no AST");
}

#[test]
fn zip_move_unzip_roundtrip() {
    // Simulated by recursive copy (no zip dep). Proves no absolute paths break
    // anything when the folder lives at a brand new location.
    let parent_a = tempdir().unwrap();
    let parent_b = tempdir().unwrap();

    let mut folder = create_project(parent_a.path(), "Zippy").unwrap();
    let sid = folder
        .db_mut()
        .insert_session(NewSession {
            story_hash: "h".into(),
            meta_json: "{}".into(),
        })
        .unwrap();
    folder
        .db_mut()
        .insert_export(NewExport {
            session_id: sid,
            format: "mp4".into(),
            path: PathBuf::from("exports/clip.mp4"), // RELATIVE
            size_bytes: 100,
            duration_ms: Some(1000),
        })
        .unwrap();
    drop(folder);

    let src = parent_a.path().join("zippy");
    let dst = parent_b.path().join("nested").join("deep").join("zippy");
    copy_dir_recursive(&src, &dst).unwrap();

    let opened = open_project(&dst).unwrap();
    let sessions = opened.db().list_sessions().unwrap();
    assert_eq!(sessions.len(), 1);
    let exports = opened.db().list_exports(sessions[0].id).unwrap();
    assert_eq!(exports.len(), 1);
    assert_eq!(
        exports[0].path,
        PathBuf::from("exports/clip.mp4"),
        "export path must be preserved as the relative string we stored"
    );
}

#[test]
fn list_projects_finds_folders() {
    let parent = tempdir().unwrap();
    create_project(parent.path(), "Alpha").unwrap();
    create_project(parent.path(), "Bravo").unwrap();
    create_project(parent.path(), "Charlie").unwrap();
    // A bare directory without the marker should be ignored.
    std::fs::create_dir_all(parent.path().join("not-a-project")).unwrap();

    let found = list_projects(parent.path()).unwrap();
    assert_eq!(found.len(), 3);
}

#[test]
fn no_absolute_paths_in_project_db() {
    let parent = tempdir().unwrap();
    let mut folder = create_project(parent.path(), "Relative").unwrap();
    let sid = folder
        .db_mut()
        .insert_session(NewSession {
            story_hash: "h".into(),
            meta_json: "{}".into(),
        })
        .unwrap();
    let rel = "exports/my.mp4";
    folder
        .db_mut()
        .insert_export(NewExport {
            session_id: sid,
            format: "mp4".into(),
            path: PathBuf::from(rel),
            size_bytes: 1,
            duration_ms: None,
        })
        .unwrap();
    let exports = folder.db().list_exports(sid).unwrap();
    assert_eq!(exports[0].path.to_string_lossy(), rel);
    assert!(
        !exports[0].path.is_absolute(),
        "path must remain relative — code must not canonicalize"
    );
}
