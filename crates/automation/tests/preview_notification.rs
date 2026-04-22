//! Phase 09-01 — Rust bridge tests for the sidecar reader's
//! SidecarMsg::Notification branch + preview-frame watch channel.
//!
//! Drives the extracted `handle_sidecar_line` helper directly — no Node
//! subprocess — so the tests run on every `cargo test -p automation`.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use automation::playwright_driver::{handle_sidecar_line, Pending};
use automation::{Notification, PreviewFrame};
use serde_json::json;
use tokio::sync::{broadcast, oneshot, watch, Mutex};
use tokio::time::timeout;

fn fixtures() -> (
    Pending,
    broadcast::Sender<Notification>,
    watch::Sender<Option<PreviewFrame>>,
    watch::Receiver<Option<PreviewFrame>>,
) {
    let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
    let (notifications, _keep_open) = broadcast::channel::<Notification>(32);
    let (preview_tx, preview_rx) = watch::channel::<Option<PreviewFrame>>(None);
    (pending, notifications, preview_tx, preview_rx)
}

// Test A — notification parses and lands on the watch channel.
#[tokio::test]
async fn notification_publishes_preview_frame_on_watch_channel() {
    let (pending, notes, tx, mut rx) = fixtures();
    let line = r#"{"jsonrpc":"2.0","method":"preview/frame","params":{"data":"AAAA","width":16,"height":16,"timestamp":1.5}}"#;
    handle_sidecar_line(line, &pending, &notes, &tx).await;
    timeout(Duration::from_millis(200), rx.changed())
        .await
        .expect("watch never changed")
        .expect("watch sender dropped");
    let frame = rx.borrow().clone().expect("expected Some(frame)");
    assert_eq!(frame.data, "AAAA");
    assert_eq!(frame.width, 16);
    assert_eq!(frame.height, 16);
    assert_eq!(frame.timestamp, 1.5);
}

// Test B — regular id-carrying responses resolve the pending oneshot
// without touching the watch channel.
#[tokio::test]
async fn response_resolves_pending_oneshot_and_leaves_watch_untouched() {
    let (pending, notes, tx, rx) = fixtures();
    let (oneshot_tx, oneshot_rx) = oneshot::channel::<std::result::Result<serde_json::Value, String>>();
    pending.lock().await.insert(7, oneshot_tx);

    let line = r#"{"jsonrpc":"2.0","id":7,"result":{"ok":true}}"#;
    handle_sidecar_line(line, &pending, &notes, &tx).await;

    let resolved = timeout(Duration::from_millis(200), oneshot_rx)
        .await
        .expect("oneshot never resolved")
        .expect("oneshot sender dropped")
        .expect("rpc result was error");
    assert_eq!(resolved["ok"], true);
    assert!(rx.borrow().is_none(), "watch must not be touched by response");
}

// Test C — interleaved stream: response, notification, response, notification.
// Both calls resolve; the FINAL watch value is the second frame (latest-wins).
#[tokio::test]
async fn interleaved_stream_preserves_both_paths_with_latest_wins() {
    let (pending, notes, tx, mut rx) = fixtures();
    let (t1, r1) = oneshot::channel::<std::result::Result<serde_json::Value, String>>();
    let (t2, r2) = oneshot::channel::<std::result::Result<serde_json::Value, String>>();
    {
        let mut p = pending.lock().await;
        p.insert(1, t1);
        p.insert(2, t2);
    }

    handle_sidecar_line(
        r#"{"jsonrpc":"2.0","id":1,"result":{"n":1}}"#,
        &pending,
        &notes,
        &tx,
    )
    .await;
    handle_sidecar_line(
        r#"{"jsonrpc":"2.0","method":"preview/frame","params":{"data":"AAA","width":1,"height":1,"timestamp":1.0}}"#,
        &pending,
        &notes,
        &tx,
    )
    .await;
    handle_sidecar_line(
        r#"{"jsonrpc":"2.0","id":2,"result":{"n":2}}"#,
        &pending,
        &notes,
        &tx,
    )
    .await;
    handle_sidecar_line(
        r#"{"jsonrpc":"2.0","method":"preview/frame","params":{"data":"BBB","width":2,"height":2,"timestamp":2.0}}"#,
        &pending,
        &notes,
        &tx,
    )
    .await;

    assert_eq!(r1.await.unwrap().unwrap(), json!({"n": 1}));
    assert_eq!(r2.await.unwrap().unwrap(), json!({"n": 2}));
    // Latest-wins: final value is the second frame. `changed()` may resolve
    // for either update depending on scheduling; we assert the terminal
    // state via borrow() since the test sent sync.
    timeout(Duration::from_millis(200), rx.changed())
        .await
        .expect("watch never updated")
        .expect("sender dropped");
    let final_frame = rx.borrow().clone().expect("some frame");
    assert_eq!(final_frame.data, "BBB");
    assert_eq!(final_frame.width, 2);
}

// Test D — malformed preview/frame params warn-logs and does NOT panic;
// watch channel is not updated to a bad value.
#[tokio::test]
async fn malformed_preview_frame_params_do_not_panic_or_update_watch() {
    let (pending, notes, tx, rx) = fixtures();
    // `data` is the wrong type — serde decode into PreviewFrame must fail
    // and the reader must NOT crash.
    let line =
        r#"{"jsonrpc":"2.0","method":"preview/frame","params":{"data":42,"width":1,"height":1,"timestamp":1.0}}"#;
    handle_sidecar_line(line, &pending, &notes, &tx).await;
    assert!(rx.borrow().is_none(), "watch must be unchanged on malformed payload");
}

// Test E — unknown notification methods are tolerated: no panic, watch
// unchanged, broadcast still fans out (the tolerant path).
#[tokio::test]
async fn unknown_notification_method_is_tolerated_and_watch_unchanged() {
    let (pending, notes, tx, rx) = fixtures();
    let mut broadcast_rx = notes.subscribe();
    let line = r#"{"jsonrpc":"2.0","method":"unknown/thing","params":{"hello":"world"}}"#;
    handle_sidecar_line(line, &pending, &notes, &tx).await;
    let got = timeout(Duration::from_millis(200), broadcast_rx.recv())
        .await
        .expect("broadcast never received")
        .expect("channel closed");
    assert_eq!(got.method, "unknown/thing");
    assert!(rx.borrow().is_none(), "watch must be unchanged on unknown method");
}
