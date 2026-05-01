//! Public event types emitted by the executor.
//!
//! Crosses the Tauri `Channel<ExecutorEvent>` boundary and also runs in
//! pure-Rust (headless) contexts. Only `serde` derives are required here —
//! the Tauri host wraps its own specta mirror so this crate stays decoupled.

use crate::action_timeline::ActionTimelineEvent;
use crate::driver::BoundingBox;
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
    // explicit, strict, single-attempt strategies.
    /// `button "Save"` etc. — Playwright `getByRole(role, { name, exact: true })`.
    Role,
    /// `field "Email"` — Playwright `getByLabel(name, { exact: true })`.
    Label,
    /// `text "Learn more"` — Playwright `getByText(name, { exact: true })`.
    TextExact,
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
            SelectorStrategy::Role => "role",
            SelectorStrategy::Label => "label",
            SelectorStrategy::TextExact => "text_exact",
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

/// Resolve outcome for a single step. Drives the simulator UI's
/// "Promote to fallback" button gate — only `Fuzzy` matches are promotable.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MatchKind {
    /// Primary selector strategy matched.
    Primary,
    /// A fallback strategy matched (self-healing candidate).
    Fuzzy,
    /// Command had no target (Navigate / Wait / WaitMs / Screenshot).
    None,
}

/// Per-step capture produced when the simulator runs with
/// `capture_frames=true`. Paired with `ExecutorEvent::StepFrameCaptured`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StepFrame {
    pub ordinal: u32,
    pub screenshot_path: Option<PathBuf>,
    pub cursor_xy: (i32, i32),
    pub matched_selector: Option<String>,
    pub matched_bbox: Option<BoundingBox>,
    pub match_kind: MatchKind,
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
        step_id: Option<uuid::Uuid>,
        duration_ms: u64,
        cursor_x: i32,
        cursor_y: i32,
        matched_selector: Option<String>,
        matched_bbox: Option<BoundingBox>,
        match_kind: MatchKind,
    },
    ActionRecorded {
        event: ActionTimelineEvent,
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
    RunPaused {
        ordinal: u32,
    },
    StepFrameCaptured {
        ordinal: u32,
        frame: StepFrame,
    },
}
