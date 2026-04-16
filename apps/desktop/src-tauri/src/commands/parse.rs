// parse.rs — DSL parse IPC command (Phase 1 plan 01-09).
//
// The renderer's `diagnostics-bridge.ts` calls this command on every
// CodeMirror buffer change (debounced 300ms). It delegates straight to
// `story_parser::parse` — no host-side business logic — and returns a
// `ParseResult` with best-effort AST + structured diagnostics.
//
// `story_parser::parser::ParseResult` and `story_parser::diagnostic::Diagnostic`
// are defined in the pure `story-parser` crate which deliberately
// does NOT depend on `specta`. We wrap them here in DTOs that derive
// `specta::Type` so the generated TS binding (`ParseResultDto`, etc.)
// lives in `packages/shared-types/src/ipc.ts`.
//
// The structural mirror in `packages/story-dsl/src/ast.ts` is authored
// by `ts-rs` directly from the `story-parser` types — same shape,
// different codegen path — so renderers can `import type { Diagnostic }`
// from `@storycapture/story-dsl` if they prefer the rich types. For the
// IPC round-trip we use the specta DTOs here because specta is how
// commands get typed bindings.

use crate::error::AppError;
use serde::{Deserialize, Serialize};
use specta::Type;
use story_parser::{
    Command as PCommand, Diagnostic as PDiagnostic, Meta as PMeta, ParseResult as PParseResult,
    Scene as PScene, ScrollDir as PScrollDir, SelectorOrText as PSelectorOrText, Severity as PSev,
    Span as PSpan, Story as PStory, Theme as PTheme, Viewport as PViewport,
};

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct SpanDto {
    pub start: u32,
    pub end: u32,
    pub line: u32,
    pub col: u32,
}

impl From<PSpan> for SpanDto {
    fn from(s: PSpan) -> Self {
        SpanDto {
            start: s.start as u32,
            end: s.end as u32,
            line: s.line as u32,
            col: s.col as u32,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum SeverityDto {
    Error,
    Warning,
    Info,
}

impl From<PSev> for SeverityDto {
    fn from(s: PSev) -> Self {
        match s {
            PSev::Error => SeverityDto::Error,
            PSev::Warning => SeverityDto::Warning,
            PSev::Info => SeverityDto::Info,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct DiagnosticDto {
    pub severity: SeverityDto,
    pub message: String,
    pub span: SpanDto,
    pub suggestion: Option<String>,
}

impl From<PDiagnostic> for DiagnosticDto {
    fn from(d: PDiagnostic) -> Self {
        DiagnosticDto {
            severity: d.severity.into(),
            message: d.message,
            span: d.span.into(),
            suggestion: d.suggestion,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum SelectorOrTextDto {
    Text(String),
    Selector(String),
    TestId(String),
    Aria(String),
}

impl From<PSelectorOrText> for SelectorOrTextDto {
    fn from(s: PSelectorOrText) -> Self {
        match s {
            PSelectorOrText::Text(v) => SelectorOrTextDto::Text(v),
            PSelectorOrText::Selector(v) => SelectorOrTextDto::Selector(v),
            PSelectorOrText::TestId(v) => SelectorOrTextDto::TestId(v),
            PSelectorOrText::Aria(v) => SelectorOrTextDto::Aria(v),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum ScrollDirDto {
    Up,
    Down,
    Left,
    Right,
}

impl From<PScrollDir> for ScrollDirDto {
    fn from(s: PScrollDir) -> Self {
        match s {
            PScrollDir::Up => ScrollDirDto::Up,
            PScrollDir::Down => ScrollDirDto::Down,
            PScrollDir::Left => ScrollDirDto::Left,
            PScrollDir::Right => ScrollDirDto::Right,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "verb", rename_all = "kebab-case")]
pub enum CommandDto {
    Navigate {
        url: String,
        span: SpanDto,
    },
    Click {
        target: SelectorOrTextDto,
        span: SpanDto,
    },
    Type {
        target: SelectorOrTextDto,
        text: String,
        span: SpanDto,
    },
    Scroll {
        direction: ScrollDirDto,
        amount: Option<f32>,
        span: SpanDto,
    },
    Hover {
        target: SelectorOrTextDto,
        span: SpanDto,
    },
    Drag {
        from: SelectorOrTextDto,
        to: SelectorOrTextDto,
        span: SpanDto,
    },
    Select {
        target: SelectorOrTextDto,
        value: String,
        span: SpanDto,
    },
    Upload {
        target: SelectorOrTextDto,
        path: String,
        span: SpanDto,
    },
    Wait {
        duration_ms: u64,
        span: SpanDto,
    },
    WaitFor {
        target: SelectorOrTextDto,
        timeout_ms: Option<u64>,
        span: SpanDto,
    },
    Assert {
        target: SelectorOrTextDto,
        span: SpanDto,
    },
    Screenshot {
        name: String,
        span: SpanDto,
    },
    Pause {
        span: SpanDto,
    },
}

impl From<PCommand> for CommandDto {
    fn from(c: PCommand) -> Self {
        match c {
            PCommand::Navigate { url, span } => CommandDto::Navigate {
                url,
                span: span.into(),
            },
            PCommand::Click { target, span } => CommandDto::Click {
                target: target.into(),
                span: span.into(),
            },
            PCommand::Type { target, text, span } => CommandDto::Type {
                target: target.into(),
                text,
                span: span.into(),
            },
            PCommand::Scroll {
                direction,
                amount,
                span,
            } => CommandDto::Scroll {
                direction: direction.into(),
                amount,
                span: span.into(),
            },
            PCommand::Hover { target, span } => CommandDto::Hover {
                target: target.into(),
                span: span.into(),
            },
            PCommand::Drag { from, to, span } => CommandDto::Drag {
                from: from.into(),
                to: to.into(),
                span: span.into(),
            },
            PCommand::Select {
                target,
                value,
                span,
            } => CommandDto::Select {
                target: target.into(),
                value,
                span: span.into(),
            },
            PCommand::Upload { target, path, span } => CommandDto::Upload {
                target: target.into(),
                path,
                span: span.into(),
            },
            PCommand::Wait { duration_ms, span } => CommandDto::Wait {
                duration_ms,
                span: span.into(),
            },
            PCommand::WaitFor {
                target,
                timeout_ms,
                span,
            } => CommandDto::WaitFor {
                target: target.into(),
                timeout_ms,
                span: span.into(),
            },
            PCommand::Assert { target, span } => CommandDto::Assert {
                target: target.into(),
                span: span.into(),
            },
            PCommand::Screenshot { name, span } => CommandDto::Screenshot {
                name,
                span: span.into(),
            },
            PCommand::Pause { span } => CommandDto::Pause { span: span.into() },
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum ThemeDto {
    Light,
    Dark,
    Auto,
}

impl From<PTheme> for ThemeDto {
    fn from(t: PTheme) -> Self {
        match t {
            PTheme::Light => ThemeDto::Light,
            PTheme::Dark => ThemeDto::Dark,
            PTheme::Auto => ThemeDto::Auto,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct ViewportDto {
    pub width: u32,
    pub height: u32,
}

impl From<PViewport> for ViewportDto {
    fn from(v: PViewport) -> Self {
        ViewportDto {
            width: v.width,
            height: v.height,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct MetaDto {
    pub app: Option<String>,
    pub viewport: Option<ViewportDto>,
    pub theme: Option<ThemeDto>,
    pub speed: Option<f32>,
    pub span: SpanDto,
}

impl From<PMeta> for MetaDto {
    fn from(m: PMeta) -> Self {
        MetaDto {
            app: m.app,
            viewport: m.viewport.map(Into::into),
            theme: m.theme.map(Into::into),
            speed: m.speed,
            span: m.span.into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct SceneDto {
    pub name: String,
    pub commands: Vec<CommandDto>,
    pub span: SpanDto,
}

impl From<PScene> for SceneDto {
    fn from(s: PScene) -> Self {
        SceneDto {
            name: s.name,
            commands: s.commands.into_iter().map(Into::into).collect(),
            span: s.span.into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct StoryDto {
    pub name: Option<String>,
    pub meta: MetaDto,
    pub scenes: Vec<SceneDto>,
    pub span: SpanDto,
}

impl From<PStory> for StoryDto {
    fn from(s: PStory) -> Self {
        StoryDto {
            name: s.name,
            meta: s.meta.into(),
            scenes: s.scenes.into_iter().map(Into::into).collect(),
            span: s.span.into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct ParseResultDto {
    pub ast: Option<StoryDto>,
    pub diagnostics: Vec<DiagnosticDto>,
}

impl From<PParseResult> for ParseResultDto {
    fn from(r: PParseResult) -> Self {
        ParseResultDto {
            ast: r.ast.map(Into::into),
            diagnostics: r.diagnostics.into_iter().map(Into::into).collect(),
        }
    }
}

/// Parse a `.story` source string and return best-effort AST + diagnostics.
///
/// The parser is guaranteed non-panicking on valid UTF-8; the 10 MB byte cap
/// is enforced at the higher `story_parser::io::parse_file` layer — this
/// command accepts an already-loaded string (the renderer owns the buffer,
/// CodeMirror virtualizes large files). If you need the hard cap here,
/// check `source.len() <= story_parser::MAX_STORY_FILE_BYTES` first.
#[tauri::command]
#[specta::specta]
pub fn parse_story(source: String) -> Result<ParseResultDto, AppError> {
    if (source.len() as u64) > story_parser::MAX_STORY_FILE_BYTES {
        return Err(AppError::InvalidArgument(format!(
            "story source exceeds {} byte cap",
            story_parser::MAX_STORY_FILE_BYTES
        )));
    }
    Ok(story_parser::parse(&source).into())
}
