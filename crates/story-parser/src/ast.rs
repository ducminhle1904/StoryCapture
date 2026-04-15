//! AST types for the Story DSL.
//!
//! Every node carries a [`Span`] so diagnostics can point at exact source
//! ranges. Types derive `serde` (Rust ↔ JSON) and, when the `ts-export`
//! feature is enabled, `ts-rs` mirror types are emitted to
//! `packages/story-dsl/src/ast.ts`.

use serde::{Deserialize, Serialize};

#[cfg(feature = "ts-export")]
use ts_rs::TS;

/// Source span (byte offsets + 1-indexed line/col of `start`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-export", derive(TS))]
#[cfg_attr(
    feature = "ts-export",
    ts(export, export_to = "../../../packages/story-dsl/src/ast.ts")
)]
pub struct Span {
    pub start: usize,
    pub end: usize,
    pub line: u32,
    pub col: u32,
}

impl Span {
    pub fn from_pair(pair: &pest::iterators::Pair<crate::parser::Rule>) -> Self {
        let span = pair.as_span();
        let (line, col) = span.start_pos().line_col();
        Self {
            start: span.start(),
            end: span.end(),
            line: line as u32,
            col: col as u32,
        }
    }

    pub fn empty() -> Self {
        Self::default()
    }
}

// ---- Top level ----

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-export", derive(TS))]
#[cfg_attr(
    feature = "ts-export",
    ts(export, export_to = "../../../packages/story-dsl/src/ast.ts")
)]
pub struct Story {
    pub name: Option<String>,
    pub meta: Meta,
    pub scenes: Vec<Scene>,
    pub span: Span,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-export", derive(TS))]
#[cfg_attr(
    feature = "ts-export",
    ts(export, export_to = "../../../packages/story-dsl/src/ast.ts")
)]
pub struct Meta {
    pub app: Option<String>,
    pub viewport: Option<Viewport>,
    pub theme: Option<Theme>,
    pub speed: Option<f32>,
    pub span: Span,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-export", derive(TS))]
#[cfg_attr(
    feature = "ts-export",
    ts(export, export_to = "../../../packages/story-dsl/src/ast.ts")
)]
pub struct Viewport {
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-export", derive(TS))]
#[cfg_attr(
    feature = "ts-export",
    ts(export, export_to = "../../../packages/story-dsl/src/ast.ts")
)]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    Light,
    Dark,
    Auto,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-export", derive(TS))]
#[cfg_attr(
    feature = "ts-export",
    ts(export, export_to = "../../../packages/story-dsl/src/ast.ts")
)]
pub struct Scene {
    pub name: String,
    pub commands: Vec<Command>,
    pub span: Span,
}

// ---- Targets ----

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-export", derive(TS))]
#[cfg_attr(
    feature = "ts-export",
    ts(export, export_to = "../../../packages/story-dsl/src/ast.ts")
)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum SelectorOrText {
    /// `"visible text"` — resolved via heuristic chain at runtime.
    Text(String),
    /// `selector "#email"` — strict CSS.
    Selector(String),
    /// `testid "submit"` — strict `data-testid`.
    TestId(String),
    /// `aria "Sign in"` — strict accessible name.
    Aria(String),
}

pub type WaitForTarget = SelectorOrText;
pub type AssertTarget = SelectorOrText;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-export", derive(TS))]
#[cfg_attr(
    feature = "ts-export",
    ts(export, export_to = "../../../packages/story-dsl/src/ast.ts")
)]
#[serde(rename_all = "lowercase")]
pub enum ScrollDir {
    Up,
    Down,
    Left,
    Right,
}

// ---- Commands ----

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-export", derive(TS))]
#[cfg_attr(
    feature = "ts-export",
    ts(export, export_to = "../../../packages/story-dsl/src/ast.ts")
)]
#[serde(tag = "verb", rename_all = "kebab-case")]
pub enum Command {
    Navigate { url: String, span: Span },
    Click { target: SelectorOrText, span: Span },
    Type { target: SelectorOrText, text: String, span: Span },
    Scroll { direction: ScrollDir, amount: Option<f32>, span: Span },
    Hover { target: SelectorOrText, span: Span },
    Drag { from: SelectorOrText, to: SelectorOrText, span: Span },
    Select { target: SelectorOrText, value: String, span: Span },
    Upload { target: SelectorOrText, path: String, span: Span },
    Wait { duration_ms: u64, span: Span },
    WaitFor { target: WaitForTarget, timeout_ms: Option<u64>, span: Span },
    Assert { target: AssertTarget, span: Span },
    Screenshot { name: String, span: Span },
    Pause { span: Span },
}

impl Command {
    pub fn span(&self) -> Span {
        match self {
            Command::Navigate { span, .. }
            | Command::Click { span, .. }
            | Command::Type { span, .. }
            | Command::Scroll { span, .. }
            | Command::Hover { span, .. }
            | Command::Drag { span, .. }
            | Command::Select { span, .. }
            | Command::Upload { span, .. }
            | Command::Wait { span, .. }
            | Command::WaitFor { span, .. }
            | Command::Assert { span, .. }
            | Command::Screenshot { span, .. }
            | Command::Pause { span } => *span,
        }
    }

    /// The verb keyword as it appears in source.
    pub fn verb(&self) -> &'static str {
        match self {
            Command::Navigate { .. } => "navigate",
            Command::Click { .. } => "click",
            Command::Type { .. } => "type",
            Command::Scroll { .. } => "scroll",
            Command::Hover { .. } => "hover",
            Command::Drag { .. } => "drag",
            Command::Select { .. } => "select",
            Command::Upload { .. } => "upload",
            Command::Wait { .. } => "wait",
            Command::WaitFor { .. } => "wait-for",
            Command::Assert { .. } => "assert",
            Command::Screenshot { .. } => "screenshot",
            Command::Pause { .. } => "pause",
        }
    }
}
