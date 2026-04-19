//! NL-to-DSL orchestrator with retry, validation, and diff generation.

use std::sync::Arc;
use tokio::sync::mpsc;

use super::diff::{compute_step_diff, StepDiff};
use super::prompts::build_system_blocks;
use super::schemas::{emit_story_doc_tool, StoryDoc};
use super::verb_whitelist::check_verb_whitelist;
use crate::llm::{LlmError, LlmEvent, LlmProvider, LlmRequest};

/// Maximum number of retries.
const MAX_RETRIES: u32 = 2;

/// A single turn in the conversation history.
#[derive(Debug, Clone)]
pub struct ChatTurn {
    pub role: String,
    pub content: String,
}

/// Events emitted by the NL-to-DSL orchestrator.
#[derive(Debug, Clone)]
pub enum NlTurnEvent {
    /// Streamed assistant prose.
    TextDelta(String),
    /// Structured DSL diff arrived.
    StoryDocReady { doc: StoryDoc, diff: Vec<StepDiff> },
    /// Cost and cache stats.
    Usage {
        input: u32,
        output: u32,
        cache_read: u32,
        cache_write: u32,
    },
    /// Error message.
    Error(String),
    /// Turn complete.
    Done,
}

impl LlmRequest {
    /// Build an NL-to-DSL request.
    pub fn nl_to_dsl(user_message: String, current_story: String, history: Vec<ChatTurn>) -> Self {
        let mut messages: Vec<serde_json::Value> = Vec::new();

        // Replay history.
        for turn in &history {
            messages.push(serde_json::json!({
                "role": turn.role,
                "content": turn.content,
            }));
        }

        // Current turn: current story + user message.
        let user_content = format!(
            "Current .story file:\n```\n{current_story}\n```\n\nUser request: {user_message}"
        );
        messages.push(serde_json::json!({
            "role": "user",
            "content": user_content,
        }));

        LlmRequest {
            model: crate::llm::DEFAULT_NL_MODEL.to_string(),
            system_blocks: build_system_blocks(),
            messages,
            tools: vec![emit_story_doc_tool()],
            tool_choice: Some(serde_json::json!({
                "type": "tool",
                "name": "emit_story_doc"
            })),
            max_tokens: 4096,
            temperature: 0.2,
        }
    }
}

/// Run a single NL-to-DSL turn with retry, validation, and diffing.
pub async fn run_nl_turn(
    provider: Arc<dyn LlmProvider>,
    user_message: String,
    current_story: String,
    history: Vec<ChatTurn>,
    out_tx: mpsc::Sender<NlTurnEvent>,
) -> Result<(), crate::error::IntelError> {
    let mut req = LlmRequest::nl_to_dsl(user_message, current_story.clone(), history);
    let mut last_err: Option<String> = None;

    for attempt in 0..=MAX_RETRIES {
        // Self-repair prompt on retry.
        if let Some(ref err) = last_err {
            let repair_msg = format!(
                "Your previous emit_story_doc call failed validation:\n\
                 {err}\n\n\
                 Re-emit the tool call. The output MUST satisfy the pest grammar \
                 and use only verbs from: {:?}",
                super::verb_whitelist::VERBS
            );
            req.messages.push(serde_json::json!({
                "role": "user",
                "content": repair_msg,
            }));
            tracing::warn!(attempt, error = %err, "structured output retry");
        }

        // Stream the LLM turn.
        let (tx, mut rx) = mpsc::channel::<LlmEvent>(64);
        let provider_clone = provider.clone();
        let req_clone = req.clone();
        let stream_task = tokio::spawn(async move { provider_clone.stream(req_clone, tx).await });

        // Collect events.
        let mut tool_input: Option<serde_json::Value> = None;
        while let Some(ev) = rx.recv().await {
            match ev {
                LlmEvent::TextDelta(t) => {
                    let _ = out_tx.send(NlTurnEvent::TextDelta(t)).await;
                }
                LlmEvent::ToolUseComplete { input, .. } => {
                    tool_input = Some(input);
                }
                LlmEvent::Usage {
                    input,
                    output,
                    cache_read,
                    cache_write,
                } => {
                    let _ = out_tx
                        .send(NlTurnEvent::Usage {
                            input,
                            output,
                            cache_read,
                            cache_write,
                        })
                        .await;
                }
            }
        }

        // Check the stream task result.
        match stream_task.await {
            Ok(Ok(())) => {}
            Ok(Err(e)) => {
                let _ = out_tx.send(NlTurnEvent::Error(e.to_string())).await;
                return Err(crate::error::IntelError::Llm(e));
            }
            Err(e) => {
                let msg = format!("stream task panicked: {e}");
                let _ = out_tx.send(NlTurnEvent::Error(msg.clone())).await;
                return Err(crate::error::IntelError::Llm(LlmError::Provider(msg)));
            }
        }

        // Extract and validate tool output.
        let value = match tool_input {
            Some(v) => v,
            None => {
                last_err = Some("No tool call emitted by the model".to_string());
                continue;
            }
        };

        // Gate 1: serde deserialization.
        let doc: StoryDoc = match serde_json::from_value(value) {
            Ok(d) => d,
            Err(e) => {
                last_err = Some(format!("JSON deserialization failed: {e}"));
                continue;
            }
        };

        // Gate 2: pest grammar validation.
        if let Err(e) = doc.validate_with_pest() {
            last_err = Some(format!("pest parse failed: {e}"));
            continue;
        }

        // Gate 3: verb whitelist.
        let bad_ids = check_verb_whitelist(&doc);
        if !bad_ids.is_empty() {
            last_err = Some(format!(
                "Unknown verbs in steps: {:?}. Only these verbs are allowed: {:?}",
                bad_ids,
                super::verb_whitelist::VERBS
            ));
            continue;
        }

        // All gates passed; compute diff and emit success.
        let diff = compute_step_diff(&current_story, &doc);
        let _ = out_tx.send(NlTurnEvent::StoryDocReady { doc, diff }).await;
        let _ = out_tx.send(NlTurnEvent::Done).await;
        return Ok(());
    }

    // Exhausted retries.
    let err_msg = last_err.unwrap_or_else(|| "unknown validation error".to_string());
    let _ = out_tx.send(NlTurnEvent::Error(err_msg.clone())).await;
    Err(crate::error::IntelError::Llm(LlmError::StructuredOutput(
        err_msg,
    )))
}
