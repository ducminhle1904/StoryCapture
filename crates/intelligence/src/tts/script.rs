//! TTS auto-script generator.
//!
//! Uses an LLM to generate a short narration paragraph per DSL step.
//! Input: `StoryDoc` + optional brand-tone hint.
//! Output: `Vec<NarrationDraft>` with per-step text, word count, and cost estimate.
//!
//! The user reviews/edits narration text before committing to TTS synthesis
//! (Plan 11), avoiding wasted TTS tokens on poor scripts.

use std::collections::HashSet;
use std::sync::Arc;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;

use crate::error::IntelError;
use crate::llm::{LlmEvent, LlmProvider, LlmRequest};
use crate::nl::schemas::StoryDoc;

/// ElevenLabs eleven_multilingual_v2 pricing: $0.30 per 1K characters.
const ELEVENLABS_COST_PER_CHAR: f64 = 0.30 / 1000.0;

/// Maximum words per narration step (~20s spoken at 160 wpm).
const MAX_WORDS_PER_STEP: usize = 80;

/// Per-step max_tokens budget (AI-SPEC §4).
const MAX_TOKENS_PER_STEP: u32 = 256;

/// A single narration draft for one DSL step.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NarrationDraft {
    pub step_id: String,
    pub text: String,
    pub word_count: u32,
    pub cost_estimate_usd: f64,
}

/// Batch output schema for the `emit_narrations` tool.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct NarrationBatch {
    pub narrations: Vec<NarrationItem>,
}

/// A single narration item within the batch.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct NarrationItem {
    pub step_id: String,
    pub text: String,
}

/// Returns the tool definition JSON for the `emit_narrations` tool.
fn emit_narrations_tool() -> serde_json::Value {
    let schema = schemars::schema_for!(NarrationBatch);
    serde_json::json!({
        "name": "emit_narrations",
        "description": "Emit one narration paragraph per DSL step. Each narration must be <= 80 words and describe ONLY the action in that step.",
        "input_schema": schema
    })
}

/// Build the system prompt for narration generation.
fn build_system_prompt() -> String {
    "You are a technical narrator. Given DSL steps, emit ONE narration per step \
     via the `emit_narrations` tool. Rules:\n\
     - <= 80 words per narration (<= 20s spoken)\n\
     - Describe ONLY the action in that step; never invent UI elements or features not present\n\
     - Match the brand tone if provided\n\
     - Keep technical accuracy; pronounce CLI commands and brand names clearly\n\
     - Never reference steps out of order"
        .to_string()
}

/// Build the user message containing step context + brand tone.
fn build_user_message(story: &StoryDoc, brand_tone: Option<&str>) -> String {
    let mut msg = format!("Story: {}\n\nSteps:\n", story.title);
    for step in &story.steps {
        let verb = format!("{:?}", step.verb).to_lowercase();
        let args_str = serde_json::to_string(&step.args).unwrap_or_default();
        msg.push_str(&format!(
            "- id={}, verb={}, args={}, label={}\n",
            step.id, verb, args_str, step.label
        ));
    }
    msg.push_str(&format!(
        "\nBrand tone: {}",
        brand_tone.unwrap_or("neutral technical")
    ));
    msg
}

/// Generate narration scripts for each step in the story using an LLM.
///
/// Returns one `NarrationDraft` per step in `story.steps` order.
/// Unknown step_ids from the LLM are dropped; missing steps get a fallback
/// narration using the step label.
pub async fn generate_narration_script(
    provider: Arc<dyn LlmProvider>,
    story: &StoryDoc,
    brand_tone: Option<&str>,
) -> Result<Vec<NarrationDraft>, IntelError> {
    // Build the LLM request
    let system_prompt = build_system_prompt();
    let user_message = build_user_message(story, brand_tone);

    let max_tokens = MAX_TOKENS_PER_STEP.saturating_mul(story.steps.len() as u32).min(8192);

    let req = LlmRequest {
        model: crate::llm::DEFAULT_NL_MODEL.to_string(),
        system_blocks: vec![serde_json::json!({
            "type": "text",
            "text": system_prompt,
            "cache_control": {"type": "ephemeral"}
        })],
        messages: vec![serde_json::json!({
            "role": "user",
            "content": user_message,
        })],
        tools: vec![emit_narrations_tool()],
        tool_choice: Some(serde_json::json!({
            "type": "tool",
            "name": "emit_narrations"
        })),
        max_tokens,
        temperature: 0.4,
    };

    // Stream via provider; collect ToolUseComplete
    let (tx, mut rx) = mpsc::channel::<LlmEvent>(64);
    let provider_clone = provider.clone();
    let stream_task = tokio::spawn(async move { provider_clone.stream(req, tx).await });

    let mut tool_input: Option<serde_json::Value> = None;
    while let Some(ev) = rx.recv().await {
        if let LlmEvent::ToolUseComplete { input, .. } = ev {
            tool_input = Some(input);
        }
    }

    // Check stream task result
    match stream_task.await {
        Ok(Ok(())) => {}
        Ok(Err(e)) => return Err(IntelError::Llm(e)),
        Err(e) => {
            return Err(IntelError::Llm(crate::llm::LlmError::Provider(format!(
                "stream task panicked: {e}"
            ))))
        }
    }

    let value = tool_input.ok_or_else(|| {
        IntelError::Llm(crate::llm::LlmError::NoToolCall)
    })?;

    // Deserialize NarrationBatch
    let batch: NarrationBatch = serde_json::from_value(value)?;

    // Build a set of valid step IDs for filtering
    let valid_ids: HashSet<&str> = story.steps.iter().map(|s| s.id.as_str()).collect();

    // Index batch items by step_id, dropping unknown IDs
    let mut batch_map = std::collections::HashMap::new();
    for item in &batch.narrations {
        if valid_ids.contains(item.step_id.as_str()) {
            batch_map.insert(item.step_id.as_str(), item);
        } else {
            tracing::warn!(
                step_id = %item.step_id,
                "dropping narration for unknown step_id"
            );
        }
    }

    // Build drafts in story step order
    let mut drafts = Vec::with_capacity(story.steps.len());
    for step in &story.steps {
        let text = if let Some(item) = batch_map.get(step.id.as_str()) {
            item.text.clone()
        } else {
            // Fallback: use the step label as degraded narration
            tracing::warn!(
                step_id = %step.id,
                "no narration from LLM for step; using label as fallback"
            );
            step.label.clone()
        };

        // Truncate at 80 words at sentence boundary
        let truncated = truncate_at_sentence_boundary(&text, MAX_WORDS_PER_STEP);
        let word_count = truncated.split_whitespace().count() as u32;
        let cost_estimate_usd = truncated.chars().count() as f64 * ELEVENLABS_COST_PER_CHAR;

        // Faithfulness heuristic: check for content not in DSL
        check_faithfulness(&truncated, story, &step.id);

        drafts.push(NarrationDraft {
            step_id: step.id.clone(),
            text: truncated,
            word_count,
            cost_estimate_usd,
        });
    }

    Ok(drafts)
}

/// Truncate text at a sentence boundary so word count <= max_words.
///
/// If the text is already <= max_words, returns it unchanged.
/// Otherwise, finds the last sentence-ending punctuation (. ! ?) that keeps
/// the text within the word limit. If no sentence boundary fits, truncates
/// at the word boundary.
fn truncate_at_sentence_boundary(text: &str, max_words: usize) -> String {
    let words: Vec<&str> = text.split_whitespace().collect();
    if words.len() <= max_words {
        return text.to_string();
    }

    // Try to find a sentence boundary within the word limit
    let limited = words[..max_words].join(" ");

    // Find the last sentence-ending punctuation
    if let Some(pos) = limited.rfind(|c: char| c == '.' || c == '!' || c == '?') {
        let truncated = &limited[..=pos];
        if !truncated.trim().is_empty() {
            return truncated.trim().to_string();
        }
    }

    // No sentence boundary found; hard truncate at word limit
    limited
}

/// Simple faithfulness heuristic: log a warning if the narration mentions
/// concepts not present in the story's steps.
///
/// This is a best-effort check -- it does NOT reject the narration.
/// The user reviews per-step text before committing to TTS synthesis.
fn check_faithfulness(narration: &str, story: &StoryDoc, step_id: &str) {
    let narration_lower = narration.to_lowercase();

    // Collect all known nouns/verbs from the story
    let mut known_terms: HashSet<String> = HashSet::new();
    for step in &story.steps {
        known_terms.insert(format!("{:?}", step.verb).to_lowercase());
        known_terms.insert(step.label.to_lowercase());
        // Extract string values from args
        if let Some(obj) = step.args.as_object() {
            for (_, v) in obj {
                if let Some(s) = v.as_str() {
                    for word in s.split_whitespace() {
                        known_terms.insert(word.to_lowercase());
                    }
                }
            }
        }
    }
    known_terms.insert(story.title.to_lowercase());

    // Check for suspicious terms that shouldn't appear
    // Simple heuristic: common feature-terms that would indicate hallucination
    let suspicious = [
        "pricing", "oauth", "2fa", "two-factor", "billing",
        "subscription", "payment", "checkout", "cart",
    ];

    for term in &suspicious {
        if narration_lower.contains(term) {
            // Check if the term appears anywhere in the story context
            let in_story = known_terms.iter().any(|k| k.contains(term));
            if !in_story {
                tracing::warn!(
                    step_id = %step_id,
                    term = %term,
                    "possible hallucination: narration mentions '{}' which is not in the DSL steps",
                    term
                );
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncate_short_text_unchanged() {
        let text = "This is a short sentence.";
        assert_eq!(truncate_at_sentence_boundary(text, 80), text);
    }

    #[test]
    fn truncate_at_sentence_boundary_works() {
        let text = "First sentence. Second sentence. Third sentence that is very long and should be cut off eventually somewhere around here.";
        let result = truncate_at_sentence_boundary(text, 10);
        assert!(result.split_whitespace().count() <= 10);
        assert!(result.ends_with('.'));
    }

    #[test]
    fn cost_estimate_constant_is_elevenlabs_rate() {
        // ElevenLabs: $0.30 per 1K chars
        assert!((ELEVENLABS_COST_PER_CHAR - 0.0003).abs() < 1e-10);
    }

    #[test]
    fn max_tokens_per_step_is_256() {
        assert_eq!(MAX_TOKENS_PER_STEP, 256);
    }
}
