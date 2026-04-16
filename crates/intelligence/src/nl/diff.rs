//! Per-step diff engine for comparing old .story text against a new StoryDoc.

use super::schemas::{StoryDoc, StoryStep};

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

/// Compute per-step diff between old story text and a new StoryDoc.
///
/// Steps are matched by stable `step_id`. Old text is parsed to extract
/// step blocks by structural position or inline `# id: <id>` comments.
pub fn compute_step_diff(_old_text: &str, _new_doc: &StoryDoc) -> Vec<StepDiff> {
    // Will be implemented in Task 2
    Vec::new()
}
