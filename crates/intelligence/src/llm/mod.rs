//! LLM provider trait + associated request/event/error types.
//!
//! This module defines the contract surface that downstream Phase-3 waves
//! (Anthropic / OpenAI structured-output providers, orchestrator) implement
//! against. See AI-SPEC §3 "Key Abstractions" and §4 "Model Configuration".

use thiserror::Error;

pub mod anthropic;
pub mod openai;
pub mod retry;

/// Default model identifier for NL-to-DSL and narration generation.
pub const DEFAULT_NL_MODEL: &str = "claude-sonnet-4-6";

/// Request payload fed into an [`LlmProvider::stream`] call.
///
/// Shape matches the Anthropic Messages API surface (system_blocks for
/// prompt-cache breakpoints, tools for structured output). OpenAI providers
/// translate internally.
#[derive(Debug, Clone)]
pub struct LlmRequest {
    pub model: String,
    /// System prompt as a list of content blocks — allows providers to mark
    /// cache breakpoints (Anthropic `cache_control`).
    pub system_blocks: Vec<serde_json::Value>,
    /// User + assistant message history.
    pub messages: Vec<serde_json::Value>,
    /// Tool definitions (e.g. `emit_story_doc`).
    pub tools: Vec<serde_json::Value>,
    /// Optional forced tool choice.
    pub tool_choice: Option<serde_json::Value>,
    pub max_tokens: u32,
    pub temperature: f32,
}

/// Streaming event emitted through the mpsc channel passed to
/// [`LlmProvider::stream`]. Ordering is preserved.
#[derive(Debug, Clone)]
pub enum LlmEvent {
    /// Incremental text delta (non-tool completion).
    TextDelta(String),
    /// A complete tool-call payload with parsed arguments.
    ToolUseComplete {
        index: u32,
        input: serde_json::Value,
    },
    /// Token usage breakdown emitted on stream completion.
    Usage {
        input: u32,
        output: u32,
        cache_read: u32,
        cache_write: u32,
    },
}

/// Error taxonomy returned by any [`LlmProvider`] implementation.
#[derive(Debug, Error)]
pub enum LlmError {
    #[error("HTTP transport error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("SSE parse error: {0}")]
    Sse(String),
    #[error("schema drift — provider response did not match tool schema")]
    SchemaDrift,
    #[error("partial JSON invalid — streaming tool call truncated")]
    PartialJsonInvalid,
    #[error("no tool call emitted — structured output expected but missing")]
    NoToolCall,
    #[error("structured output error: {0}")]
    StructuredOutput(String),
    #[error("provider error: {0}")]
    Provider(String),
    #[error("rate limited — retry after {retry_after_s}s")]
    RateLimited { retry_after_s: u64 },
    #[error("authentication failed")]
    AuthFailed,
}

/// Streaming LLM provider abstraction.
///
/// Implementations push [`LlmEvent`]s into `tx` as they arrive over the wire
/// and resolve the returned future only once the stream terminates (either
/// successfully or with an [`LlmError`]).
#[async_trait::async_trait]
pub trait LlmProvider: Send + Sync {
    async fn stream(
        &self,
        req: LlmRequest,
        tx: tokio::sync::mpsc::Sender<LlmEvent>,
    ) -> Result<(), LlmError>;
}

/// Outcome of processing a single SSE event during streaming.
///
/// Used by both Anthropic and OpenAI provider `process_event` functions.
pub enum EventOutcome {
    Continue,
    Stop,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_error_bounds<T: std::error::Error + Send + Sync + 'static>() {}

    #[test]
    fn llm_error_is_send_sync_static() {
        assert_error_bounds::<LlmError>();
    }

    /// Compile-time object-safety check: `LlmProvider` must be usable as
    /// `Box<dyn LlmProvider>` so the orchestrator can hold a trait object.
    #[test]
    fn llm_provider_is_object_safe() {
        fn _takes_box(_p: Box<dyn LlmProvider>) {}
        // Not invoked — type-check only.
        let _ = _takes_box;
    }
}
