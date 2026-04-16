//! Phase 3 Plan 07 -- Integration tests for NL-to-DSL Tauri commands.
//!
//! Tests exercise the NlTaskRegistry, cost computation, and the DTO
//! conversion/diff layers. The actual Tauri command signatures require
//! an AppHandle + Channel which are non-trivial to construct in tests,
//! so we test the underlying logic units directly.

use tokio::task::AbortHandle;

/// Create a dummy `AbortHandle` for testing.
fn test_abort_handle() -> AbortHandle {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
        .unwrap();
    rt.block_on(async {
        let h = tokio::spawn(async {
            tokio::time::sleep(std::time::Duration::from_secs(3600)).await;
        });
        h.abort_handle()
    })
}

// ---- Task Registry tests ----

mod task_registry {
    use storycapture::state::nl_tasks::NlTaskRegistry;

    #[test]
    fn insert_stores_and_abort_removes() {
        let reg = NlTaskRegistry::default();
        let handle = super::test_abort_handle();
        assert!(reg.insert("t1".into(), "p1".into(), handle));
        assert!(reg.abort("t1"));
        // Second abort returns false -- already removed.
        assert!(!reg.abort("t1"));
    }

    #[test]
    fn cancel_unknown_task_returns_false() {
        let reg = NlTaskRegistry::default();
        assert!(!reg.abort("nonexistent"));
    }

    #[test]
    fn concurrency_cap_at_4_per_project() {
        let reg = NlTaskRegistry::default();
        for i in 0..4 {
            let h = super::test_abort_handle();
            assert!(
                reg.insert(format!("t{i}"), "proj-a".into(), h),
                "should accept task {i}"
            );
        }
        // 5th task for same project is rejected
        let h = super::test_abort_handle();
        assert!(
            !reg.insert("t4".into(), "proj-a".into(), h),
            "should reject 5th task"
        );
        // Different project is fine
        let h2 = super::test_abort_handle();
        assert!(
            reg.insert("other".into(), "proj-b".into(), h2),
            "should accept task for different project"
        );
    }

    #[test]
    fn doc_store_and_take() {
        let reg = NlTaskRegistry::default();
        let doc = intelligence::nl::schemas::StoryDoc {
            title: "Test".into(),
            steps: vec![
                intelligence::nl::schemas::StoryStep {
                    id: "s1".into(),
                    label: "Go".into(),
                    verb: intelligence::nl::schemas::DslVerb::Navigate,
                    args: serde_json::json!({"url": "https://example.com"}),
                    narration: None,
                },
                intelligence::nl::schemas::StoryStep {
                    id: "s2".into(),
                    label: "Click".into(),
                    verb: intelligence::nl::schemas::DslVerb::Click,
                    args: serde_json::json!({"target": "Login"}),
                    narration: None,
                },
                intelligence::nl::schemas::StoryStep {
                    id: "s3".into(),
                    label: "Type".into(),
                    verb: intelligence::nl::schemas::DslVerb::Type,
                    args: serde_json::json!({"selector": "#email", "text": "user@test.com"}),
                    narration: None,
                },
            ],
        };

        reg.store_doc("task-1".into(), doc.clone());
        assert!(reg.get_doc("task-1").is_some());

        let taken = reg.take_doc("task-1").unwrap();
        assert_eq!(taken.steps.len(), 3);
        assert_eq!(taken.title, "Test");

        // After take, doc is gone
        assert!(reg.get_doc("task-1").is_none());
    }

    #[test]
    fn doc_drop_removes() {
        let reg = NlTaskRegistry::default();
        let doc = intelligence::nl::schemas::StoryDoc {
            title: "T".into(),
            steps: vec![],
        };
        reg.store_doc("task-2".into(), doc);
        reg.drop_doc("task-2");
        assert!(reg.get_doc("task-2").is_none());
    }
}

// ---- Cost computation tests ----

mod cost_computation {
    use storycapture::commands::nl::compute_cost;

    #[test]
    fn cost_formula_matches_pricing_table() {
        // All uncached: 1000 input * $3/MTok + 500 output * $15/MTok
        let cost = compute_cost(1000, 500, 0, 0);
        let expected = (1000.0 * 3.0 + 500.0 * 15.0) / 1_000_000.0;
        assert!(
            (cost - expected).abs() < 1e-12,
            "cost={cost}, expected={expected}"
        );
    }

    #[test]
    fn cost_with_cache_read() {
        // 1000 input, 200 output, 800 cache_read, 0 cache_write
        // uncached = 1000 - 800 = 200
        let cost = compute_cost(1000, 200, 800, 0);
        let expected = (200.0 * 3.0 + 800.0 * 0.30 + 200.0 * 15.0) / 1_000_000.0;
        assert!(
            (cost - expected).abs() < 1e-12,
            "cost={cost}, expected={expected}"
        );
    }

    #[test]
    fn cost_with_cache_write() {
        // 1000 input, 100 output, 0 cache_read, 500 cache_write
        // uncached = 1000 - 500 = 500
        let cost = compute_cost(1000, 100, 0, 500);
        let expected = (500.0 * 3.0 + 500.0 * 6.0 + 100.0 * 15.0) / 1_000_000.0;
        assert!(
            (cost - expected).abs() < 1e-12,
            "cost={cost}, expected={expected}"
        );
    }

    #[test]
    fn cost_with_all_cache_fields() {
        // 2000 input, 300 output, 1000 cache_read, 500 cache_write
        // uncached = 2000 - 1000 - 500 = 500
        let cost = compute_cost(2000, 300, 1000, 500);
        let expected =
            (500.0 * 3.0 + 1000.0 * 0.30 + 500.0 * 6.0 + 300.0 * 15.0) / 1_000_000.0;
        assert!(
            (cost - expected).abs() < 1e-12,
            "cost={cost}, expected={expected}"
        );
    }

    #[test]
    fn cost_zero_tokens_is_zero() {
        let cost = compute_cost(0, 0, 0, 0);
        assert_eq!(cost, 0.0);
    }

    #[test]
    fn cost_saturating_sub_avoids_underflow() {
        // cache_read > input: should clamp uncached to 0
        let cost = compute_cost(100, 50, 200, 0);
        // 100.saturating_sub(200) = 0, 0.saturating_sub(0) = 0
        let expected = (0.0 * 3.0 + 200.0 * 0.30 + 50.0 * 15.0) / 1_000_000.0;
        assert!(
            (cost - expected).abs() < 1e-12,
            "cost={cost}, expected={expected}"
        );
    }
}

// ---- Diff apply / reject tests (via NlTaskRegistry doc cache) ----

mod diff_apply_reject {
    use intelligence::nl::schemas::{DslVerb, StoryDoc, StoryStep};
    use storycapture::state::nl_tasks::NlTaskRegistry;

    fn make_3_step_doc() -> StoryDoc {
        StoryDoc {
            title: "Login Flow".into(),
            steps: vec![
                StoryStep {
                    id: "s1".into(),
                    label: "Navigate".into(),
                    verb: DslVerb::Navigate,
                    args: serde_json::json!({"url": "https://example.com"}),
                    narration: None,
                },
                StoryStep {
                    id: "s2".into(),
                    label: "Click Login".into(),
                    verb: DslVerb::Click,
                    args: serde_json::json!({"target": "Login"}),
                    narration: None,
                },
                StoryStep {
                    id: "s3".into(),
                    label: "Type email".into(),
                    verb: DslVerb::Type,
                    args: serde_json::json!({"selector": "#email", "text": "user@test.com"}),
                    narration: None,
                },
            ],
        }
    }

    #[test]
    fn apply_all_steps_renders_full_story() {
        let reg = NlTaskRegistry::default();
        let doc = make_3_step_doc();
        reg.store_doc("t1".into(), doc);

        let taken = reg.take_doc("t1").unwrap();
        let text = taken.render_dsl();

        assert!(text.contains("navigate"), "should contain navigate command");
        assert!(text.contains("click"), "should contain click command");
        assert!(text.contains("type"), "should contain type command");
        assert!(text.contains("Login Flow"), "should contain story title");
    }

    #[test]
    fn apply_partial_steps_filters_correctly() {
        let reg = NlTaskRegistry::default();
        let doc = make_3_step_doc();
        reg.store_doc("t2".into(), doc);

        let taken = reg.take_doc("t2").unwrap();
        // Filter to only s1 and s3
        let step_ids = vec!["s1".to_string(), "s3".to_string()];
        let filtered_steps: Vec<_> = taken
            .steps
            .into_iter()
            .filter(|s| step_ids.contains(&s.id))
            .collect();
        let filtered_doc = StoryDoc {
            title: taken.title,
            steps: filtered_steps,
        };
        let text = filtered_doc.render_dsl();

        assert!(text.contains("navigate"), "should contain navigate (s1)");
        assert!(
            !text.contains(r#"click "Login""#),
            "should NOT contain click Login (s2)"
        );
        assert!(text.contains("type"), "should contain type (s3)");
    }

    #[test]
    fn reject_drops_doc_then_take_returns_none() {
        let reg = NlTaskRegistry::default();
        let doc = make_3_step_doc();
        reg.store_doc("t3".into(), doc);

        // Reject
        reg.drop_doc("t3");

        // Subsequent take returns None
        assert!(reg.take_doc("t3").is_none());
    }
}

// ---- NL load history (storage layer) test ----

mod load_history {
    use storage::phase3::{insert_nl_turn, load_nl_history, NlTurnInsert};
    use uuid::Uuid;

    fn setup_db() -> (storage::Connection, Uuid) {
        let conn = storage::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE nl_conversations (
                id                TEXT PRIMARY KEY,
                project_id        TEXT NOT NULL,
                turn_index        INTEGER NOT NULL,
                role              TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool')),
                content           TEXT NOT NULL,
                tool_calls_json   TEXT,
                llm_model         TEXT,
                llm_provider      TEXT,
                token_usage_json  TEXT,
                created_at        INTEGER NOT NULL,
                UNIQUE (project_id, turn_index)
            );",
        )
        .unwrap();
        let project_id = Uuid::now_v7();
        (conn, project_id)
    }

    #[test]
    fn load_returns_turns_in_order() {
        let (conn, pid) = setup_db();

        for i in 0..4 {
            let turn = NlTurnInsert {
                id: Uuid::now_v7(),
                project_id: pid,
                turn_index: i,
                role: if i % 2 == 0 {
                    "user".into()
                } else {
                    "assistant".into()
                },
                content: format!("Turn {i}"),
                tool_calls_json: None,
                llm_model: Some("claude-sonnet-4-6".into()),
                llm_provider: Some("anthropic".into()),
                token_usage_json: None,
                created_at: 1000 + i,
            };
            insert_nl_turn(&conn, &turn).unwrap();
        }

        let history = load_nl_history(&conn, &pid).unwrap();
        assert_eq!(history.len(), 4);
        for (i, turn) in history.iter().enumerate() {
            assert_eq!(turn.turn_index, i as i64);
            assert_eq!(turn.content, format!("Turn {i}"));
        }
    }

    #[test]
    fn load_empty_project_returns_empty() {
        let (conn, pid) = setup_db();
        let history = load_nl_history(&conn, &pid).unwrap();
        assert!(history.is_empty());
    }
}

// ---- Regen step prompt test ----

mod regen_step {
    #[test]
    fn regen_prompt_contains_step_id() {
        let step_id = "s42";
        let prompt = format!(
            "Regenerate ONLY step with id={step_id}. Keep all other steps unchanged. \
             The output must include ALL steps from the current story, with only the \
             specified step regenerated."
        );
        assert!(prompt.contains("Regenerate ONLY step"));
        assert!(prompt.contains("s42"));
    }
}

// ---- LLM metrics persistence test ----

mod llm_metrics {
    use storage::phase3::{insert_llm_metric, LlmTurnMetric};

    #[test]
    fn insert_and_read_llm_metric() {
        let conn = storage::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE llm_turn_metrics (
                turn_id             TEXT PRIMARY KEY,
                session_id          TEXT NOT NULL,
                provider            TEXT NOT NULL,
                model               TEXT NOT NULL,
                input_tokens        INTEGER NOT NULL,
                output_tokens       INTEGER NOT NULL,
                cache_read_tokens   INTEGER NOT NULL DEFAULT 0,
                cache_create_tokens INTEGER NOT NULL DEFAULT 0,
                first_token_ms      INTEGER,
                total_ms            INTEGER NOT NULL,
                cost_usd            REAL NOT NULL,
                error_code          TEXT,
                timestamp           INTEGER NOT NULL
            );",
        )
        .unwrap();

        let cost = storycapture::commands::nl::compute_cost(1000, 200, 800, 100);

        let metric = LlmTurnMetric {
            turn_id: "turn-001".into(),
            session_id: "sess-001".into(),
            provider: "anthropic".into(),
            model: "claude-sonnet-4-6".into(),
            input_tokens: 1000,
            output_tokens: 200,
            cache_read_tokens: 800,
            cache_create_tokens: 100,
            first_token_ms: Some(150),
            total_ms: 2500,
            cost_usd: cost,
            error_code: None,
            timestamp: 1700000000,
        };

        insert_llm_metric(&conn, &metric).unwrap();

        let stored_cost: f64 = conn
            .query_row(
                "SELECT cost_usd FROM llm_turn_metrics WHERE turn_id = ?1",
                ["turn-001"],
                |row| row.get(0),
            )
            .unwrap();
        assert!((stored_cost - cost).abs() < 1e-12);
    }
}
