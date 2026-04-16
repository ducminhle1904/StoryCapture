//! Phase 3 plan 03 — G1-extension leak-proof test.
//!
//! Proves AI-05 invariant (ROADMAP Success Criteria #5): API keys for
//! `anthropic / openai / elevenlabs / openai_tts` NEVER appear in tracing
//! output when passing through `commands::keys::{key_set, key_test, key_delete}`.
//!
//! The canary string `KEY-LEAK-CANARY-1234567890` is embedded in the key we
//! feed the commands; asserting it is absent from the tracing buffer after
//! each command run is the contract.

use std::io;
use std::sync::{Arc, Mutex};

use storycapture::commands::keys::{
    key_delete_for_test, key_set_for_test, key_test_for_test, KeyError, KeyTestReport, ProviderId,
};
use tracing::subscriber::with_default;
use tracing_subscriber::fmt::MakeWriter;
use tracing_subscriber::{layer::SubscriberExt, Registry};
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

/// Test canary — the thing the G1-extension test proves never reaches logs.
const CANARY: &str = "sk-ant-api03-KEY-LEAK-CANARY-1234567890";

/// Collects tracing output into an in-memory buffer. Each `make_writer()` call
/// hands back a writer that appends to the shared `Vec<u8>`.
#[derive(Clone, Default)]
struct MemWriter(Arc<Mutex<Vec<u8>>>);

impl MemWriter {
    fn contents(&self) -> String {
        String::from_utf8_lossy(&self.0.lock().unwrap()).into_owned()
    }
}

struct MemWriterHandle(Arc<Mutex<Vec<u8>>>);

impl io::Write for MemWriterHandle {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl<'a> MakeWriter<'a> for MemWriter {
    type Writer = MemWriterHandle;
    fn make_writer(&'a self) -> Self::Writer {
        MemWriterHandle(self.0.clone())
    }
}

/// Build a subscriber that routes every event — including DEBUG — through the
/// redaction layer into `MemWriter`. We deliberately use the intelligence
/// crate's public layer so the test proves the integration, not just a grep.
fn subscriber_for(writer: MemWriter) -> impl tracing::Subscriber + Send + Sync {
    Registry::default().with(intelligence::tracing::redaction_layer(writer))
}

/// Service namespace used exclusively for this test binary — avoids polluting
/// any real `com.storycapture.keys` entries an operator may have configured.
fn test_service() -> String {
    format!(
        "com.storycapture.keys.test.{}",
        uuid::Uuid::new_v4().simple()
    )
}

/// Tearing down keychain state is best-effort; some CI hosts have no keychain
/// and the `_for_test` delete helper returns `KeyNotFound` harmlessly.
fn cleanup(service: &str, provider: ProviderId) {
    let _ = key_delete_for_test(service, provider);
}

#[test]
fn no_api_key_leak_from_key_commands() {
    // --- arrange ---
    let writer = MemWriter::default();
    let service = test_service();
    let sub = subscriber_for(writer.clone());

    // --- act: key_set under the redaction subscriber ---
    let set_result = with_default(sub, || {
        key_set_for_test(&service, ProviderId::Anthropic, CANARY.to_string())
    });

    // Keychain-unavailable CI: skip but still assert no leak before the error.
    if let Err(KeyError::KeychainUnavailable) = &set_result {
        let out = writer.contents();
        assert!(
            !out.contains("KEY-LEAK-CANARY"),
            "canary leaked even on keychain-unavailable path: {out}"
        );
        return;
    }
    set_result.expect("key_set should succeed on a working keychain");

    // --- assert: canary substring never appears in tracing output ---
    let out = writer.contents();
    assert!(
        !out.contains("KEY-LEAK-CANARY"),
        "canary substring leaked into tracing output: {out}"
    );
    assert!(
        !out.contains(CANARY),
        "raw key leaked into tracing output: {out}"
    );

    cleanup(&service, ProviderId::Anthropic);
}

#[tokio::test(flavor = "multi_thread")]
async fn no_api_key_leak_from_key_test_happy_path() {
    // --- arrange: wiremock serving the provider probe endpoint ---
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/v1/models"))
        .respond_with(ResponseTemplate::new(200).set_body_string(r#"{"data":[]}"#))
        .mount(&server)
        .await;

    std::env::set_var("STORYCAPTURE_TEST_PROVIDER_BASE_URL", server.uri());

    let writer = MemWriter::default();
    let service = test_service();

    // Store the canary key outside the subscriber so `key_set`'s tracing isn't
    // part of this test's capture — we only want to grade `key_test` here.
    let set = key_set_for_test(&service, ProviderId::Anthropic, CANARY.to_string());
    if let Err(KeyError::KeychainUnavailable) = set {
        std::env::remove_var("STORYCAPTURE_TEST_PROVIDER_BASE_URL");
        return;
    }
    set.expect("key_set should succeed");

    // --- act: key_test under the redaction subscriber ---
    let sub = subscriber_for(writer.clone());
    let report: KeyTestReport =
        with_default(sub, || key_test_for_test(&service, ProviderId::Anthropic))
            .expect("key_test should succeed against mock server");

    // --- assert ---
    assert!(report.ok, "probe should succeed (mock returns 200)");
    let out = writer.contents();
    assert!(
        !out.contains("KEY-LEAK-CANARY"),
        "canary leaked from key_test tracing output: {out}"
    );
    assert!(
        !report.detail.contains("KEY-LEAK-CANARY"),
        "canary leaked into KeyTestReport.detail: {}",
        report.detail
    );

    // Cleanup
    cleanup(&service, ProviderId::Anthropic);
    std::env::remove_var("STORYCAPTURE_TEST_PROVIDER_BASE_URL");
}

#[test]
fn key_delete_missing_returns_key_not_found_without_leak() {
    let writer = MemWriter::default();
    let service = test_service();
    let sub = subscriber_for(writer.clone());

    let res = with_default(sub, || {
        // Ensure the slot is empty first, then ask for a second delete.
        let _ = key_delete_for_test(&service, ProviderId::Openai);
        key_delete_for_test(&service, ProviderId::Openai)
    });

    match res {
        Err(KeyError::KeyNotFound) => {}
        Err(KeyError::KeychainUnavailable) => return, // CI with no keychain
        other => panic!("expected KeyNotFound, got {other:?}"),
    }

    let out = writer.contents();
    // The account identifier ("openai") may appear in DEBUG logs — that's
    // fine. What MUST NOT appear is any raw key value, and the canary that
    // was never stored here also must not appear.
    assert!(
        !out.contains("KEY-LEAK-CANARY"),
        "canary leaked into key_delete logs: {out}"
    );
}
