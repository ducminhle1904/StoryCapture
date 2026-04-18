//! Layer 2 of the two-layer parse (D-08): take the lenient token stream,
//! validate semantic constraints, emit structured diagnostics, and
//! produce the typed `Story` AST.

use crate::ast::{
    AriaRole, Command, Meta, Scene, ScrollDir, SelectorOrText, Span, Story, Theme, Viewport,
};
use crate::diagnostic::Diagnostic;
use crate::lenient_tokenize::{
    LenientToken, MetaEntry, MetaRawValue, ParsedCommand, RawTarget,
};
use crate::suggest::{did_you_mean, KNOWN_META_KEYS, KNOWN_VERBS};

pub fn validate(tokens: Vec<LenientToken>, _source: &str) -> (Story, Vec<Diagnostic>) {
    let mut story = Story::default();
    let mut diagnostics = Vec::new();

    let mut current_scene: Option<Scene> = None;

    for tok in tokens {
        match tok {
            LenientToken::StoryStart { name, span } => {
                story.name = name;
                story.span = span;
            }
            LenientToken::StoryEnd => {
                if let Some(scene) = current_scene.take() {
                    story.scenes.push(scene);
                }
            }
            LenientToken::Meta { entries, span } => {
                let (meta, mut more) = build_meta(entries, span);
                story.meta = meta;
                diagnostics.append(&mut more);
            }
            LenientToken::SceneStart { name, span } => {
                if let Some(scene) = current_scene.take() {
                    story.scenes.push(scene);
                }
                current_scene = Some(Scene { name, commands: vec![], span });
            }
            LenientToken::SceneEnd => {
                if let Some(scene) = current_scene.take() {
                    story.scenes.push(scene);
                }
            }
            LenientToken::Command { pair_kind, span } => {
                if let Some(scene) = current_scene.as_mut() {
                    let (cmd, mut more) = build_command(pair_kind, span);
                    diagnostics.append(&mut more);
                    if let Some(c) = cmd {
                        scene.commands.push(c);
                    }
                } else {
                    diagnostics.push(Diagnostic::error(
                        "command outside of scene block",
                        span,
                    ));
                }
            }
            LenientToken::Unknown { text, span } => {
                let first_word = text
                    .split_whitespace()
                    .next()
                    .unwrap_or("")
                    .trim_matches(|c: char| !c.is_alphanumeric() && c != '-' && c != '_');
                if first_word.is_empty() {
                    continue;
                }
                let mut diag = Diagnostic::error(
                    format!("unknown command '{}'", first_word),
                    span,
                );
                if let Some(suggestion) = did_you_mean(first_word, KNOWN_VERBS) {
                    diag = diag
                        .with_suggestion(suggestion.clone())
                        .clone();
                    diag.message =
                        format!("unknown command '{}' — did you mean '{}'?", first_word, suggestion);
                }
                diagnostics.push(diag);
            }
        }
    }

    (story, diagnostics)
}

fn build_meta(entries: Vec<MetaEntry>, span: Span) -> (Meta, Vec<Diagnostic>) {
    let mut meta = Meta { span, ..Default::default() };
    let mut diagnostics = Vec::new();

    for entry in entries {
        match entry.key.as_str() {
            "app" => match &entry.value {
                MetaRawValue::String(s) => {
                    if !s.starts_with("http://") && !s.starts_with("https://") {
                        diagnostics.push(Diagnostic::warning(
                            format!("meta.app '{}' has no http(s) scheme", s),
                            entry.value_span,
                        ));
                    }
                    meta.app = Some(s.clone());
                }
                _ => diagnostics.push(Diagnostic::error(
                    "meta.app must be a quoted string URL",
                    entry.value_span,
                )),
            },
            "viewport" => match &entry.value {
                MetaRawValue::ViewportPair { width, height }
                | MetaRawValue::ViewportStruct { width, height } => {
                    meta.viewport = Some(Viewport { width: *width, height: *height });
                }
                MetaRawValue::Ident(name) => {
                    let preset = match name.as_str() {
                        "desktop" => Some((1280u32, 800u32)),
                        "tablet" => Some((1024, 768)),
                        "mobile" => Some((375, 667)),
                        _ => None,
                    };
                    match preset {
                        Some((w, h)) => meta.viewport = Some(Viewport { width: w, height: h }),
                        None => diagnostics.push(Diagnostic::error(
                            format!(
                                "invalid viewport '{}' (expected WIDTHxHEIGHT, e.g. 1280x800, or one of: desktop|tablet|mobile)",
                                name
                            ),
                            entry.value_span,
                        )),
                    }
                }
                _ => diagnostics.push(Diagnostic::error(
                    "viewport must be WIDTHxHEIGHT (e.g. 1280x800) or one of: desktop|tablet|mobile",
                    entry.value_span,
                )),
            },
            "theme" => match &entry.value {
                MetaRawValue::Ident(name) | MetaRawValue::String(name) => {
                    let theme = match name.as_str() {
                        "light" => Some(Theme::Light),
                        "dark" => Some(Theme::Dark),
                        "auto" => Some(Theme::Auto),
                        _ => None,
                    };
                    match theme {
                        Some(t) => meta.theme = Some(t),
                        None => diagnostics.push(Diagnostic::error(
                            format!(
                                "invalid theme '{}' (expected one of: light|dark|auto)",
                                name
                            ),
                            entry.value_span,
                        )),
                    }
                }
                _ => diagnostics.push(Diagnostic::error(
                    "theme must be one of: light|dark|auto",
                    entry.value_span,
                )),
            },
            "speed" => match &entry.value {
                MetaRawValue::Number(n) => {
                    if *n < 0.1 || *n > 3.0 {
                        diagnostics.push(Diagnostic::warning(
                            format!("speed {} is outside the supported range 0.1-3.0", n),
                            entry.value_span,
                        ));
                    }
                    meta.speed = Some(*n as f32);
                }
                _ => diagnostics.push(Diagnostic::error(
                    "speed must be a number between 0.1 and 3.0",
                    entry.value_span,
                )),
            },
            other => {
                let mut diag = Diagnostic::error(
                    format!("unknown meta key '{}'", other),
                    entry.key_span,
                );
                if let Some(suggestion) = did_you_mean(other, KNOWN_META_KEYS) {
                    diag.message = format!(
                        "unknown meta key '{}' — did you mean '{}'?",
                        other, suggestion
                    );
                    diag.suggestion = Some(suggestion);
                }
                diagnostics.push(diag);
            }
        }
    }

    (meta, diagnostics)
}

fn build_command(parsed: ParsedCommand, span: Span) -> (Option<Command>, Vec<Diagnostic>) {
    let mut diagnostics = Vec::new();
    let cmd = match parsed {
        ParsedCommand::Navigate { url } => {
            if url.is_empty() {
                diagnostics.push(Diagnostic::error("navigate URL must not be empty", span));
            } else if !url.starts_with("http://")
                && !url.starts_with("https://")
                && !url.starts_with("file://")
                && !url.starts_with("about:")
            {
                diagnostics.push(Diagnostic::warning(
                    format!("navigate URL '{}' has no scheme", url),
                    span,
                ));
            }
            Command::Navigate { url, span }
        }
        ParsedCommand::Click { target } => Command::Click { target: to_target(target), span },
        ParsedCommand::Type { target, text } => Command::Type {
            target: to_target(target),
            text,
            span,
        },
        ParsedCommand::Scroll { direction, amount } => Command::Scroll {
            direction: parse_scroll_dir(&direction),
            amount,
            span,
        },
        ParsedCommand::Hover { target } => Command::Hover { target: to_target(target), span },
        ParsedCommand::Drag { from, to } => Command::Drag {
            from: to_target(from),
            to: to_target(to),
            span,
        },
        ParsedCommand::Select { target, value } => Command::Select {
            target: to_target(target),
            value,
            span,
        },
        ParsedCommand::Upload { target, path } => Command::Upload {
            target: to_target(target),
            path,
            span,
        },
        ParsedCommand::Wait { duration_ms } => Command::Wait { duration_ms, span },
        ParsedCommand::WaitFor { target, timeout_ms } => Command::WaitFor {
            target: to_target(target),
            timeout_ms,
            span,
        },
        ParsedCommand::Assert { target } => Command::Assert { target: to_target(target), span },
        ParsedCommand::Screenshot { name } => Command::Screenshot { name, span },
        ParsedCommand::Pause => Command::Pause { span },
    };
    (Some(cmd), diagnostics)
}

fn parse_scroll_dir(s: &str) -> ScrollDir {
    match s {
        "up" => ScrollDir::Up,
        "down" => ScrollDir::Down,
        "left" => ScrollDir::Left,
        "right" => ScrollDir::Right,
        _ => ScrollDir::Down,
    }
}

fn to_target(t: RawTarget) -> SelectorOrText {
    // Phase 7 Tier 1: structural mapping only — diagnostic emission for
    // unknown roles is added in Task 2 by threading a `&mut Vec<Diagnostic>`
    // through this function. This intermediate form keeps the build green
    // between Task 1 (grammar+AST) and Task 2 (semantic+suggest) commits.
    match t {
        RawTarget::Text(s) => SelectorOrText::Text(s),
        RawTarget::Selector(s) => SelectorOrText::Selector(s),
        RawTarget::TestId(s) => SelectorOrText::TestId(s),
        RawTarget::Aria(s) => SelectorOrText::Aria(s),
        RawTarget::Role { role, name } => match AriaRole::from_keyword(&role) {
            Some(aria_role) => SelectorOrText::Role { role: aria_role, name },
            // Best-effort fallback when the role keyword is unknown — Task 2
            // replaces this with a did-you-mean diagnostic.
            None => SelectorOrText::Text(name),
        },
        RawTarget::Label(s) => SelectorOrText::Label(s),
        RawTarget::TextExact(s) => SelectorOrText::TextExact(s),
    }
}
