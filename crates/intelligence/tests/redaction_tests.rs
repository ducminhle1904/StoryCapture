//! G1 guardrail — prove that tracing output cannot leak API keys or bearer
//! tokens regardless of which field path they travel through.

use std::io::Write;
use std::sync::{Arc, Mutex};

use intelligence::tracing::redaction_layer;
use tracing::subscriber::with_default;
use tracing_subscriber::fmt::MakeWriter;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::Registry;

/// Shared in-memory byte buffer used as a `MakeWriter` for the redaction
/// layer so tests can inspect the rendered output.
#[derive(Clone, Default)]
struct Capture(Arc<Mutex<Vec<u8>>>);

impl Capture {
    fn new() -> Self {
        Self::default()
    }

    fn drain(&self) -> String {
        let guard = self.0.lock().unwrap();
        String::from_utf8(guard.clone()).expect("utf8 output")
    }
}

struct CaptureWriter(Arc<Mutex<Vec<u8>>>);

impl Write for CaptureWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let mut g = self.0.lock().unwrap();
        g.extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl<'a> MakeWriter<'a> for Capture {
    type Writer = CaptureWriter;
    fn make_writer(&'a self) -> Self::Writer {
        CaptureWriter(self.0.clone())
    }
}

fn subscriber_with_capture() -> (Capture, impl tracing::Subscriber + Send + Sync) {
    let cap = Capture::new();
    let sub = Registry::default().with(redaction_layer(cap.clone()));
    (cap, sub)
}

#[test]
fn no_secret_leaks_in_tracing_output() {
    let (cap, sub) = subscriber_with_capture();
    let fake_key = "sk-ant-api03-ABCDEFGHIJKLMNOP";

    with_default(sub, || {
        tracing::info!(authorization = %format!("Bearer {fake_key}"), "test");
    });

    let out = cap.drain();
    assert!(!out.contains(fake_key), "secret leaked: {out}");
    assert!(!out.contains("Bearer "), "bearer prefix leaked: {out}");
}

#[test]
fn x_api_key_field_is_redacted() {
    let (cap, sub) = subscriber_with_capture();
    let fake_key = "xi-elev-123abcDEF45";

    with_default(sub, || {
        tracing::info!(x_api_key = %fake_key, "tts call");
    });

    let out = cap.drain();
    assert!(!out.contains(fake_key), "x_api_key leaked: {out}");
}

#[test]
fn value_level_regex_scrubs_inline_keys() {
    let (cap, sub) = subscriber_with_capture();
    let fake_key = "sk-ant-api03-XXXYYYZZZAAA";

    with_default(sub, || {
        tracing::info!(
            message = %format!("contains {fake_key} inline"),
            "leak test"
        );
    });

    let out = cap.drain();
    assert!(!out.contains(fake_key), "inline key leaked: {out}");
}
