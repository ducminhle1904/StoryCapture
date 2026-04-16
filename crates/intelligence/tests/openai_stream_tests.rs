//! Fixture-driven tests for the OpenAI Chat Completions SSE provider.
//!
//! Mirrors `anthropic_stream_tests.rs` — exercises `process_event` directly
//! from fixture bytes (no HTTP) for deterministic parsing, plus a wiremock
//! leg for the full HTTP path (headers + Bearer token + response_format
//! land on the wire).

use std::collections::HashMap;
use std::path::PathBuf;

use eventsource_stream::Eventsource;
use futures_util::stream;
use futures_util::StreamExt;
use intelligence::llm::openai::{process_event, OpenAiProvider, ToolCallAccumulator};
use intelligence::llm::{LlmEvent, LlmProvider, LlmRequest};
use tokio::sync::mpsc;
use wiremock::matchers::{header, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn fixture_path(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("openai_sse")
        .join(name)
}

async fn drive_fixture(fixture: &str) -> (Vec<LlmEvent>, Option<intelligence::llm::LlmError>) {
    let raw = std::fs::read(fixture_path(fixture)).expect("read fixture");
    let mid = raw.len() / 2;
    let frames: Vec<Result<bytes::Bytes, std::io::Error>> = vec![
        Ok(bytes::Bytes::copy_from_slice(&raw[..mid])),
        Ok(bytes::Bytes::copy_from_slice(&raw[mid..])),
    ];
    let mut sse = stream::iter(frames).eventsource();

    let (tx, mut rx) = mpsc::channel(64);
    let mut accum: ToolCallAccumulator = HashMap::new();
    let mut err: Option<intelligence::llm::LlmError> = None;

    let handle = tokio::spawn(async move {
        let mut collected: Vec<LlmEvent> = Vec::new();
        while let Some(ev) = rx.recv().await {
            collected.push(ev);
        }
        collected
    });

    while let Some(frame) = sse.next().await {
        let frame = match frame {
            Ok(f) => f,
            Err(e) => {
                err = Some(intelligence::llm::LlmError::Sse(e.to_string()));
                break;
            }
        };
        match process_event(&frame.data, &mut accum, &tx).await {
            Ok(intelligence::llm::openai::EventOutcome::Continue) => continue,
            Ok(intelligence::llm::openai::EventOutcome::Stop) => break,
            Err(e) => {
                err = Some(e);
                break;
            }
        }
    }
    drop(tx);
    let events = handle.await.expect("collector joins");
    (events, err)
}

#[tokio::test]
async fn text_stream_yields_deltas_and_done_terminates() {
    let (events, err) = drive_fixture("text_stream.txt").await;
    assert!(err.is_none(), "unexpected error: {:?}", err);
    let texts: Vec<String> = events
        .iter()
        .filter_map(|e| match e {
            LlmEvent::TextDelta(s) => Some(s.clone()),
            _ => None,
        })
        .collect();
    assert_eq!(texts, vec!["Hello", ", ", "world!"]);

    // include_usage=true → final chunk carries usage with cache_read.
    let usage = events.iter().find_map(|e| match e {
        LlmEvent::Usage {
            input,
            output,
            cache_read,
            cache_write,
        } => Some((*input, *output, *cache_read, *cache_write)),
        _ => None,
    });
    assert_eq!(usage, Some((12, 7, 4, 0)));
}

#[tokio::test]
async fn tool_use_fixture_flushes_single_tool_event_with_concatenated_args() {
    let (events, err) = drive_fixture("tool_use_happy.txt").await;
    assert!(err.is_none(), "unexpected error: {:?}", err);

    let tool_events: Vec<_> = events
        .iter()
        .filter(|e| matches!(e, LlmEvent::ToolUseComplete { .. }))
        .collect();
    assert_eq!(
        tool_events.len(),
        1,
        "expected exactly one ToolUseComplete, got {:?}",
        events
    );
    match tool_events[0] {
        LlmEvent::ToolUseComplete { index, input } => {
            assert_eq!(*index, 0);
            let steps = input
                .get("steps")
                .expect("steps field")
                .as_array()
                .unwrap();
            assert_eq!(steps.len(), 1);
            assert_eq!(steps[0].get("id").unwrap(), "s1");
        }
        _ => unreachable!(),
    }

    // Usage was emitted after finish_reason.
    let usage = events.iter().find_map(|e| match e {
        LlmEvent::Usage { input, output, .. } => Some((*input, *output)),
        _ => None,
    });
    assert_eq!(usage, Some((20, 15)));
}

#[tokio::test]
async fn done_sentinel_terminates_without_error() {
    let (tx, _rx) = mpsc::channel(4);
    let mut accum: ToolCallAccumulator = HashMap::new();
    let outcome = process_event("[DONE]", &mut accum, &tx).await.unwrap();
    assert!(matches!(
        outcome,
        intelligence::llm::openai::EventOutcome::Stop
    ));
}

#[tokio::test]
async fn request_body_carries_bearer_and_response_format() {
    let server = MockServer::start().await;
    let sse_body = std::fs::read_to_string(fixture_path("text_stream.txt")).unwrap();
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .and(header("authorization", "Bearer test-key-xyz"))
        .and(header("content-type", "application/json"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "text/event-stream")
                .set_body_string(sse_body),
        )
        .expect(1)
        .mount(&server)
        .await;

    let provider = OpenAiProvider::with_base_url(
        "test-key-xyz".to_string(),
        format!("{}/v1/chat/completions", server.uri()),
    );

    let schema = serde_json::json!({
        "type": "json_schema",
        "json_schema": { "name": "emit_story_doc", "schema": {"type":"object"}, "strict": true }
    });
    let (tx, mut rx) = mpsc::channel(16);
    let req = LlmRequest {
        model: "gpt-4o-2024-11-20".into(),
        system_blocks: vec![serde_json::json!("you are a story compiler")],
        messages: vec![serde_json::json!({"role":"user","content":"compile"})],
        tools: vec![],
        tool_choice: Some(serde_json::json!({ "response_format": schema.clone() })),
        max_tokens: 512,
        temperature: 0.2,
    };

    let join = tokio::spawn(async move {
        let _ = provider.stream(req, tx).await;
    });
    while rx.recv().await.is_some() {}
    join.await.unwrap();

    let requests = server.received_requests().await.expect("requests captured");
    assert_eq!(requests.len(), 1);
    let body_json: serde_json::Value =
        serde_json::from_slice(&requests[0].body).expect("request body is JSON");
    assert_eq!(body_json["stream"], true);
    assert_eq!(body_json["stream_options"]["include_usage"], true);
    assert_eq!(body_json["response_format"], schema);
    assert_eq!(body_json["messages"][0]["role"], "system");
}
