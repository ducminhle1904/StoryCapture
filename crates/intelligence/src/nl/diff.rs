//! Per-step diff engine for comparing old .story text against a new StoryDoc.
//!
//! Steps are matched by stable `step_id`. The old text is scanned for
//! inline `# id: <id>` comments or matched by structural position.

use std::collections::HashMap;

use super::schemas::StoryDoc;

/// Classification of a step change.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StepDiffKind {
    Added,
    Removed,
    Modified,
    Unchanged,
}

/// A single step's diff entry.
#[derive(Debug, Clone)]
pub struct StepDiff {
    pub step_id: String,
    pub kind: StepDiffKind,
    pub old_text: Option<String>,
    pub new_text: Option<String>,
}

/// Extract step blocks from old `.story` text.
///
/// Looks for inline `# id: <id>` comments followed by a command line.
/// Falls back to structural position indexing (s1, s2, ...) if no id comments
/// are found.
fn extract_old_steps(old_text: &str) -> HashMap<String, String> {
    let mut steps = HashMap::new();
    let lines: Vec<&str> = old_text.lines().collect();

    // First pass: look for `# id: <id>` comment patterns
    let mut found_ids = false;
    let mut i = 0;
    while i < lines.len() {
        let trimmed = lines[i].trim();
        if let Some(rest) = trimmed.strip_prefix("# id:") {
            let id = rest.trim().to_string();
            if !id.is_empty() {
                found_ids = true;
                // The next non-empty, non-comment line is the command
                let mut cmd_text = String::new();
                let mut j = i + 1;
                while j < lines.len() {
                    let next = lines[j].trim();
                    if !next.is_empty() && !next.starts_with('#') {
                        cmd_text = next.to_string();
                        break;
                    }
                    j += 1;
                }
                steps.insert(id, cmd_text);
            }
        }
        i += 1;
    }

    if found_ids {
        return steps;
    }

    // Fallback: extract command lines by position and assign s1, s2, ...
    let mut idx = 0;
    for line in &lines {
        let trimmed = line.trim();
        // Skip empty lines, comments, structural keywords
        if trimmed.is_empty()
            || trimmed.starts_with('#')
            || trimmed.starts_with("story ")
            || trimmed.starts_with("scene ")
            || trimmed == "{"
            || trimmed == "}"
            || trimmed.starts_with("meta ")
        {
            continue;
        }
        // This looks like a command line
        idx += 1;
        let id = format!("s{idx}");
        steps.insert(id, trimmed.to_string());
    }

    steps
}

/// Compute per-step diff between old story text and a new StoryDoc.
///
/// Steps are matched by stable `step_id`. Old text is parsed to extract
/// step blocks by structural position or inline `# id: <id>` comments.
pub fn compute_step_diff(old_text: &str, new_doc: &StoryDoc) -> Vec<StepDiff> {
    let old_steps = extract_old_steps(old_text);
    let mut result = Vec::new();
    let mut seen_ids = std::collections::HashSet::new();

    // Process new doc steps: match against old
    for step in &new_doc.steps {
        seen_ids.insert(step.id.clone());
        let new_text = super::schemas::render_step_text(step);

        if let Some(old_cmd) = old_steps.get(&step.id) {
            // Normalise whitespace for comparison
            let old_norm = old_cmd.split_whitespace().collect::<Vec<_>>().join(" ");
            let new_norm = new_text.split_whitespace().collect::<Vec<_>>().join(" ");

            if old_norm == new_norm {
                result.push(StepDiff {
                    step_id: step.id.clone(),
                    kind: StepDiffKind::Unchanged,
                    old_text: Some(old_cmd.clone()),
                    new_text: Some(new_text),
                });
            } else {
                result.push(StepDiff {
                    step_id: step.id.clone(),
                    kind: StepDiffKind::Modified,
                    old_text: Some(old_cmd.clone()),
                    new_text: Some(new_text),
                });
            }
        } else {
            result.push(StepDiff {
                step_id: step.id.clone(),
                kind: StepDiffKind::Added,
                old_text: None,
                new_text: Some(new_text),
            });
        }
    }

    // Find removed steps (in old but not in new)
    let mut removed: Vec<_> = old_steps
        .iter()
        .filter(|(id, _)| !seen_ids.contains(*id))
        .collect();
    removed.sort_by_key(|(id, _)| (*id).clone());

    for (id, text) in removed {
        result.push(StepDiff {
            step_id: id.clone(),
            kind: StepDiffKind::Removed,
            old_text: Some(text.clone()),
            new_text: None,
        });
    }

    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::nl::schemas::{DslVerb, StoryStep};

    #[test]
    fn compute_diff_detects_unchanged_modified_added_removed() {
        let old_text = r##"# id: s1
navigate "https://example.com"
# id: s2
click "Login"
# id: s3
type selector "#email" "user@test.com"
"##;

        let new_doc = StoryDoc {
            title: "Test".to_string(),
            steps: vec![
                StoryStep {
                    id: "s1".to_string(),
                    label: "Go to site".to_string(),
                    verb: DslVerb::Navigate,
                    args: serde_json::json!({"url": "https://example.com"}),
                    narration: None,
                },
                StoryStep {
                    id: "s2".to_string(),
                    label: "Click signup".to_string(),
                    verb: DslVerb::Click,
                    args: serde_json::json!({"target": "Sign Up"}),
                    narration: None,
                },
                StoryStep {
                    id: "s3".to_string(),
                    label: "Type email".to_string(),
                    verb: DslVerb::Type,
                    args: serde_json::json!({"selector": "#email", "text": "user@test.com"}),
                    narration: None,
                },
                StoryStep {
                    id: "s4".to_string(),
                    label: "Submit".to_string(),
                    verb: DslVerb::Click,
                    args: serde_json::json!({"target": "Submit"}),
                    narration: None,
                },
            ],
        };

        let diff = compute_step_diff(old_text, &new_doc);

        assert_eq!(diff.len(), 4);
        assert_eq!(diff[0].step_id, "s1");
        assert_eq!(diff[0].kind, StepDiffKind::Unchanged);
        assert_eq!(diff[1].step_id, "s2");
        assert_eq!(diff[1].kind, StepDiffKind::Modified);
        assert_eq!(diff[2].step_id, "s3");
        assert_eq!(diff[2].kind, StepDiffKind::Unchanged);
        assert_eq!(diff[3].step_id, "s4");
        assert_eq!(diff[3].kind, StepDiffKind::Added);
        assert!(diff[3].old_text.is_none());
    }

    #[test]
    fn removed_step_produces_removed_variant() {
        let old_text = r#"# id: s1
navigate "https://example.com"
# id: s2
click "Login"
"#;

        let new_doc = StoryDoc {
            title: "Test".to_string(),
            steps: vec![StoryStep {
                id: "s1".to_string(),
                label: "Go to site".to_string(),
                verb: DslVerb::Navigate,
                args: serde_json::json!({"url": "https://example.com"}),
                narration: None,
            }],
        };

        let diff = compute_step_diff(old_text, &new_doc);

        // s1 unchanged, s2 removed
        assert_eq!(diff.len(), 2);
        assert_eq!(diff[0].step_id, "s1");
        assert_eq!(diff[0].kind, StepDiffKind::Unchanged);
        assert_eq!(diff[1].step_id, "s2");
        assert_eq!(diff[1].kind, StepDiffKind::Removed);
        assert!(diff[1].new_text.is_none());
    }
}
