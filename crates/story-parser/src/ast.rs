//! AST types for the Story DSL.
//!
//! Every node carries a [`Span`]. With `ts-export`, `ts-rs` also mirrors these
//! types to `packages/story-dsl/src/ast.ts`.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[cfg(feature = "ts-export")]
use ts_rs::TS;

/// Source span with byte offsets and the 1-indexed start position.
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

// Top-level nodes

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

// Targets

/// ARIA role keyword recognized by the `<role> "name"`
/// target form. Maps 1:1 onto Playwright `getByRole(role, { name })`.
///
/// Serializes to kebab-case (e.g. `Button` → `"button"`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-export", derive(TS))]
#[cfg_attr(
    feature = "ts-export",
    ts(export, export_to = "../../../packages/story-dsl/src/ast.ts")
)]
#[serde(rename_all = "kebab-case")]
pub enum AriaRole {
    Button,
    Link,
    Heading,
    Image,
    Checkbox,
    Radio,
    Tab,
    Menuitem,
    Menu,
    Option,
    Combobox,
    Listbox,
    Dialog,
    Alert,
    Tooltip,
    Switch,
    Slider,
    Row,
    Cell,
    Navigation,
    Main,
}

impl AriaRole {
    /// Return the canonical kebab-case spelling used on the wire.
    pub fn as_kebab(&self) -> &'static str {
        match self {
            AriaRole::Button => "button",
            AriaRole::Link => "link",
            AriaRole::Heading => "heading",
            AriaRole::Image => "image",
            AriaRole::Checkbox => "checkbox",
            AriaRole::Radio => "radio",
            AriaRole::Tab => "tab",
            AriaRole::Menuitem => "menuitem",
            AriaRole::Menu => "menu",
            AriaRole::Option => "option",
            AriaRole::Combobox => "combobox",
            AriaRole::Listbox => "listbox",
            AriaRole::Dialog => "dialog",
            AriaRole::Alert => "alert",
            AriaRole::Tooltip => "tooltip",
            AriaRole::Switch => "switch",
            AriaRole::Slider => "slider",
            AriaRole::Row => "row",
            AriaRole::Cell => "cell",
            AriaRole::Navigation => "navigation",
            AriaRole::Main => "main",
        }
    }

    // 21 enum variants; 22 keyword spellings (image/img alias — both map to Image
    // per D-05 / RESEARCH Q5). The count asymmetry is intentional, not a bug.
    // `KNOWN_ROLES` in suggest.rs mirrors the 22 spellings for did-you-mean.
    pub fn from_keyword(kw: &str) -> Option<Self> {
        Some(match kw {
            "button" => Self::Button,
            "link" => Self::Link,
            "heading" => Self::Heading,
            // `image` and `img` both map to Image per D-05 / RESEARCH Q5
            "image" | "img" => Self::Image,
            "checkbox" => Self::Checkbox,
            "radio" => Self::Radio,
            "tab" => Self::Tab,
            "menuitem" => Self::Menuitem,
            "menu" => Self::Menu,
            "option" => Self::Option,
            "combobox" => Self::Combobox,
            "listbox" => Self::Listbox,
            "dialog" => Self::Dialog,
            "alert" => Self::Alert,
            "tooltip" => Self::Tooltip,
            "switch" => Self::Switch,
            "slider" => Self::Slider,
            "row" => Self::Row,
            "cell" => Self::Cell,
            "navigation" => Self::Navigation,
            "main" => Self::Main,
            _ => return None,
        })
    }
}

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
    /// `<role> "name"` → Playwright `getByRole(role, { name, exact: true })`.
    Role { role: AriaRole, name: String },
    /// `field "Email"` → Playwright `getByLabel(name, { exact: true })`.
    Label(String),
    /// `text "Learn more"` → Playwright `getByText(name, { exact: true })`.
    /// Distinct from the bare `Text(_)` variant which keeps its ranked/heuristic resolution.
    TextExact(String),
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

// Commands

/// Per-command line metadata — originally just source line/column.
///
/// Phase 7 Tier 2 (plan 07-04b) adds `step_id: Option<Uuid>` carrying the
/// parsed trailing `# @id=<uuidv7>` comment. Grammar extension is ADDITIVE;
/// legacy lines parse with `step_id == None`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-export", derive(TS))]
#[cfg_attr(
    feature = "ts-export",
    ts(export, export_to = "../../../packages/story-dsl/src/ast.ts")
)]
pub struct LineMeta {
    pub line: u32,
    pub column: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts-export", ts(optional, type = "string"))]
    pub step_id: Option<Uuid>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-export", derive(TS))]
#[cfg_attr(
    feature = "ts-export",
    ts(export, export_to = "../../../packages/story-dsl/src/ast.ts")
)]
#[serde(tag = "verb", rename_all = "kebab-case")]
pub enum Command {
    Navigate { url: String, span: Span, #[serde(default, skip_serializing_if = "Option::is_none")] #[cfg_attr(feature = "ts-export", ts(optional, type = "string"))] step_id: Option<Uuid> },
    Click { target: SelectorOrText, span: Span, #[serde(default, skip_serializing_if = "Option::is_none")] #[cfg_attr(feature = "ts-export", ts(optional, type = "string"))] step_id: Option<Uuid> },
    Type { target: SelectorOrText, text: String, span: Span, #[serde(default, skip_serializing_if = "Option::is_none")] #[cfg_attr(feature = "ts-export", ts(optional, type = "string"))] step_id: Option<Uuid> },
    Scroll { direction: ScrollDir, amount: Option<f32>, span: Span, #[serde(default, skip_serializing_if = "Option::is_none")] #[cfg_attr(feature = "ts-export", ts(optional, type = "string"))] step_id: Option<Uuid> },
    Hover { target: SelectorOrText, span: Span, #[serde(default, skip_serializing_if = "Option::is_none")] #[cfg_attr(feature = "ts-export", ts(optional, type = "string"))] step_id: Option<Uuid> },
    Drag { from: SelectorOrText, to: SelectorOrText, span: Span, #[serde(default, skip_serializing_if = "Option::is_none")] #[cfg_attr(feature = "ts-export", ts(optional, type = "string"))] step_id: Option<Uuid> },
    Select { target: SelectorOrText, value: String, span: Span, #[serde(default, skip_serializing_if = "Option::is_none")] #[cfg_attr(feature = "ts-export", ts(optional, type = "string"))] step_id: Option<Uuid> },
    Upload { target: SelectorOrText, path: String, span: Span, #[serde(default, skip_serializing_if = "Option::is_none")] #[cfg_attr(feature = "ts-export", ts(optional, type = "string"))] step_id: Option<Uuid> },
    Wait { duration_ms: u64, span: Span, #[serde(default, skip_serializing_if = "Option::is_none")] #[cfg_attr(feature = "ts-export", ts(optional, type = "string"))] step_id: Option<Uuid> },
    WaitFor { target: WaitForTarget, timeout_ms: Option<u64>, span: Span, #[serde(default, skip_serializing_if = "Option::is_none")] #[cfg_attr(feature = "ts-export", ts(optional, type = "string"))] step_id: Option<Uuid> },
    Assert { target: AssertTarget, span: Span, #[serde(default, skip_serializing_if = "Option::is_none")] #[cfg_attr(feature = "ts-export", ts(optional, type = "string"))] step_id: Option<Uuid> },
    Screenshot { name: String, span: Span, #[serde(default, skip_serializing_if = "Option::is_none")] #[cfg_attr(feature = "ts-export", ts(optional, type = "string"))] step_id: Option<Uuid> },
    Pause { span: Span, #[serde(default, skip_serializing_if = "Option::is_none")] #[cfg_attr(feature = "ts-export", ts(optional, type = "string"))] step_id: Option<Uuid> },
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
            | Command::Pause { span, .. } => *span,
        }
    }

    /// Return the optional step id parsed from a trailing `# @id=<uuidv7>` comment.
    /// Legacy lines (no comment) yield `None`.
    pub fn step_id(&self) -> Option<Uuid> {
        match self {
            Command::Navigate { step_id, .. }
            | Command::Click { step_id, .. }
            | Command::Type { step_id, .. }
            | Command::Scroll { step_id, .. }
            | Command::Hover { step_id, .. }
            | Command::Drag { step_id, .. }
            | Command::Select { step_id, .. }
            | Command::Upload { step_id, .. }
            | Command::Wait { step_id, .. }
            | Command::WaitFor { step_id, .. }
            | Command::Assert { step_id, .. }
            | Command::Screenshot { step_id, .. }
            | Command::Pause { step_id, .. } => *step_id,
        }
    }

    /// Return a [`LineMeta`] view over this command's line/column + step_id.
    pub fn meta(&self) -> LineMeta {
        let s = self.span();
        LineMeta {
            line: s.line,
            column: s.col,
            step_id: self.step_id(),
        }
    }

    /// Zero out the span (test helper for AST structural equality across a
    /// parse-format-parse round-trip, where byte offsets are allowed to drift).
    pub fn clear_span(&mut self) {
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
            | Command::Pause { span, .. } => *span = Span::empty(),
        }
    }

    /// Set the trailing `# @id=<uuidv7>` step id on this command (plan
    /// 07-04c). Used by `picker_stamp_step_id` after a first pick to
    /// stamp a fresh UUIDv7 onto the source line before re-formatting.
    pub fn set_step_id(&mut self, id: Option<Uuid>) {
        match self {
            Command::Navigate { step_id, .. }
            | Command::Click { step_id, .. }
            | Command::Type { step_id, .. }
            | Command::Scroll { step_id, .. }
            | Command::Hover { step_id, .. }
            | Command::Drag { step_id, .. }
            | Command::Select { step_id, .. }
            | Command::Upload { step_id, .. }
            | Command::Wait { step_id, .. }
            | Command::WaitFor { step_id, .. }
            | Command::Assert { step_id, .. }
            | Command::Screenshot { step_id, .. }
            | Command::Pause { step_id, .. } => *step_id = id,
        }
    }

    /// Verb string as written in source.
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
