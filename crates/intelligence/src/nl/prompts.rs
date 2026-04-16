//! System prompt construction for the NL-to-DSL pipeline.
//!
//! The system block is designed to be cached for 1 hour (Anthropic prompt
//! caching) and contains the pest grammar, verb catalog, style guide, and
//! few-shot examples. It is byte-identical across invocations (pitfall #4).

/// Role prompt establishing the LLM's identity and constraints (G3 clamp).
const ROLE_PROMPT: &str = "\
You are StoryCapture's DSL translator. Your ONLY job is to convert natural-language \
descriptions of UI workflows into valid StoryCapture DSL. You MUST call the \
`emit_story_doc` tool with every response. Never output raw DSL text outside the tool call. \
Never output markdown, explanations, or commentary instead of calling the tool. \
If the user's request is ambiguous, make reasonable assumptions and emit a valid document.";

/// Pest grammar embedded at compile time from the story-parser crate.
const GRAMMAR_PEST: &str = include_str!("../../../story-parser/src/grammar.pest");

/// Verb catalog in Markdown table format.
const VERB_CATALOG_MD: &str = "\
| Verb | Args | Description |
|------|------|-------------|
| navigate | url: string | Navigate to a URL |
| click | target: selector/text/testid/aria | Click an element |
| type | target: selector/text/testid/aria, text: string | Type text into a field |
| wait | duration_ms: number | Wait for a duration |
| wait-for | target: selector/text/testid/aria, timeout_ms?: number | Wait for element to appear |
| assert | target: selector/text/testid/aria | Assert element exists |
| hover | target: selector/text/testid/aria | Hover over an element |
| scroll | direction: up/down/left/right, amount?: number | Scroll the page |
| upload | target: selector/text/testid/aria, path: string | Upload a file |
| drag | from: target, to: target | Drag from one element to another |
| select | target: selector/text/testid/aria, value: string | Select from a dropdown |
| screenshot | name: string | Take a screenshot |
| pause | (none) | Pause execution |";

/// DSL writing conventions and style guide.
const STYLE_GUIDE_MD: &str = "\
## DSL Style Guide

1. **Selector preference order:** text > aria > testid > selector (CSS selectors are fragile).
2. **Every story must have at least one scene block.**
3. **Use descriptive step labels** that explain user intent, not technical actions.
4. **Narration is optional** but recommended for demo videos.
5. **Step IDs must be unique** within a document (use s1, s2, s3... pattern).
6. **Keep steps atomic** -- one user action per step.
7. **Use wait-for instead of wait** when waiting for dynamic content.";

/// Few-shot examples: (english prompt, DSL output) pairs.
const FEW_SHOTS: &[(&str, &str)] = &[
    (
        "Login to the app and check the dashboard",
        r##"story "Login Flow" {
  scene "Login" {
    navigate "https://app.example.com/login"
    type selector "#email" "user@example.com"
    type selector "#password" "password123"
    click "Sign in"
    wait-for "Dashboard"
  }
}"##,
    ),
    (
        "Sign up with a new account",
        r##"story "Signup Flow" {
  scene "Registration" {
    navigate "https://app.example.com/signup"
    type selector "#name" "Jane Doe"
    type selector "#email" "jane@example.com"
    type selector "#password" "securePass1!"
    click "Create Account"
    wait-for "Welcome"
  }
}"##,
    ),
    (
        "Upload a profile picture and save settings",
        r##"story "Profile Update" {
  scene "Settings" {
    navigate "https://app.example.com/settings"
    click "Profile"
    upload selector "#avatar-input" "/tmp/photo.png"
    click "Save Changes"
    wait-for "Settings saved"
  }
}"##,
    ),
];

/// Render the few-shot examples as a formatted string for inclusion in the system prompt.
fn render_few_shots() -> String {
    let mut out = String::new();
    for (i, (prompt, dsl)) in FEW_SHOTS.iter().enumerate() {
        out.push_str(&format!(
            "### Example {}\n**User:** \"{prompt}\"\n**DSL:**\n```\n{dsl}\n```\n\n",
            i + 1
        ));
    }
    out
}

/// Build the system prompt blocks for the NL-to-DSL pipeline.
///
/// Returns a single cached block containing the role prompt, pest grammar,
/// verb catalog, style guide, and few-shot examples. The block includes
/// `cache_control` with 1h TTL for Anthropic prompt caching (pitfall #5).
///
/// This function is deterministic: no timestamps, no dynamic data (pitfall #4).
pub fn build_system_blocks() -> Vec<serde_json::Value> {
    let text = format!(
        "{ROLE_PROMPT}\n\n# pest grammar\n```\n{GRAMMAR_PEST}\n```\n\n# verb catalog\n{VERB_CATALOG_MD}\n\n# style guide\n{STYLE_GUIDE_MD}\n\n# examples\n{}",
        render_few_shots()
    );
    vec![serde_json::json!({
        "type": "text",
        "text": text,
        "cache_control": { "type": "ephemeral", "ttl": "1h" }
    })]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_system_blocks_has_cache_control_with_1h_ttl() {
        let blocks = build_system_blocks();
        assert_eq!(blocks.len(), 1);
        let block = &blocks[0];
        let cc = &block["cache_control"];
        assert_eq!(cc["type"], "ephemeral");
        assert_eq!(cc["ttl"], "1h");
    }

    #[test]
    fn build_system_blocks_contains_required_sections() {
        let blocks = build_system_blocks();
        let text = blocks[0]["text"].as_str().unwrap();
        assert!(text.contains("pest grammar"), "should contain pest grammar section");
        assert!(text.contains("verb catalog"), "should contain verb catalog section");
        assert!(text.contains("style guide"), "should contain style guide section");
        // At least 3 few-shot examples
        assert!(text.contains("Example 1"), "should have example 1");
        assert!(text.contains("Example 2"), "should have example 2");
        assert!(text.contains("Example 3"), "should have example 3");
    }

    #[test]
    fn build_system_blocks_is_byte_identical_across_calls() {
        let a = build_system_blocks();
        let b = build_system_blocks();
        assert_eq!(a, b, "system blocks must be deterministic (pitfall #4)");
    }
}
