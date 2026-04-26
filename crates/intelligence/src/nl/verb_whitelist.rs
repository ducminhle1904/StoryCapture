//! G2 verb whitelist post-validation.
//!
//! The authoritative set of verbs comes from the `story_parser` grammar.
//! This module mirrors that set as a constant and provides a check
//! function that identifies steps with unknown verbs.

/// Authoritative verb whitelist matching the DSL grammar + "scene" block marker.
// TODO: Replace with story_parser::VERB_CATALOG when available.
pub const VERBS: &[&str] = &[
    "navigate",
    "click",
    "type",
    "wait",
    "wait_for",
    "assert",
    "hover",
    "scroll",
    "upload",
    "drag",
    "select",
    "screenshot",
    "pause",
    "press_key",
    "scene",
];

/// Check that all steps in the doc use only whitelisted verbs.
///
/// Returns a list of step IDs whose `verb` serialises to a value not in [`VERBS`].
/// An empty return means the doc is fully compliant.
pub fn check_verb_whitelist(doc: &super::schemas::StoryDoc) -> Vec<String> {
    doc.steps
        .iter()
        .filter_map(|s| {
            let v = serde_json::to_value(&s.verb).ok()?;
            let name = v.as_str()?.to_string();
            if VERBS.contains(&name.as_str()) {
                None
            } else {
                Some(s.id.clone())
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::nl::schemas::{DslVerb, StoryDoc, StoryStep};

    #[test]
    fn all_dsl_verb_variants_pass_whitelist() {
        let verbs = vec![
            DslVerb::Navigate,
            DslVerb::Click,
            DslVerb::Type,
            DslVerb::Wait,
            DslVerb::WaitFor,
            DslVerb::Assert,
            DslVerb::Hover,
            DslVerb::Scroll,
            DslVerb::Upload,
            DslVerb::Drag,
            DslVerb::Select,
            DslVerb::Screenshot,
            DslVerb::Pause,
            DslVerb::PressKey,
            DslVerb::Scene,
        ];

        for (i, verb) in verbs.into_iter().enumerate() {
            let doc = StoryDoc {
                title: "test".to_string(),
                steps: vec![StoryStep {
                    id: format!("s{i}"),
                    label: "test step".to_string(),
                    verb,
                    args: serde_json::json!({}),
                    narration: None,
                }],
            };
            let bad = check_verb_whitelist(&doc);
            assert!(
                bad.is_empty(),
                "verb at index {i} should pass whitelist, but failed: {:?}",
                bad
            );
        }
    }
}
