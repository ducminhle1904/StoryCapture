//! Anthropic Messages API provider — streaming SSE implementation.
//!
//! Implements the `LlmProvider` trait per AI-SPEC §3 entry-point pattern and
//! pitfalls #1–#8. Key behaviours:
//!
//! - `eventsource-stream` wraps `reqwest` byte stream so multi-byte UTF-8
//!   boundaries are handled for us (pitfall #1).
//! - Tool-use `input_json_delta` fragments accumulate per `index` into a
//!   `HashMap<u32, String>`; one `LlmEvent::ToolUseComplete` is emitted on
//!   `content_block_stop` with the parsed complete JSON (pitfall #2).
//! - `cache_control: { type: "ephemeral", ttl: "1h" }` is attached to the
//!   LAST system block (pitfall #4/#5). The `anthropic-beta:
//!   prompt-caching-2024-07-31` header is always sent.
//! - 429 responses return `LlmError::RateLimited { retry_after_s }` so the
//!   caller can invoke [`super::retry::with_backoff`] (pitfall #8).
//! - 401/403 collapse to `LlmError::AuthFailed`; other non-2xx statuses
//!   become `LlmError::Provider(status + truncated body)` (body capped at
//!   256 chars per threat register T-03-04-06).

use std::collections::HashMap;
use std::time::Duration;

use eventsource_stream::Eventsource;
use futures_util::StreamExt;
use reqwest::header::CONTENT_TYPE;
use reqwest::{Client, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::mpsc;
use tracing::{instrument, warn};

use super::{EventOutcome, LlmError, LlmEvent, LlmProvider, LlmRequest};
use crate::secrets::Redacted;

pub const ANTHROPIC_URL: &str = "https://api.anthropic.com/v1/messages";
pub const ANTHROPIC_VERSION: &str = "2023-06-01";
pub const ANTHROPIC_PROMPT_CACHING_BETA: &str = "prompt-caching-2024-07-31";

// ---- Outgoing request shape ------------------------------------------------

#[derive(Serialize, Debug)]
pub(crate) struct AnthropicRequest {
    pub model: String,
    pub max_tokens: u32,
    pub stream: bool,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub system: Vec<Value>,
    pub messages: Vec<Value>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub tools: Vec<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_choice: Option<Value>,
    pub temperature: f32,
}

/// Build the JSON body the Anthropic Messages API expects.
///
/// Copies model/max_tokens/messages/tools/tool_choice/temperature from
/// `LlmRequest` and attaches `cache_control: {type: "ephemeral", ttl: "1h"}`
/// to the LAST system block (pitfall #5). If the last block is already a
/// JSON object, the key is inserted; if it is a bare string (shorthand
/// "text"), it is wrapped into an object first.
pub(crate) fn build_anthropic_request(req: &LlmRequest) -> AnthropicRequest {
    let mut system = req.system_blocks.clone();
    if let Some(last) = system.last_mut() {
        attach_cache_control(last);
    }
    AnthropicRequest {
        model: req.model.clone(),
        max_tokens: req.max_tokens,
        stream: true,
        system,
        messages: req.messages.clone(),
        tools: req.tools.clone(),
        tool_choice: req.tool_choice.clone(),
        temperature: req.temperature,
    }
}

fn attach_cache_control(block: &mut Value) {
    let cache = serde_json::json!({ "type": "ephemeral", "ttl": "1h" });
    match block {
        Value::Object(map) => {
            map.insert("cache_control".to_string(), cache);
        }
        Value::String(s) => {
            *block = serde_json::json!({
                "type": "text",
                "text": s,
                "cache_control": cache,
            });
        }
        _ => {
            // Non-object, non-string system block is unexpected; wrap as-is
            // into a text block with the original value stringified.
            let text = block.to_string();
            *block = serde_json::json!({
                "type": "text",
                "text": text,
                "cache_control": cache,
            });
        }
    }
}

// ---- Incoming SSE event shape ---------------------------------------------

#[derive(Deserialize, Debug)]
#[serde(tag = "type")]
#[allow(dead_code)] // fields consumed by serde; some left for future use
pub(crate) enum SseEvent {
    #[serde(rename = "message_start")]
    MessageStart { message: Value },
    #[serde(rename = "content_block_start")]
    ContentBlockStart { index: u32, content_block: Value },
    #[serde(rename = "content_block_delta")]
    ContentBlockDelta { index: u32, delta: Delta },
    #[serde(rename = "content_block_stop")]
    ContentBlockStop { index: u32 },
    #[serde(rename = "message_delta")]
    MessageDelta {
        #[serde(default)]
        delta: Value,
        #[serde(default)]
        usage: Value,
    },
    #[serde(rename = "message_stop")]
    MessageStop,
    #[serde(rename = "ping")]
    Ping,
    #[serde(rename = "error")]
    Error { error: Value },
}

#[derive(Deserialize, Debug)]
#[serde(tag = "type")]
pub(crate) enum Delta {
    #[serde(rename = "text_delta")]
    Text { text: String },
    #[serde(rename = "input_json_delta")]
    InputJson { partial_json: String },
}

// ---- Provider --------------------------------------------------------------

/// Anthropic Messages API streaming provider.
pub struct AnthropicProvider {
    http: Client,
    api_key: Redacted<String>,
    base_url: String,
}

impl AnthropicProvider {
    pub fn new(api_key: String) -> Self {
        Self::with_base_url(api_key, ANTHROPIC_URL.to_string())
    }

    /// Constructor exposing a custom base URL (e.g. a wiremock server in
    /// tests). Production callers should use [`Self::new`].
    pub fn with_base_url(api_key: String, base_url: String) -> Self {
        let http = Client::builder()
            .timeout(Duration::from_secs(120)) // DoS cap
            .pool_idle_timeout(Duration::from_secs(90))
            .pool_max_idle_per_host(8)
            .build()
            .expect("reqwest client");
        Self {
            http,
            api_key: Redacted::new(api_key),
            base_url,
        }
    }

    /// Constructor accepting a pre-built [`Client`] for connection pool reuse
    /// across providers. The caller is responsible for configuring timeouts.
    pub fn with_client(client: Client, api_key: String) -> Self {
        Self {
            http: client,
            api_key: Redacted::new(api_key),
            base_url: ANTHROPIC_URL.to_string(),
        }
    }
}

#[async_trait::async_trait]
impl LlmProvider for AnthropicProvider {
    #[instrument(skip_all, fields(model = %req.model))]
    async fn stream(&self, req: LlmRequest, tx: mpsc::Sender<LlmEvent>) -> Result<(), LlmError> {
        let body = build_anthropic_request(&req);

        let resp = self
            .http
            .post(&self.base_url)
            .header("x-api-key", self.api_key.expose())
            .header("anthropic-version", ANTHROPIC_VERSION)
            .header("anthropic-beta", ANTHROPIC_PROMPT_CACHING_BETA)
            .header(CONTENT_TYPE, "application/json")
            .json(&body)
            .send()
            .await?;

        let status = resp.status();
        if !status.is_success() {
            return Err(classify_http_error(status, resp).await);
        }

        let mut tool_json_bufs: HashMap<u32, String> = HashMap::new();
        let mut sse = resp.bytes_stream().eventsource();

        while let Some(event) = sse.next().await {
            let event = event.map_err(|e| LlmError::Sse(e.to_string()))?;
            match process_event(&event.data, &mut tool_json_bufs, &tx).await? {
                EventOutcome::Continue => {}
                EventOutcome::Stop => break,
            }
        }
        Ok(())
    }
}

/// Parse a single SSE `data` payload and emit the corresponding
/// `LlmEvent`s on `tx`. Extracted so tests can drive the parser directly
/// from fixture bytes without HTTP mocking.
pub async fn process_event(
    data: &str,
    tool_json_bufs: &mut HashMap<u32, String>,
    tx: &mpsc::Sender<LlmEvent>,
) -> Result<EventOutcome, LlmError> {
    let parsed: SseEvent = match serde_json::from_str(data) {
        Ok(v) => v,
        Err(e) => {
            warn!(?e, "unknown SSE event shape");
            return Err(LlmError::SchemaDrift);
        }
    };

    match parsed {
        SseEvent::ContentBlockDelta {
            index: _,
            delta: Delta::Text { text },
        } => {
            let _ = tx.send(LlmEvent::TextDelta(text)).await;
        }
        SseEvent::ContentBlockDelta {
            index,
            delta: Delta::InputJson { partial_json },
        } => {
            tool_json_bufs
                .entry(index)
                .or_default()
                .push_str(&partial_json);
        }
        SseEvent::ContentBlockStop { index } => {
            if let Some(buf) = tool_json_bufs.remove(&index) {
                if !buf.is_empty() {
                    let value: Value = serde_json::from_str(&buf).map_err(|_| {
                        // do NOT echo buf contents (may hold PII).
                        LlmError::PartialJsonInvalid
                    })?;
                    let _ = tx
                        .send(LlmEvent::ToolUseComplete {
                            index,
                            input: value,
                        })
                        .await;
                }
            }
        }
        SseEvent::MessageDelta { usage, .. } => {
            if let Some(u) = parse_usage(&usage) {
                let _ = tx.send(u).await;
            }
        }
        SseEvent::MessageStop => return Ok(EventOutcome::Stop),
        SseEvent::Error { error } => {
            return Err(LlmError::Provider(error.to_string()));
        }
        SseEvent::MessageStart { .. } | SseEvent::ContentBlockStart { .. } | SseEvent::Ping => {
            // bookkeeping — nothing to forward
        }
    }
    Ok(EventOutcome::Continue)
}

fn parse_usage(usage: &Value) -> Option<LlmEvent> {
    let obj = usage.as_object()?;
    let u32_field = |k: &str| -> u32 { obj.get(k).and_then(|v| v.as_u64()).unwrap_or(0) as u32 };
    // Only emit if at least one field is present (message_delta without
    // usage leaves this as an empty object).
    if obj.is_empty() {
        return None;
    }
    Some(LlmEvent::Usage {
        input: u32_field("input_tokens"),
        output: u32_field("output_tokens"),
        cache_read: u32_field("cache_read_input_tokens"),
        cache_write: u32_field("cache_creation_input_tokens"),
    })
}

async fn classify_http_error(status: StatusCode, resp: reqwest::Response) -> LlmError {
    let (is_retryable, detail, retry_after) = crate::http::classify_http_error(status, resp).await;
    if is_retryable {
        return LlmError::RateLimited {
            retry_after_s: retry_after.unwrap_or(1),
        };
    }
    if detail == "auth_failed" {
        return LlmError::AuthFailed;
    }
    LlmError::Provider(detail)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_request_attaches_cache_control_to_last_system_block() {
        let req = LlmRequest {
            model: "claude-sonnet-4-6".into(),
            system_blocks: vec![
                serde_json::json!({"type":"text","text":"first"}),
                serde_json::json!({"type":"text","text":"last"}),
            ],
            messages: vec![],
            tools: vec![],
            tool_choice: None,
            max_tokens: 1024,
            temperature: 0.2,
        };
        let built = build_anthropic_request(&req);
        assert!(built.stream);
        assert_eq!(built.system.len(), 2);
        assert!(built.system[0].get("cache_control").is_none());
        let cc = built.system[1]
            .get("cache_control")
            .expect("cache_control on last");
        assert_eq!(cc["type"], "ephemeral");
        assert_eq!(cc["ttl"], "1h");
    }

    #[test]
    fn attach_cache_control_wraps_bare_string_blocks() {
        let mut b = Value::String("hi".into());
        attach_cache_control(&mut b);
        assert_eq!(b["type"], "text");
        assert_eq!(b["text"], "hi");
        assert_eq!(b["cache_control"]["ttl"], "1h");
    }

    #[test]
    fn parse_usage_extracts_all_four_counters() {
        let u = serde_json::json!({
            "input_tokens": 10, "output_tokens": 25,
            "cache_read_input_tokens": 8, "cache_creation_input_tokens": 2
        });
        match parse_usage(&u).expect("usage") {
            LlmEvent::Usage {
                input,
                output,
                cache_read,
                cache_write,
            } => {
                assert_eq!((input, output, cache_read, cache_write), (10, 25, 8, 2));
            }
            other => panic!("expected Usage, got {:?}", other),
        }
    }

    #[test]
    fn parse_usage_empty_object_returns_none() {
        let u = serde_json::json!({});
        assert!(parse_usage(&u).is_none());
    }
}
