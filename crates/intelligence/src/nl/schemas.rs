//! Structured output schemas for the NL-to-DSL pipeline.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// A complete `.story` document emitted by the LLM.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct StoryDoc {
    pub title: String,
    pub steps: Vec<StoryStep>,
}

/// A single step within a `StoryDoc`.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct StoryStep {
    /// Stable ID for per-step regen.
    pub id: String,
    /// One-line user-intent summary.
    pub label: String,
    /// DSL verb restricted to the verb catalog.
    pub verb: DslVerb,
    /// Verb-specific args.
    pub args: serde_json::Value,
    /// Optional inline narration for TTS.
    pub narration: Option<String>,
}

/// DSL verbs matching the Phase 1 grammar plus the `scene` marker.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DslVerb {
    Navigate,
    Click,
    Type,
    Wait,
    WaitFor,
    Assert,
    Hover,
    Scroll,
    Upload,
    Drag,
    Select,
    Screenshot,
    Pause,
    PressKey,
    Scene,
}

/// Returns the tool definition JSON for `emit_story_doc`.
pub fn emit_story_doc_tool() -> serde_json::Value {
    let schema = schemars::schema_for!(StoryDoc);
    serde_json::json!({
        "name": "emit_story_doc",
        "description": "Emit the updated .story document. Output MUST parse with the StoryCapture pest grammar. Do not include unknown verbs.",
        "input_schema": schema
    })
}

impl StoryDoc {
    /// Render this doc as `.story` DSL text.
    pub fn render_dsl(&self) -> String {
        let mut out = String::new();
        out.push_str(&format!("story \"{}\" {{\n", self.title));
        out.push_str("  scene \"main\" {\n");
        for step in &self.steps {
            let line = render_step(step);
            out.push_str(&format!("    {line}\n"));
        }
        out.push_str("  }\n");
        out.push_str("}\n");
        out
    }

    /// Validate the rendered DSL with `story_parser`.
    pub fn validate_with_pest(&self) -> Result<(), String> {
        let text = self.render_dsl();
        let result = story_parser::parse(&text);
        if result
            .diagnostics
            .iter()
            .any(|d| d.severity == story_parser::Severity::Error)
        {
            let errors: Vec<String> = result
                .diagnostics
                .iter()
                .filter(|d| d.severity == story_parser::Severity::Error)
                .map(|d| d.message.clone())
                .collect();
            Err(format!("pest parse errors: {}", errors.join("; ")))
        } else {
            Ok(())
        }
    }
}

/// Render a single step as a DSL command line.
fn render_step(step: &StoryStep) -> String {
    match step.verb {
        DslVerb::Navigate => {
            let url = step
                .args
                .get("url")
                .and_then(|v| v.as_str())
                .unwrap_or("\"\"");
            format!("navigate \"{}\"", url)
        }
        DslVerb::Click => {
            let target = render_target(&step.args);
            format!("click {target}")
        }
        DslVerb::Type => {
            let target = render_target(&step.args);
            let text = step.args.get("text").and_then(|v| v.as_str()).unwrap_or("");
            format!("type {target} \"{text}\"")
        }
        DslVerb::Wait => {
            let ms = step
                .args
                .get("duration_ms")
                .and_then(|v| v.as_u64())
                .unwrap_or(1000);
            format!("wait {ms}ms")
        }
        DslVerb::WaitFor => {
            let target = render_target(&step.args);
            format!("wait-for {target}")
        }
        DslVerb::Assert => {
            let target = render_target(&step.args);
            format!("assert {target}")
        }
        DslVerb::Hover => {
            let target = render_target(&step.args);
            format!("hover {target}")
        }
        DslVerb::Scroll => {
            let dir = step
                .args
                .get("direction")
                .and_then(|v| v.as_str())
                .unwrap_or("down");
            format!("scroll {dir}")
        }
        DslVerb::Upload => {
            let target = render_target(&step.args);
            let path = step.args.get("path").and_then(|v| v.as_str()).unwrap_or("");
            format!("upload {target} \"{path}\"")
        }
        DslVerb::Drag => {
            let from = render_target_field(&step.args, "from");
            let to = render_target_field(&step.args, "to");
            format!("drag {from} to {to}")
        }
        DslVerb::Select => {
            let target = render_target(&step.args);
            let value = step
                .args
                .get("value")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            format!("select {target} \"{value}\"")
        }
        DslVerb::Screenshot => {
            let name = step
                .args
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("shot");
            format!("screenshot \"{name}\"")
        }
        DslVerb::Pause => "pause".to_string(),
        DslVerb::PressKey => {
            // Not in Phase 1 grammar yet, so render as a comment.
            let key = step
                .args
                .get("key")
                .and_then(|v| v.as_str())
                .unwrap_or("Enter");
            format!("# press_key \"{key}\"")
        }
        DslVerb::Scene => {
            // Scene is structural, so skip rendering.
            String::new()
        }
    }
}

/// Public wrapper around `render_step` for the diff engine.
pub fn render_step_text(step: &StoryStep) -> String {
    render_step(step)
}

/// Render a target from step args.
fn render_target(args: &serde_json::Value) -> String {
    if let Some(sel) = args.get("selector").and_then(|v| v.as_str()) {
        format!("selector \"{sel}\"")
    } else if let Some(tid) = args.get("testid").and_then(|v| v.as_str()) {
        format!("testid \"{tid}\"")
    } else if let Some(aria) = args.get("aria").and_then(|v| v.as_str()) {
        format!("aria \"{aria}\"")
    } else if let Some(text) = args.get("text").and_then(|v| v.as_str()) {
        // For `type`, `text` is the typed text, not the target.
        format!("\"{text}\"")
    } else if let Some(target) = args.get("target").and_then(|v| v.as_str()) {
        format!("\"{target}\"")
    } else {
        "\"unknown\"".to_string()
    }
}

/// Render a target from a named field in the args object.
fn render_target_field(args: &serde_json::Value, field: &str) -> String {
    if let Some(obj) = args.get(field) {
        if let Some(sel) = obj.get("selector").and_then(|v| v.as_str()) {
            return format!("selector \"{sel}\"");
        }
        if let Some(tid) = obj.get("testid").and_then(|v| v.as_str()) {
            return format!("testid \"{tid}\"");
        }
        if let Some(text) = obj.as_str() {
            return format!("\"{text}\"");
        }
    }
    "\"unknown\"".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schema_for_story_doc_has_steps_array_and_verb_enum() {
        let schema = schemars::schema_for!(StoryDoc);
        let json = serde_json::to_value(&schema).unwrap();

        // `steps` should be an array.
        let steps_schema = &json["definitions"]["StoryStep"];
        assert!(
            steps_schema.is_object(),
            "StoryStep definition should exist"
        );

        // `verb` should be an enum.
        let verb_schema = &json["definitions"]["DslVerb"];
        assert!(verb_schema.is_object(), "DslVerb definition should exist");
        // Check it has `oneOf` or `enum`.
        let has_enum = verb_schema.get("enum").is_some() || verb_schema.get("oneOf").is_some();
        assert!(has_enum, "DslVerb should be an enum in JSON Schema");
    }

    #[test]
    fn emit_story_doc_tool_returns_correct_shape() {
        let tool = emit_story_doc_tool();
        assert_eq!(tool["name"], "emit_story_doc");
        assert!(
            tool.get("input_schema").is_some(),
            "should have input_schema"
        );
        assert!(tool.get("description").is_some(), "should have description");
    }
}
