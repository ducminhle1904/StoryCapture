//! NL-to-DSL orchestrator: runs an LLM turn with retry + validation + diff.

use std::sync::Arc;
use tokio::sync::mpsc;

use crate::llm::{LlmProvider, LlmRequest, LlmEvent, LlmError};
use super::schemas::StoryDoc;
use super::diff::StepDiff;

/// A single turn in the conversation history.
#[derive(Debug, Clone)]
pub struct ChatTurn {
    pub role: String,
    pub content: String,
}

/// Events emitted by the NL-to-DSL orchestrator through the mpsc channel.
#[derive(Debug, Clone)]
pub enum NlTurnEvent {
    /// Streamed assistant prose (chat panel).
    TextDelta(String),
    /// Structured DSL diff arrived.
    StoryDocReady { doc: StoryDoc, diff: Vec<StepDiff> },
    /// Cost / cache stats for the status-bar token counter.
    Usage { input: u32, output: u32, cache_read: u32, cache_write: u32 },
    /// Error message.
    Error(String),
    /// Turn complete.
    Done,
}

/// Run a single NL-to-DSL turn.
///
/// Stub -- will be fully implemented in Task 2.
pub async fn run_nl_turn(
    _provider: Arc<dyn LlmProvider>,
    _user_message: String,
    _current_story: String,
    _history: Vec<ChatTurn>,
    _tx: mpsc::Sender<NlTurnEvent>,
) -> Result<(), crate::error::IntelError> {
    // Will be implemented in Task 2
    Ok(())
}
