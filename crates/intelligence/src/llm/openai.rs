//! OpenAI Chat Completions API provider — streaming SSE implementation.
//!
//! Parallel to [`super::anthropic`] but with OpenAI's wire format:
//!
//! - SSE envelope is `data: <ChatCompletionChunk>\n\n` with a literal
//!   `[DONE]` sentinel to terminate the stream (not a typed event).
//! - Tool-call `arguments` are streamed as concatenated string fragments keyed
//!   by `choices[0].delta.tool_calls[].index`. Flush on `finish_reason ==
//!   "tool_calls"`.
//! - Structured output uses `response_format: { type: "json_schema",
//!   json_schema: { name, schema, strict: true } }` (set by caller via
//!   `LlmRequest::tool_choice` passthrough — see `build_openai_request`).
//! - `stream_options: { include_usage: true }` causes the final chunk to
//!   carry a top-level `usage` object; we forward as `LlmEvent::Usage`.
//! - 429 returns `LlmError::RateLimited { retry_after_s }`; 401/403 →
//!   `LlmError::AuthFailed`; other non-2xx → `LlmError::Provider` with a
//!   body truncated to 256 chars (threat register T-03-05-01..04 mirror of
//!   T-03-04-06).

use std::collections::HashMap;
use std::time::Duration;

use eventsource_stream::Eventsource;
use futures_util::StreamExt;
use reqwest::header::{AUTHORIZATION, CONTENT_TYPE};
use reqwest::{Client, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::mpsc;
use tracing::{instrument, warn};

use super::{EventOutcome, LlmError, LlmEvent, LlmProvider, LlmRequest};
use crate::secrets::Redacted;

pub const OPENAI_URL: &str = "https://api.openai.com/v1/chat/completions";
/// Literal `[DONE]` sentinel OpenAI emits to terminate the stream.
const DONE_SENTINEL: &str = "[DONE]";

// ---- Outgoing request shape ------------------------------------------------

#[derive(Serialize, Debug)]
pub(crate) struct OpenAiRequest {
    pub model: String,
    pub stream: bool,
    pub messages: Vec<Value>,
    pub max_tokens: u32,
    pub temperature: f32,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub tools: Vec<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_choice: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub response_format: Option<Value>,
    pub stream_options: StreamOptions,
}

#[derive(Serialize, Debug)]
pub(crate) struct StreamOptions {
    pub include_usage: bool,
}

/// Build the JSON body the OpenAI Chat Completions endpoint expects.
///
/// OpenAI has no system-block concept (systems are just messages with
/// `role:"system"`), so we prepend the `LlmRequest::system_blocks` to
/// `messages`. Each system block that is a bare string becomes
/// `{"role":"system","content":"..."}`; object blocks with a `text` field
/// extract that text; anything else is stringified defensively.
///
/// `response_format` is passed through when the caller has placed a
/// `{"type":"json_schema", ...}` value in `LlmRequest::tool_choice` under
/// the key `"response_format"`. To keep the trait surface identical to
/// Anthropic, we use a lightweight convention: if `tool_choice` looks like
/// `{"response_format": {...}}` we lift it into the top-level field; any
/// other shape is forwarded verbatim as OpenAI `tool_choice`.
pub(crate) fn build_openai_request(req: &LlmRequest) -> OpenAiRequest {
    let mut messages: Vec<Value> = req
        .system_blocks
        .iter()
        .map(system_block_to_message)
        .collect();
    messages.extend(req.messages.iter().cloned());

    let (response_format, tool_choice) = match &req.tool_choice {
        Some(Value::Object(m)) if m.contains_key("response_format") => {
            (m.get("response_format").cloned(), None)
        }
        other => (None, other.clone()),
    };

    OpenAiRequest {
        model: req.model.clone(),
        stream: true,
        messages,
        max_tokens: req.max_tokens,
        temperature: req.temperature,
        tools: req.tools.clone(),
        tool_choice,
        response_format,
        stream_options: StreamOptions { include_usage: true },
    }
}

fn system_block_to_message(block: &Value) -> Value {
    let content = match block {
        Value::String(s) => s.clone(),
        Value::Object(map) => map
            .get("text")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| block.to_string()),
        other => other.to_string(),
    };
    serde_json::json!({ "role": "system", "content": content })
}

// ---- Incoming SSE chunk shape ---------------------------------------------

#[derive(Deserialize, Debug)]
#[allow(dead_code)]
pub(crate) struct ChatChunk {
    #[serde(default)]
    pub choices: Vec<Choice>,
    #[serde(default)]
    pub usage: Option<Usage>,
}

#[derive(Deserialize, Debug)]
#[allow(dead_code)]
pub(crate) struct Choice {
    #[serde(default)]
    pub index: u32,
    #[serde(default)]
    pub delta: Delta,
    #[serde(default)]
    pub finish_reason: Option<String>,
}

#[derive(Deserialize, Debug, Default)]
#[allow(dead_code)]
pub(crate) struct Delta {
    #[serde(default)]
    pub content: Option<String>,
    #[serde(default)]
    pub tool_calls: Option<Vec<ToolCallDelta>>,
}

#[derive(Deserialize, Debug)]
#[allow(dead_code)]
pub(crate) struct ToolCallDelta {
    #[serde(default)]
    pub index: u32,
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub function: Option<FunctionDelta>,
}

#[derive(Deserialize, Debug, Default)]
#[allow(dead_code)]
pub(crate) struct FunctionDelta {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub arguments: Option<String>,
}

#[derive(Deserialize, Debug)]
#[allow(dead_code)]
pub(crate) struct Usage {
    #[serde(default)]
    pub prompt_tokens: u32,
    #[serde(default)]
    pub completion_tokens: u32,
    #[serde(default)]
    pub prompt_tokens_details: Option<PromptTokensDetails>,
}

#[derive(Deserialize, Debug, Default)]
#[allow(dead_code)]
pub(crate) struct PromptTokensDetails {
    #[serde(default)]
    pub cached_tokens: u32,
}

/// Per-tool-call accumulator entry: `(name, args_buffer)`.
pub type ToolCallAccumulator = HashMap<u32, (String, String)>;

// ---- Provider --------------------------------------------------------------

/// OpenAI Chat Completions streaming provider.
pub struct OpenAiProvider {
    http: Client,
    api_key: Redacted<String>,
    base_url: String,
}

impl OpenAiProvider {
    pub fn new(api_key: String) -> Self {
        Self::with_base_url(api_key, OPENAI_URL.to_string())
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
            base_url: OPENAI_URL.to_string(),
        }
    }
}

#[async_trait::async_trait]
impl LlmProvider for OpenAiProvider {
    #[instrument(skip_all, fields(model = %req.model))]
    async fn stream(
        &self,
        req: LlmRequest,
        tx: mpsc::Sender<LlmEvent>,
    ) -> Result<(), LlmError> {
        let body = build_openai_request(&req);

        let resp = self
            .http
            .post(&self.base_url)
            .header(
                AUTHORIZATION,
                format!("Bearer {}", self.api_key.expose()),
            )
            .header(CONTENT_TYPE, "application/json")
            .json(&body)
            .send()
            .await?;

        let status = resp.status();
        if !status.is_success() {
            return Err(classify_http_error(status, resp).await);
        }

        let mut tool_accum: ToolCallAccumulator = HashMap::new();
        let mut sse = resp.bytes_stream().eventsource();

        while let Some(event) = sse.next().await {
            let event = event.map_err(|e| LlmError::Sse(e.to_string()))?;
            match process_event(&event.data, &mut tool_accum, &tx).await? {
                EventOutcome::Continue => {}
                EventOutcome::Stop => break,
            }
        }
        Ok(())
    }
}

/// Parse a single SSE `data` payload (the raw string after `data: `) and
/// emit corresponding [`LlmEvent`]s on `tx`. Exposed so integration tests
/// can drive the parser directly from fixture bytes without HTTP.
///
/// The `[DONE]` sentinel is a literal byte-string compare: no
/// JSON parsing attempt, no substring match — the payload must equal
/// `"[DONE]"` verbatim.
pub async fn process_event(
    data: &str,
    tool_accum: &mut ToolCallAccumulator,
    tx: &mpsc::Sender<LlmEvent>,
) -> Result<EventOutcome, LlmError> {
    if data == DONE_SENTINEL {
        return Ok(EventOutcome::Stop);
    }

    let chunk: ChatChunk = match serde_json::from_str(data) {
        Ok(v) => v,
        Err(e) => {
            warn!(?e, "unknown OpenAI chunk shape");
            return Err(LlmError::SchemaDrift);
        }
    };

    // Drive the first choice only (n=1 by convention for streaming callers).
    if let Some(choice) = chunk.choices.into_iter().next() {
        if let Some(text) = choice.delta.content {
            if !text.is_empty() {
                let _ = tx.send(LlmEvent::TextDelta(text)).await;
            }
        }
        if let Some(deltas) = choice.delta.tool_calls {
            for tc in deltas {
                let entry = tool_accum.entry(tc.index).or_default();
                if let Some(func) = tc.function {
                    if let Some(name) = func.name {
                        if !name.is_empty() && entry.0.is_empty() {
                            entry.0 = name;
                        }
                    }
                    if let Some(args) = func.arguments {
                        entry.1.push_str(&args);
                    }
                }
            }
        }
        if let Some(reason) = choice.finish_reason {
            if reason == "tool_calls" {
                flush_tool_calls(tool_accum, tx).await?;
            }
        }
    }

    if let Some(usage) = chunk.usage {
        let cache_read = usage
            .prompt_tokens_details
            .as_ref()
            .map(|d| d.cached_tokens)
            .unwrap_or(0);
        let _ = tx
            .send(LlmEvent::Usage {
                input: usage.prompt_tokens,
                output: usage.completion_tokens,
                cache_read,
                cache_write: 0,
            })
            .await;
    }

    Ok(EventOutcome::Continue)
}

async fn flush_tool_calls(
    tool_accum: &mut ToolCallAccumulator,
    tx: &mpsc::Sender<LlmEvent>,
) -> Result<(), LlmError> {
    // Drain in index order for deterministic emission.
    let mut entries: Vec<(u32, (String, String))> = tool_accum.drain().collect();
    entries.sort_by_key(|(k, _)| *k);
    for (index, (_name, buf)) in entries {
        if buf.is_empty() {
            continue;
        }
        let value: Value = serde_json::from_str(&buf).map_err(|_| {
            // Do NOT echo buf contents (may hold PII / secrets).
            LlmError::PartialJsonInvalid
        })?;
        let _ = tx
            .send(LlmEvent::ToolUseComplete { index, input: value })
            .await;
    }
    Ok(())
}

async fn classify_http_error(status: StatusCode, resp: reqwest::Response) -> LlmError {
    let (is_retryable, detail, retry_after) =
        crate::http::classify_http_error(status, resp).await;
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
    fn build_request_promotes_response_format_from_tool_choice() {
        let schema = serde_json::json!({
            "type": "json_schema",
            "json_schema": { "name": "emit_story_doc", "schema": {}, "strict": true }
        });
        let req = LlmRequest {
            model: "gpt-4o-2024-11-20".into(),
            system_blocks: vec![serde_json::json!("you are a test")],
            messages: vec![serde_json::json!({"role":"user","content":"hi"})],
            tools: vec![],
            tool_choice: Some(serde_json::json!({ "response_format": schema.clone() })),
            max_tokens: 512,
            temperature: 0.2,
        };
        let built = build_openai_request(&req);
        assert!(built.stream);
        assert_eq!(built.stream_options.include_usage, true);
        assert_eq!(built.response_format, Some(schema));
        assert!(built.tool_choice.is_none());
        // system_blocks string was lifted to a role:system message.
        assert_eq!(built.messages[0]["role"], "system");
        assert_eq!(built.messages[0]["content"], "you are a test");
        assert_eq!(built.messages[1]["role"], "user");
    }

    #[test]
    fn system_block_from_object_extracts_text_field() {
        let b = serde_json::json!({"type":"text","text":"cached"});
        let m = system_block_to_message(&b);
        assert_eq!(m["role"], "system");
        assert_eq!(m["content"], "cached");
    }

    #[tokio::test]
    async fn openai_tool_call_accumulator_flushes_on_finish_reason() {
        let (tx, mut rx) = mpsc::channel(16);
        let mut accum: ToolCallAccumulator = HashMap::new();

        // Chunk 1: opens tool call with name + empty args.
        let c1 = r#"{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_x","function":{"name":"emit_story_doc","arguments":""}}]},"finish_reason":null}]}"#;
        let _ = process_event(c1, &mut accum, &tx).await.unwrap();
        // Chunk 2: args fragment.
        let c2 = r#"{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"k\":1}"}}]},"finish_reason":null}]}"#;
        let _ = process_event(c2, &mut accum, &tx).await.unwrap();
        // Chunk 3: finish_reason = tool_calls → flush.
        let c3 = r#"{"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}"#;
        let _ = process_event(c3, &mut accum, &tx).await.unwrap();
        drop(tx);

        let mut got = Vec::new();
        while let Some(ev) = rx.recv().await {
            got.push(ev);
        }
        assert_eq!(got.len(), 1);
        match &got[0] {
            LlmEvent::ToolUseComplete { index, input } => {
                assert_eq!(*index, 0);
                assert_eq!(input["k"], 1);
            }
            other => panic!("expected ToolUseComplete, got {:?}", other),
        }
    }

    #[tokio::test]
    async fn done_sentinel_stops_stream() {
        let (tx, _rx) = mpsc::channel(4);
        let mut accum: ToolCallAccumulator = HashMap::new();
        let outcome = process_event("[DONE]", &mut accum, &tx).await.unwrap();
        assert!(matches!(outcome, EventOutcome::Stop));
    }
}
