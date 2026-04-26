//! Integration tests for the LSP IPC bridge.
//!
//! Tests exercise `LspBridge` end-to-end: JSON-RPC envelopes go in,
//! responses come out, and server-initiated notifications (like
//! `publishDiagnostics`) are forwarded via the broadcast channel.
//!
//! NO stdio is involved — this validates the architectural constraint.

use std::sync::Arc;
use std::time::Duration;

use intelligence::lsp::LspBridge;
use serde_json::json;
use tokio::time::timeout;

/// Helper: build a bridge and run the initialize handshake.
async fn initialized_bridge() -> Arc<LspBridge> {
    let (bridge, drain) = LspBridge::new();
    tokio::spawn(drain);

    // Send `initialize` request.
    let init_resp = bridge
        .handle_lsp_request(json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": { "capabilities": {} }
        }))
        .await
        .expect("initialize should succeed");

    assert!(init_resp.is_some(), "initialize must return a response");

    // Send `initialized` notification (no response expected).
    let notif_resp = bridge
        .handle_lsp_request(json!({
            "jsonrpc": "2.0",
            "method": "initialized",
            "params": {}
        }))
        .await
        .expect("initialized notification should succeed");

    // Notifications return None.
    assert!(
        notif_resp.is_none(),
        "initialized is a notification — no response"
    );

    bridge
}

/// Test 1: Send a synthetic `initialize` JSON-RPC request through the bridge;
/// receive a valid `initialize` response envelope with `capabilities`.
#[tokio::test]
async fn initialize_returns_capabilities() {
    let (bridge, drain) = LspBridge::new();
    tokio::spawn(drain);

    let resp = bridge
        .handle_lsp_request(json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": { "capabilities": {} }
        }))
        .await
        .expect("should not error");

    let resp_json = resp.expect("initialize must return Some(response)");

    // Must have `result` with `capabilities`.
    let result = resp_json
        .get("result")
        .expect("response must have 'result'");
    let caps = result
        .get("capabilities")
        .expect("result must have 'capabilities'");

    // Our server advertises hover + completion.
    assert!(
        caps.get("hoverProvider").is_some(),
        "capabilities must include hoverProvider"
    );
    assert!(
        caps.get("completionProvider").is_some(),
        "capabilities must include completionProvider"
    );

    // Server info check.
    let server_info = result.get("serverInfo");
    assert!(server_info.is_some(), "result must have serverInfo");
    assert_eq!(
        server_info.unwrap().get("name").and_then(|n| n.as_str()),
        Some("story-language-server")
    );
}

/// Test 2: Send `textDocument/didOpen`; receive `textDocument/publishDiagnostics`
/// via the notification broadcast channel.
#[tokio::test]
async fn did_open_publishes_diagnostics_via_notification() {
    let bridge = initialized_bridge().await;

    // Subscribe BEFORE sending didOpen so we catch the notification.
    let mut rx = bridge.subscribe();

    // Open a document with a known grammar error (invalid verb "badverb").
    bridge
        .handle_lsp_request(json!({
            "jsonrpc": "2.0",
            "method": "textDocument/didOpen",
            "params": {
                "textDocument": {
                    "uri": "file:///tmp/test.story",
                    "languageId": "story",
                    "version": 1,
                    "text": "story \"Test\" {\n  scene \"s1\" {\n    badverb \"x\"\n  }\n}"
                }
            }
        }))
        .await
        .expect("didOpen should succeed");

    // Wait for the publishDiagnostics notification with a timeout.
    let notification = timeout(Duration::from_secs(5), async {
        loop {
            match rx.recv().await {
                Ok(n) if n.method == "textDocument/publishDiagnostics" => return n,
                Ok(_) => continue, // skip other notifications
                Err(e) => panic!("broadcast recv error: {e}"),
            }
        }
    })
    .await
    .expect("should receive publishDiagnostics within 5s");

    assert_eq!(notification.method, "textDocument/publishDiagnostics");

    // Params should contain the document URI and diagnostics array.
    let params = &notification.params;
    assert_eq!(
        params.get("uri").and_then(|u| u.as_str()),
        Some("file:///tmp/test.story")
    );
    let diags = params
        .get("diagnostics")
        .and_then(|d| d.as_array())
        .expect("diagnostics must be an array");
    // The "badverb" line should produce at least one diagnostic.
    assert!(
        !diags.is_empty(),
        "expected at least one diagnostic for 'badverb'"
    );
}

/// Test 3: `textDocument/hover` at a known position returns hover content.
#[tokio::test]
async fn hover_returns_verb_documentation() {
    let bridge = initialized_bridge().await;

    // Open a document with a known verb.
    bridge
        .handle_lsp_request(json!({
            "jsonrpc": "2.0",
            "method": "textDocument/didOpen",
            "params": {
                "textDocument": {
                    "uri": "file:///tmp/hover.story",
                    "languageId": "story",
                    "version": 1,
                    "text": "story \"Test\" {\n  scene \"s1\" {\n    click \"#btn\"\n  }\n}"
                }
            }
        }))
        .await
        .expect("didOpen should succeed");

    // Hover over "click" (line 2, col 4).
    let hover_resp = bridge
        .handle_lsp_request(json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "textDocument/hover",
            "params": {
                "textDocument": { "uri": "file:///tmp/hover.story" },
                "position": { "line": 2, "character": 5 }
            }
        }))
        .await
        .expect("hover should not error");

    let resp_json = hover_resp.expect("hover must return Some(response)");
    let result = resp_json.get("result").expect("response must have result");

    // result should contain hover contents.
    assert!(
        !result.is_null(),
        "hover result should not be null for a known verb"
    );
    let contents = result.get("contents").expect("hover must have contents");
    // Should be a MarkupContent with markdown.
    let value = contents
        .get("value")
        .and_then(|v| v.as_str())
        .expect("contents must have a string value");
    assert!(
        value.to_lowercase().contains("click"),
        "hover content should describe the 'click' verb, got: {value}"
    );
}

/// Test 4: Two concurrent `lsp_request` calls with different request IDs
/// multiplex correctly.
#[tokio::test]
async fn concurrent_requests_multiplex_correctly() {
    let bridge = initialized_bridge().await;

    // Open a document.
    bridge
        .handle_lsp_request(json!({
            "jsonrpc": "2.0",
            "method": "textDocument/didOpen",
            "params": {
                "textDocument": {
                    "uri": "file:///tmp/concurrent.story",
                    "languageId": "story",
                    "version": 1,
                    "text": "story \"Test\" {\n  scene \"s1\" {\n    click \"#a\"\n    navigate \"https://example.com\"\n  }\n}"
                }
            }
        }))
        .await
        .expect("didOpen should succeed");

    // Fire two hover requests concurrently with different IDs.
    let bridge_clone = bridge.clone();
    let hover_a = tokio::spawn(async move {
        bridge_clone
            .handle_lsp_request(json!({
                "jsonrpc": "2.0",
                "id": 10,
                "method": "textDocument/hover",
                "params": {
                    "textDocument": { "uri": "file:///tmp/concurrent.story" },
                    "position": { "line": 2, "character": 5 }
                }
            }))
            .await
    });

    let bridge_clone2 = bridge.clone();
    let hover_b = tokio::spawn(async move {
        bridge_clone2
            .handle_lsp_request(json!({
                "jsonrpc": "2.0",
                "id": 11,
                "method": "textDocument/hover",
                "params": {
                    "textDocument": { "uri": "file:///tmp/concurrent.story" },
                    "position": { "line": 3, "character": 5 }
                }
            }))
            .await
    });

    let (resp_a, resp_b) = tokio::join!(hover_a, hover_b);

    let resp_a = resp_a.unwrap().expect("hover A should succeed");
    let resp_b = resp_b.unwrap().expect("hover B should succeed");

    // Both should return Some(response).
    let json_a = resp_a.expect("hover A must return a response");
    let json_b = resp_b.expect("hover B must return a response");

    // Verify IDs are correctly routed.
    assert_eq!(
        json_a.get("id").and_then(|id| id.as_i64()),
        Some(10),
        "response A must have id=10"
    );
    assert_eq!(
        json_b.get("id").and_then(|id| id.as_i64()),
        Some(11),
        "response B must have id=11"
    );

    // Both should have non-null results (both are valid verbs).
    assert!(
        !json_a.get("result").map_or(true, |r| r.is_null()),
        "hover A should have a non-null result"
    );
    assert!(
        !json_b.get("result").map_or(true, |r| r.is_null()),
        "hover B should have a non-null result"
    );
}
