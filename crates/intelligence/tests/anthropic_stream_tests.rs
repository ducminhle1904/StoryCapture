//! Fixture-driven tests for the Anthropic SSE stream provider.
//!
//! The unit tests drive `process_event` directly with fixture-derived data
//! strings (no HTTP) so we exercise the SSE parser + partial-JSON
//! accumulator deterministically. The wiremock test exercises the full
//! HTTP path to confirm headers + `cache_control` land on the wire.

use std::collections::HashMap;
use std::path::PathBuf;

use eventsource_stream::Eventsource;
use futures_util::stream;
use futures_util::StreamExt;
use intelligence::llm::anthropic::{
    process_event, AnthropicProvider, ANTHROPIC_PROMPT_CACHING_BETA,
    ANTHROPIC_VERSION,
};
use intelligence::llm::EventOutcome;
use intelligence::llm::{LlmEvent, LlmProvider, LlmRequest};
use tokio::sync::mpsc;
use wiremock::matchers::{header, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn fixture_path(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("anthropic_sse")
        .join(name)
}

async fn drive_fixture(fixture: &str) -> (Vec<LlmEvent>, Option<intelligence::llm::LlmError>) {
    let raw = std::fs::read(fixture_path(fixture)).expect("read fixture");
    // Feed bytes through the same eventsource-stream adapter the provider
    // uses. Split into two frames at an arbitrary mid-point to exercise the
    // buffer-boundary path (pitfall #1).
    let mid = raw.len() / 2;
    let frames: Vec<Result<bytes::Bytes, std::io::Error>> = vec![
        Ok(bytes::Bytes::copy_from_slice(&raw[..mid])),
        Ok(bytes::Bytes::copy_from_slice(&raw[mid..])),
    ];
    let mut sse = stream::iter(frames).eventsource();

    let (tx, mut rx) = mpsc::channel(64);
    let mut bufs: HashMap<u32, String> = HashMap::new();
    let mut err = None;

    // Drain SSE in-task; forward events to tx.
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
        match process_event(&frame.data, &mut bufs, &tx).await {
            Ok(EventOutcome::Continue) => continue,
            Ok(EventOutcome::Stop) => break,
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
async fn text_deltas_stream_in_order() {
    let (events, err) = drive_fixture("text_deltas.txt").await;
    assert!(err.is_none(), "unexpected error: {:?}", err);
    let texts: Vec<String> = events
        .iter()
        .filter_map(|e| match e {
            LlmEvent::TextDelta(s) => Some(s.clone()),
            _ => None,
        })
        .collect();
    assert_eq!(texts, vec!["Hello", ", ", "world!"]);
}

#[tokio::test]
async fn partial_json_accumulator_yields_complete_on_stop() {
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
            let steps = input.get("steps").expect("steps field").as_array().unwrap();
            assert_eq!(steps.len(), 1);
            assert_eq!(steps[0].get("id").unwrap(), "s1");
        }
        _ => unreachable!(),
    }

    // Usage event should also be emitted with cache counters.
    let usage = events.iter().find_map(|e| match e {
        LlmEvent::Usage {
            input,
            output,
            cache_read,
            cache_write,
        } => Some((*input, *output, *cache_read, *cache_write)),
        _ => None,
    });
    assert_eq!(usage, Some((10, 25, 8, 2)));
}

#[tokio::test]
async fn multibyte_text_survives_frame_split() {
    let (events, err) = drive_fixture("multibyte_text.txt").await;
    assert!(err.is_none(), "unexpected error: {:?}", err);
    let joined: String = events
        .iter()
        .filter_map(|e| match e {
            LlmEvent::TextDelta(s) => Some(s.clone()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("");
    assert!(joined.contains('\u{26a1}'), "missing ⚡ in {:?}", joined);
    assert!(joined.contains("fast"));
    assert!(joined.contains(" done"));
}

#[tokio::test]
async fn error_event_terminates_stream_with_provider_error() {
    let (_events, err) = drive_fixture("error_event.txt").await;
    match err {
        Some(intelligence::llm::LlmError::Provider(msg)) => {
            assert!(msg.contains("overloaded"), "unexpected message: {}", msg);
        }
        other => panic!("expected Provider error, got {:?}", other),
    }
}

#[tokio::test]
async fn request_body_includes_cache_control_and_beta_header() {
    let server = MockServer::start().await;
    // Respond with a minimal well-formed SSE stream so .send() succeeds.
    let sse_body = std::fs::read_to_string(fixture_path("text_deltas.txt")).unwrap();
    Mock::given(method("POST"))
        .and(path("/v1/messages"))
        .and(header("anthropic-version", ANTHROPIC_VERSION))
        .and(header("anthropic-beta", ANTHROPIC_PROMPT_CACHING_BETA))
        .and(header("x-api-key", "test-key-xyz"))
        .and(header("content-type", "application/json"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "text/event-stream")
                .set_body_string(sse_body),
        )
        .expect(1)
        .mount(&server)
        .await;

    let provider = AnthropicProvider::with_base_url(
        "test-key-xyz".to_string(),
        format!("{}/v1/messages", server.uri()),
    );

    let (tx, mut rx) = mpsc::channel(16);
    let req = LlmRequest {
        model: "claude-sonnet-4-6".into(),
        system_blocks: vec![serde_json::json!({"type":"text","text":"cached-prefix"})],
        messages: vec![serde_json::json!({"role":"user","content":"hi"})],
        tools: vec![],
        tool_choice: None,
        max_tokens: 512,
        temperature: 0.2,
    };

    let join = tokio::spawn(async move {
        let _ = provider.stream(req, tx).await;
    });

    // Drain the channel (events, if any, don't matter for this assertion).
    while rx.recv().await.is_some() {}
    join.await.unwrap();

    // Inspect the captured request body: cache_control must be on the last
    // system block and the system block must still carry the original text.
    let requests = server.received_requests().await.expect("requests captured");
    assert_eq!(requests.len(), 1);
    let body_json: serde_json::Value =
        serde_json::from_slice(&requests[0].body).expect("request body is JSON");
    let last_system = body_json["system"].as_array().unwrap().last().unwrap();
    assert_eq!(last_system["cache_control"]["type"], "ephemeral");
    assert_eq!(last_system["cache_control"]["ttl"], "1h");
    assert_eq!(last_system["text"], "cached-prefix");
    assert_eq!(body_json["stream"], true);
    assert_eq!(body_json["max_tokens"], 512);
}
