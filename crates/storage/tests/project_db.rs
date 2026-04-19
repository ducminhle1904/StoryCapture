use std::path::PathBuf;
use storage::{NewAttempt, NewExport, NewSession, NewStep, ProjectDb, SessionStatus, StepStatus};
use tempfile::tempdir;

#[test]
fn session_step_attempt_cascade() {
    let td = tempdir().unwrap();
    let mut db = ProjectDb::open(td.path()).unwrap();

    let session_id = db
        .insert_session(NewSession {
            story_hash: "abc123".into(),
            meta_json: "{}".into(),
        })
        .unwrap();

    let step1 = db
        .append_step(
            session_id,
            NewStep {
                ordinal: 0,
                command_json: "{\"verb\":\"navigate\"}".into(),
            },
        )
        .unwrap();
    let step2 = db
        .append_step(
            session_id,
            NewStep {
                ordinal: 1,
                command_json: "{\"verb\":\"click\"}".into(),
            },
        )
        .unwrap();

    for step in [step1, step2] {
        db.append_attempt(
            step,
            NewAttempt {
                selector_strategy: "text".into(),
                selector_value: "Submit".into(),
                outcome: "matched".into(),
                screenshot_path: None,
            },
        )
        .unwrap();
        db.append_attempt(
            step,
            NewAttempt {
                selector_strategy: "css".into(),
                selector_value: "button.primary".into(),
                outcome: "ok".into(),
                screenshot_path: Some(PathBuf::from("assets/x.png")),
            },
        )
        .unwrap();
    }

    db.complete_step(step1, StepStatus::Succeeded, None)
        .unwrap();
    db.complete_step(step2, StepStatus::Failed, Some("boom"))
        .unwrap();
    db.complete_session(session_id, SessionStatus::Failed)
        .unwrap();

    let steps = db.list_steps(session_id).unwrap();
    assert_eq!(steps.len(), 2);
    assert_eq!(steps[0].ordinal, 0);
    assert_eq!(steps[0].status, StepStatus::Succeeded);
    assert_eq!(steps[1].status, StepStatus::Failed);
    assert_eq!(steps[1].error_message.as_deref(), Some("boom"));

    let attempts = db.list_attempts(step1).unwrap();
    assert_eq!(attempts.len(), 2);
    assert_eq!(attempts[0].step_id, step1);

    let sessions = db.list_sessions().unwrap();
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0].status, SessionStatus::Failed);
}

#[test]
fn export_insert_and_list() {
    let td = tempdir().unwrap();
    let mut db = ProjectDb::open(td.path()).unwrap();
    let session_id = db
        .insert_session(NewSession {
            story_hash: "h".into(),
            meta_json: "{}".into(),
        })
        .unwrap();

    db.insert_export(NewExport {
        session_id,
        format: "mp4".into(),
        path: PathBuf::from("exports/a.mp4"),
        size_bytes: 12345,
        duration_ms: Some(5000),
    })
    .unwrap();
    db.insert_export(NewExport {
        session_id,
        format: "mp4".into(),
        path: PathBuf::from("exports/b.mp4"),
        size_bytes: 99999,
        duration_ms: None,
    })
    .unwrap();

    let exports = db.list_exports(session_id).unwrap();
    assert_eq!(exports.len(), 2);
    assert!(exports[0].path.to_string_lossy().starts_with("exports/"));
}

#[test]
fn uuid_v7_monotonic() {
    let td = tempdir().unwrap();
    let mut db = ProjectDb::open(td.path()).unwrap();
    let mut ids = Vec::new();
    for _ in 0..100 {
        let id = db
            .insert_session(NewSession {
                story_hash: "h".into(),
                meta_json: "{}".into(),
            })
            .unwrap();
        ids.push(id.to_string());
    }
    let mut sorted = ids.clone();
    sorted.sort();
    assert_eq!(
        ids, sorted,
        "UUID v7 string order should match insertion order"
    );
}
