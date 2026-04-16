//! Phase 3 Plan 02 — v3 migration + phase3 helper integration tests.
//!
//! Covers:
//! - Fresh project db: all 4 v3 AI tables + session_rollup view exist.
//! - Idempotence: applying migrations twice is a no-op.
//! - UNIQUE(project_id, turn_index) rejects duplicate turn_index per project.
//! - Typed inserters/queries round-trip correctly.
//! - TTS cache upsert updates last_used_at on hash collision.
//! - session_total_cost sums llm_turn_metrics.cost_usd for a session.
//! - gc_tts_cache_older_than removes expired rows and calls the
//!   user-provided delete_fn with the file_path of each row.
//! - upsert_tts_cache rejects absolute paths and `..` traversal.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use storage::phase3::{
    gc_tts_cache_older_than, insert_llm_metric, insert_nl_turn, insert_tts_metric,
    load_nl_history, lookup_tts_cache, session_total_cost, upsert_tts_cache, LlmTurnMetric,
    NlTurn, NlTurnInsert, TtsCacheEntry, TtsClipMetric,
};
use storage::ProjectDb;
use tempfile::tempdir;
use uuid::Uuid;

fn open_db() -> (tempfile::TempDir, ProjectDb) {
    let dir = tempdir().unwrap();
    let db = ProjectDb::open(dir.path()).unwrap();
    (dir, db)
}

fn table_exists(conn: &rusqlite::Connection, name: &str, kind: &str) -> bool {
    let got: Option<String> = conn
        .query_row(
            "SELECT name FROM sqlite_master WHERE type=?1 AND name=?2",
            [kind, name],
            |r| r.get(0),
        )
        .ok();
    got.is_some()
}

#[test]
fn migration_v5_creates_all_tables() {
    // NB: historical plan name — the v3 bundle layers on top of v2. The
    // test name is kept per PLAN acceptance-criterion grep.
    let dir = tempdir().unwrap();
    let _ = ProjectDb::open(dir.path()).unwrap();

    let conn =
        rusqlite::Connection::open(dir.path().join(storage::PROJECT_DB_FILENAME)).unwrap();

    for t in [
        "nl_conversations",
        "tts_cache_index",
        "llm_turn_metrics",
        "tts_clip_metrics",
    ] {
        assert!(table_exists(&conn, t, "table"), "expected table {t}");
    }
    assert!(
        table_exists(&conn, "session_rollup", "view"),
        "expected session_rollup view"
    );

    let user_version: u32 = conn
        .pragma_query_value(None, "user_version", |r| r.get(0))
        .unwrap();
    // v1 (1) + v2 (5) + v3 (4) = 10
    assert_eq!(user_version, 10);
}

#[test]
fn migrations_v3_are_idempotent() {
    let dir = tempdir().unwrap();
    let _ = ProjectDb::open(dir.path()).unwrap();
    let db = ProjectDb::open(dir.path()).unwrap();
    assert_eq!(db.schema_version().unwrap(), 10);
}

#[test]
fn nl_conversations_rejects_duplicate_turn_index_per_project() {
    let (dir, _db) = open_db();
    let conn =
        rusqlite::Connection::open(dir.path().join(storage::PROJECT_DB_FILENAME)).unwrap();

    let project_id = Uuid::now_v7();
    let t0 = NlTurnInsert {
        id: Uuid::now_v7(),
        project_id,
        turn_index: 0,
        role: "user".into(),
        content: "hello".into(),
        tool_calls_json: None,
        llm_model: None,
        llm_provider: None,
        token_usage_json: None,
        created_at: 1_700_000_000_000,
    };
    insert_nl_turn(&conn, &t0).unwrap();

    let dup = NlTurnInsert {
        id: Uuid::now_v7(),
        turn_index: 0,
        ..t0.clone()
    };
    let err = insert_nl_turn(&conn, &dup);
    assert!(err.is_err(), "duplicate (project_id, turn_index) must fail");
}

#[test]
fn nl_turn_roundtrip_preserves_fields() {
    let (dir, _db) = open_db();
    let conn =
        rusqlite::Connection::open(dir.path().join(storage::PROJECT_DB_FILENAME)).unwrap();

    let project_id = Uuid::now_v7();
    let a = NlTurnInsert {
        id: Uuid::now_v7(),
        project_id,
        turn_index: 0,
        role: "user".into(),
        content: "Write a story".into(),
        tool_calls_json: None,
        llm_model: Some("claude-sonnet-4".into()),
        llm_provider: Some("anthropic".into()),
        token_usage_json: Some(r#"{"input":10,"output":0}"#.into()),
        created_at: 1_700_000_000_000,
    };
    let b = NlTurnInsert {
        id: Uuid::now_v7(),
        project_id,
        turn_index: 1,
        role: "assistant".into(),
        content: "Here's a DSL".into(),
        tool_calls_json: Some(r#"[{"name":"write_dsl"}]"#.into()),
        llm_model: Some("claude-sonnet-4".into()),
        llm_provider: Some("anthropic".into()),
        token_usage_json: Some(r#"{"input":10,"output":120}"#.into()),
        created_at: 1_700_000_001_000,
    };
    insert_nl_turn(&conn, &a).unwrap();
    insert_nl_turn(&conn, &b).unwrap();

    let rows: Vec<NlTurn> = load_nl_history(&conn, &project_id).unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].turn_index, 0);
    assert_eq!(rows[0].role, "user");
    assert_eq!(rows[0].content, "Write a story");
    assert_eq!(rows[1].turn_index, 1);
    assert_eq!(rows[1].role, "assistant");
    assert_eq!(
        rows[1].tool_calls_json.as_deref(),
        Some(r#"[{"name":"write_dsl"}]"#)
    );
    assert_eq!(
        rows[1].token_usage_json.as_deref(),
        Some(r#"{"input":10,"output":120}"#)
    );
}

#[test]
fn tts_cache_upsert_updates_last_used_at() {
    let (dir, _db) = open_db();
    let conn =
        rusqlite::Connection::open(dir.path().join(storage::PROJECT_DB_FILENAME)).unwrap();

    let entry_v1 = TtsCacheEntry {
        hash: "deadbeef".into(),
        step_id: Uuid::now_v7().to_string(),
        project_id: Uuid::now_v7().to_string(),
        file_path: PathBuf::from("voiceover/deadbeef.mp3"),
        provider: "elevenlabs".into(),
        model: "eleven_multilingual_v2".into(),
        voice_id: "Rachel".into(),
        script_sha: "aaaabbbb".into(),
        byte_size: 12_345,
        created_at: 1_700_000_000_000,
        last_used_at: 1_700_000_000_000,
    };
    upsert_tts_cache(&conn, &entry_v1).unwrap();
    let got = lookup_tts_cache(&conn, "deadbeef").unwrap().unwrap();
    assert_eq!(got.last_used_at, 1_700_000_000_000);

    // Second upsert with same hash → updates last_used_at, no duplicate row.
    let entry_v2 = TtsCacheEntry {
        last_used_at: 1_700_000_050_000,
        byte_size: 99_999, // should be ignored — only last_used_at is touched
        ..entry_v1.clone()
    };
    upsert_tts_cache(&conn, &entry_v2).unwrap();

    let got = lookup_tts_cache(&conn, "deadbeef").unwrap().unwrap();
    assert_eq!(got.last_used_at, 1_700_000_050_000);
    // byte_size stays the original (hash, not content, is the cache key)
    assert_eq!(got.byte_size, 12_345);

    // Exactly one row for this hash.
    let n: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM tts_cache_index WHERE hash = 'deadbeef'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(n, 1);
}

#[test]
fn session_total_cost_sums_llm_turn_metrics() {
    let (dir, _db) = open_db();
    let conn =
        rusqlite::Connection::open(dir.path().join(storage::PROJECT_DB_FILENAME)).unwrap();

    let session_id = Uuid::now_v7();
    let m1 = LlmTurnMetric {
        turn_id: Uuid::now_v7().to_string(),
        session_id: session_id.to_string(),
        provider: "anthropic".into(),
        model: "claude-sonnet-4".into(),
        input_tokens: 100,
        output_tokens: 200,
        cache_read_tokens: 0,
        cache_create_tokens: 0,
        first_token_ms: Some(450),
        total_ms: 1800,
        cost_usd: 0.0034,
        error_code: None,
        timestamp: 1_700_000_000_000,
    };
    let m2 = LlmTurnMetric {
        turn_id: Uuid::now_v7().to_string(),
        cost_usd: 0.0066,
        timestamp: 1_700_000_001_000,
        ..m1.clone()
    };
    insert_llm_metric(&conn, &m1).unwrap();
    insert_llm_metric(&conn, &m2).unwrap();

    let total = session_total_cost(&conn, &session_id).unwrap();
    assert!((total - 0.01).abs() < 1e-9, "expected 0.01, got {total}");
}

#[test]
fn gc_tts_cache_removes_old_rows_and_calls_delete_fn() {
    let (dir, _db) = open_db();
    let conn =
        rusqlite::Connection::open(dir.path().join(storage::PROJECT_DB_FILENAME)).unwrap();

    let now: i64 = 1_700_000_100_000;
    let week = 7 * 24 * 60 * 60 * 1000;
    let cutoff = now - week;

    let project_id = Uuid::now_v7().to_string();
    let step_id = Uuid::now_v7().to_string();

    let old = TtsCacheEntry {
        hash: "old".into(),
        step_id: step_id.clone(),
        project_id: project_id.clone(),
        file_path: PathBuf::from("voiceover/old.mp3"),
        provider: "p".into(),
        model: "m".into(),
        voice_id: "v".into(),
        script_sha: "s".into(),
        byte_size: 1,
        created_at: cutoff - 1_000,
        last_used_at: cutoff - 1_000, // older than cutoff
    };
    let fresh = TtsCacheEntry {
        hash: "fresh".into(),
        file_path: PathBuf::from("voiceover/fresh.mp3"),
        last_used_at: now, // newer than cutoff
        ..old.clone()
    };
    upsert_tts_cache(&conn, &old).unwrap();
    upsert_tts_cache(&conn, &fresh).unwrap();

    let deleted: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());
    let removed = gc_tts_cache_older_than(&conn, cutoff, |p: &Path| {
        deleted.lock().unwrap().push(p.to_path_buf());
        Ok(())
    })
    .unwrap();

    assert_eq!(removed, 1, "exactly one old entry should be gc'd");
    let deleted = deleted.into_inner().unwrap();
    assert_eq!(deleted, vec![PathBuf::from("voiceover/old.mp3")]);

    // Fresh row still present.
    assert!(lookup_tts_cache(&conn, "fresh").unwrap().is_some());
    assert!(lookup_tts_cache(&conn, "old").unwrap().is_none());
}

#[test]
fn upsert_tts_cache_rejects_path_traversal() {
    let (dir, _db) = open_db();
    let conn =
        rusqlite::Connection::open(dir.path().join(storage::PROJECT_DB_FILENAME)).unwrap();

    let bad_absolute = TtsCacheEntry {
        hash: "h1".into(),
        step_id: "s".into(),
        project_id: "p".into(),
        file_path: PathBuf::from("/etc/passwd"),
        provider: "p".into(),
        model: "m".into(),
        voice_id: "v".into(),
        script_sha: "s".into(),
        byte_size: 1,
        created_at: 1,
        last_used_at: 1,
    };
    assert!(upsert_tts_cache(&conn, &bad_absolute).is_err());

    let bad_traversal = TtsCacheEntry {
        file_path: PathBuf::from("voiceover/../etc/passwd"),
        ..bad_absolute.clone()
    };
    assert!(upsert_tts_cache(&conn, &bad_traversal).is_err());

    let bad_prefix = TtsCacheEntry {
        file_path: PathBuf::from("other/ok.mp3"),
        ..bad_absolute.clone()
    };
    assert!(upsert_tts_cache(&conn, &bad_prefix).is_err());

    // And the valid case works.
    let good = TtsCacheEntry {
        file_path: PathBuf::from("voiceover/ok.mp3"),
        ..bad_absolute.clone()
    };
    assert!(upsert_tts_cache(&conn, &good).is_ok());
}

#[test]
fn tts_clip_metric_insert_roundtrips() {
    let (dir, _db) = open_db();
    let conn =
        rusqlite::Connection::open(dir.path().join(storage::PROJECT_DB_FILENAME)).unwrap();

    let m = TtsClipMetric {
        clip_id: Uuid::now_v7().to_string(),
        step_id: Uuid::now_v7().to_string(),
        provider: "elevenlabs".into(),
        model: "eleven_multilingual_v2".into(),
        voice_id: "Rachel".into(),
        char_count: 42,
        audio_duration_ms: 3100,
        step_duration_ms: 3000,
        drift_ms: 100,
        cache_hit: 1,
        cost_usd: 0.0021,
        first_chunk_ms: Some(800),
        error_code: None,
        timestamp: 1_700_000_000_000,
    };
    insert_tts_metric(&conn, &m).unwrap();

    let n: i64 = conn
        .query_row("SELECT COUNT(*) FROM tts_clip_metrics", [], |r| r.get(0))
        .unwrap();
    assert_eq!(n, 1);
}
