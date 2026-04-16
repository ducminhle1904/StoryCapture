//! Tracing redaction layer — G1 guardrail.
//!
//! Intercepts every tracing event and:
//!   1. Drops values of fields whose name matches a case-insensitive deny list
//!      (`authorization`, `x-api-key`, `x_api_key`, `xi-api-key`, `xi_api_key`,
//!      `cookie`, `set-cookie`, `api_key`, `apikey`).
//!   2. Scrubs remaining string field values for well-known API-key shapes
//!      (`sk-*`, `xai-*`, `xi-*`, `Bearer ...`) — each match replaced with `***`.
//!
//! The layer emits events to an inner `FmtLayer`; callers get a subscriber
//! whose rendered output is guaranteed free of those patterns.

use std::fmt;
use std::sync::OnceLock;

use regex::Regex;
use tracing::field::{Field, Visit};
use tracing::{Event, Subscriber};
use tracing_subscriber::fmt::MakeWriter;
use tracing_subscriber::layer::{Context, Layer, SubscriberExt};
use tracing_subscriber::registry::LookupSpan;
use tracing_subscriber::Registry;

const DENY_FIELDS: &[&str] = &[
    "authorization",
    "x-api-key",
    "x_api_key",
    "xi-api-key",
    "xi_api_key",
    "cookie",
    "set-cookie",
    "api_key",
    "apikey",
];

fn scrub_regexes() -> &'static [Regex] {
    static REGEXES: OnceLock<Vec<Regex>> = OnceLock::new();
    REGEXES.get_or_init(|| {
        vec![
            // Bearer tokens (check before bare key shapes so the whole
            // "Bearer xxx" sequence gets replaced together).
            Regex::new(r"(?i)Bearer\s+[A-Za-z0-9_\-\.]{10,}").unwrap(),
            Regex::new(r"sk-[A-Za-z0-9_\-]{10,}").unwrap(),
            Regex::new(r"xai-[A-Za-z0-9_\-]{10,}").unwrap(),
            Regex::new(r"xi-[A-Za-z0-9_\-]{10,}").unwrap(),
        ]
    })
}

/// Apply all scrubbing regexes to `input`. Allocates a new `String` only when
/// a match was found.
pub(crate) fn scrub_value(input: &str) -> String {
    let mut out = input.to_string();
    for re in scrub_regexes() {
        out = re.replace_all(&out, "***").into_owned();
    }
    out
}

fn is_denied_field(name: &str) -> bool {
    DENY_FIELDS
        .iter()
        .any(|d| d.eq_ignore_ascii_case(name))
}

/// Layer that sanitises events and writes the sanitised form through an
/// inner writer. Intended to be composed with `tracing_subscriber::Registry`.
pub struct RedactionLayer<W>
where
    W: for<'w> MakeWriter<'w> + Send + Sync + 'static,
{
    writer: W,
}

impl<W> RedactionLayer<W>
where
    W: for<'w> MakeWriter<'w> + Send + Sync + 'static,
{
    pub fn new(writer: W) -> Self {
        Self { writer }
    }
}

struct SanitisingVisitor {
    buf: String,
}

impl SanitisingVisitor {
    fn new() -> Self {
        Self { buf: String::new() }
    }
}

impl Visit for SanitisingVisitor {
    fn record_debug(&mut self, field: &Field, value: &dyn fmt::Debug) {
        let name = field.name();
        if is_denied_field(name) {
            if !self.buf.is_empty() {
                self.buf.push(' ');
            }
            self.buf.push_str(name);
            self.buf.push_str("=***");
            return;
        }
        let raw = format!("{:?}", value);
        let scrubbed = scrub_value(&raw);
        if !self.buf.is_empty() {
            self.buf.push(' ');
        }
        self.buf.push_str(name);
        self.buf.push('=');
        self.buf.push_str(&scrubbed);
    }

    fn record_str(&mut self, field: &Field, value: &str) {
        let name = field.name();
        if is_denied_field(name) {
            if !self.buf.is_empty() {
                self.buf.push(' ');
            }
            self.buf.push_str(name);
            self.buf.push_str("=***");
            return;
        }
        let scrubbed = scrub_value(value);
        if !self.buf.is_empty() {
            self.buf.push(' ');
        }
        self.buf.push_str(name);
        self.buf.push('=');
        self.buf.push_str(&scrubbed);
    }
}

impl<S, W> Layer<S> for RedactionLayer<W>
where
    S: Subscriber + for<'a> LookupSpan<'a>,
    W: for<'w> MakeWriter<'w> + Send + Sync + 'static,
{
    fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>) {
        use std::io::Write;

        let meta = event.metadata();
        let mut visitor = SanitisingVisitor::new();
        event.record(&mut visitor);

        let line = format!(
            "{} {} {}\n",
            meta.level(),
            meta.target(),
            visitor.buf
        );
        let mut writer = self.writer.make_writer();
        // Best-effort write — tracing layers must never panic on sink errors.
        let _ = writer.write_all(line.as_bytes());
    }
}

/// Build a redaction layer writing through `writer`. Compose with
/// `tracing_subscriber::Registry` via `.with(...)`.
pub fn redaction_layer<W>(writer: W) -> RedactionLayer<W>
where
    W: for<'w> MakeWriter<'w> + Send + Sync + 'static,
{
    RedactionLayer::new(writer)
}

/// Install a subscriber (Registry + RedactionLayer) as the process-wide
/// default. Returns `Err` if a global default is already set.
pub fn install_redaction_layer<W>(writer: W) -> Result<(), tracing::subscriber::SetGlobalDefaultError>
where
    W: for<'w> MakeWriter<'w> + Send + Sync + 'static,
{
    let subscriber = Registry::default().with(redaction_layer(writer));
    tracing::subscriber::set_global_default(subscriber)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scrub_value_replaces_sk_keys() {
        let out = scrub_value("leading sk-ant-api03-ABCDEFGHIJKLMNOP trailing");
        assert!(!out.contains("sk-ant-api03-ABCDEFGHIJKLMNOP"));
        assert!(out.contains("***"));
    }

    #[test]
    fn scrub_value_replaces_bearer_tokens() {
        let out = scrub_value("Authorization: Bearer abcdef0123456789");
        assert!(!out.contains("Bearer abcdef0123456789"));
        assert!(out.contains("***"));
    }

    #[test]
    fn deny_field_check_is_case_insensitive() {
        assert!(is_denied_field("Authorization"));
        assert!(is_denied_field("AUTHORIZATION"));
        assert!(is_denied_field("x-api-key"));
        assert!(is_denied_field("X-API-Key"));
        assert!(!is_denied_field("user_id"));
    }
}
