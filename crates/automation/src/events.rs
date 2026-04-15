//! Public event types emitted by the executor.
//!
//! These cross the Tauri `Channel<ExecutorEvent>` boundary in
//! `apps/desktop/src-tauri/src/commands/automation.rs`. They are also
//! consumed in pure-Rust contexts (Phase 5 headless CLI). `serde::Serialize`
//! is the only required derive — `specta::Type` would couple this crate to
//! the Tauri side, which D-07/D-11 forbids; the host adds a thin specta
//! wrapper if needed.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use story_parser::Command;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SelectorStrategy {
    /// `selector "..."` — strict CSS, no fallback.
    Css,
    /// `testid "..."` — strict `[data-testid="..."]`, no fallback.
    TestId,
    /// `aria "..."` — strict accessible-name, no fallback.
    Aria,
    /// `"visible text"` — ranked actionable / accessibility candidate.
    AccessibleName,
    /// `"visible text"` — visible text on actionable control.
    VisibleText,
    /// `"visible text"` — label-to-control association (form fields).
    LabelAssoc,
    /// `"visible text"` — bounded fuzzy / partial text (last resort).
    FuzzyText,
}

impl SelectorStrategy {
    pub fn as_str(&self) -> &'static str {
        match self {
            SelectorStrategy::Css => "css",
            SelectorStrategy::TestId => "testid",
            SelectorStrategy::Aria => "aria",
            SelectorStrategy::AccessibleName => "accessible-name",
            SelectorStrategy::VisibleText => "visible-text",
            SelectorStrategy::LabelAssoc => "label-assoc",
            SelectorStrategy::FuzzyText => "fuzzy-text",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AttemptOutcome {
    Found { score: f32 },
    NotFound,
    Ambiguous { candidates: usize },
    Error { message: String },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AttemptLog {
    pub strategy: SelectorStrategy,
    pub value: String,
    pub outcome: AttemptOutcome,
    pub elapsed_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StorySummary {
    pub total_steps: u32,
    pub succeeded: u32,
    pub failed: u32,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ExecutorEvent {
    StoryStarted {
        story_hash: String,
    },
    SceneEntered {
        name: String,
        ordinal: u32,
    },
    StepStarted {
        ordinal: u32,
        command: Command,
        driver_used: String,
    },
    StepAttempt {
        step_ordinal: u32,
        attempt: AttemptLog,
    },
    StepSucceeded {
        ordinal: u32,
        duration_ms: u64,
        cursor_x: i32,
        cursor_y: i32,
    },
    StepFailed {
        ordinal: u32,
        attempts: Vec<AttemptLog>,
        error_message: String,
        screenshot_path: Option<PathBuf>,
    },
    StoryEnded {
        status: StorySummary,
    },
}
