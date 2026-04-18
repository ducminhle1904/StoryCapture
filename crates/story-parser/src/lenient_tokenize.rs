//! Layer 1 of the two-layer parse: walk pest pairs and produce
//! `LenientToken`s. Unknown lines become `LenientToken::Unknown` so layer 2
//! can emit suggestions.

use pest::iterators::Pair;

use crate::ast::Span;
use crate::parser::Rule;

#[derive(Debug, Clone)]
pub enum LenientToken {
    StoryStart {
        name: Option<String>,
        span: Span,
    },
    StoryEnd,
    Meta {
        entries: Vec<MetaEntry>,
        span: Span,
    },
    SceneStart {
        name: String,
        span: Span,
    },
    SceneEnd,
    Command {
        pair_kind: ParsedCommand,
        span: Span,
    },
    /// A line layer 1 could not classify.
    Unknown {
        text: String,
        span: Span,
    },
}

#[derive(Debug, Clone)]
pub struct MetaEntry {
    pub key: String,
    pub key_span: Span,
    pub value: MetaRawValue,
    pub value_span: Span,
    pub entry_span: Span,
}

#[derive(Debug, Clone)]
pub enum MetaRawValue {
    String(String),
    Number(f64),
    Ident(String),
    /// `1280x800` literal pair.
    ViewportPair { width: u32, height: u32 },
    /// `{ width: N, height: N }` struct.
    ViewportStruct { width: u32, height: u32 },
}

#[derive(Debug, Clone)]
pub enum ParsedCommand {
    Navigate { url: String },
    Click { target: RawTarget },
    Type { target: RawTarget, text: String },
    Scroll { direction: String, amount: Option<f32> },
    Hover { target: RawTarget },
    Drag { from: RawTarget, to: RawTarget },
    Select { target: RawTarget, value: String },
    Upload { target: RawTarget, path: String },
    Wait { duration_ms: u64 },
    WaitFor { target: RawTarget, timeout_ms: Option<u64> },
    Assert { target: RawTarget },
    Screenshot { name: String },
    Pause,
}

#[derive(Debug, Clone)]
pub enum RawTarget {
    Text(String),
    Selector(String),
    TestId(String),
    Aria(String),
}

pub fn tokenize(file_pair: Pair<Rule>) -> Vec<LenientToken> {
    let mut out = Vec::new();
    for pair in file_pair.into_inner() {
        if pair.as_rule() == Rule::story_block {
            walk_story_block(pair, &mut out);
        }
    }
    out
}

fn walk_story_block(pair: Pair<Rule>, out: &mut Vec<LenientToken>) {
    let span = Span::from_pair(&pair);
    let mut name: Option<String> = None;
    let mut inner = pair.into_inner().peekable();

    // Optional story name.
    if let Some(p) = inner.peek() {
        if p.as_rule() == Rule::string {
            name = Some(unquote(inner.next().unwrap().as_str()));
        }
    }
    out.push(LenientToken::StoryStart { name, span });

    for child in inner {
        match child.as_rule() {
            Rule::meta_block => walk_meta_block(child, out),
            Rule::scene_block => walk_scene_block(child, out),
            _ => {}
        }
    }
    out.push(LenientToken::StoryEnd);
}

fn walk_meta_block(pair: Pair<Rule>, out: &mut Vec<LenientToken>) {
    let span = Span::from_pair(&pair);
    let mut entries = Vec::new();
    for child in pair.into_inner() {
        if child.as_rule() == Rule::meta_entry {
            entries.push(parse_meta_entry(child));
        }
    }
    out.push(LenientToken::Meta { entries, span });
}

fn parse_meta_entry(pair: Pair<Rule>) -> MetaEntry {
    let entry_span = Span::from_pair(&pair);
    let mut key = String::new();
    let mut key_span = Span::empty();
    let mut value = MetaRawValue::Ident(String::new());
    let mut value_span = Span::empty();

    for child in pair.into_inner() {
        match child.as_rule() {
            Rule::meta_key => {
                key_span = Span::from_pair(&child);
                key = child.as_str().to_string();
            }
            Rule::meta_value => {
                value_span = Span::from_pair(&child);
                value = parse_meta_value(child);
            }
            _ => {}
        }
    }
    MetaEntry { key, key_span, value, value_span, entry_span }
}

fn parse_meta_value(pair: Pair<Rule>) -> MetaRawValue {
    let inner = pair.into_inner().next();
    match inner {
        Some(p) => match p.as_rule() {
            Rule::string => MetaRawValue::String(unquote(p.as_str())),
            Rule::number => MetaRawValue::Number(p.as_str().parse().unwrap_or(0.0)),
            Rule::ident => MetaRawValue::Ident(p.as_str().to_string()),
            Rule::viewport_pair => {
                let txt = p.as_str();
                let (w, h) = txt.split_once('x').unwrap_or(("0", "0"));
                MetaRawValue::ViewportPair {
                    width: w.parse().unwrap_or(0),
                    height: h.parse().unwrap_or(0),
                }
            }
            Rule::viewport_struct => {
                let mut nums = p.into_inner().filter(|c| c.as_rule() == Rule::number);
                let w: u32 = nums.next().and_then(|n| n.as_str().parse().ok()).unwrap_or(0);
                let h: u32 = nums.next().and_then(|n| n.as_str().parse().ok()).unwrap_or(0);
                MetaRawValue::ViewportStruct { width: w, height: h }
            }
            _ => MetaRawValue::Ident(String::new()),
        },
        None => MetaRawValue::Ident(String::new()),
    }
}

fn walk_scene_block(pair: Pair<Rule>, out: &mut Vec<LenientToken>) {
    let span = Span::from_pair(&pair);
    // Extract the scene name before pushing `SceneStart`.
    let mut inner: Vec<_> = pair.into_inner().collect();
    let name = inner
        .iter()
        .position(|p| p.as_rule() == Rule::string)
        .map(|i| unquote(inner.remove(i).as_str()))
        .unwrap_or_default();
    out.push(LenientToken::SceneStart { name, span });

    for child in inner {
        match child.as_rule() {
            Rule::statement => {
                for stmt_child in child.into_inner() {
                    match stmt_child.as_rule() {
                        Rule::command_line => {
                            let line_span = Span::from_pair(&stmt_child);
                            // The first inner pair is `command`.
                            if let Some(cmd) =
                                stmt_child.into_inner().find(|p| p.as_rule() == Rule::command)
                            {
                                if let Some(parsed) = parse_command(cmd) {
                                    out.push(LenientToken::Command {
                                        pair_kind: parsed,
                                        span: line_span,
                                    });
                                }
                            }
                        }
                        Rule::recovery_line => {
                            let span = Span::from_pair(&stmt_child);
                            let text = stmt_child.as_str().trim().to_string();
                            if !text.is_empty() {
                                out.push(LenientToken::Unknown { text, span });
                            }
                        }
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }
    out.push(LenientToken::SceneEnd);
}

fn parse_command(pair: Pair<Rule>) -> Option<ParsedCommand> {
    let cmd = pair.into_inner().next()?;
    Some(match cmd.as_rule() {
        Rule::cmd_navigate => {
            let url = first_string(cmd);
            ParsedCommand::Navigate { url }
        }
        Rule::cmd_click => ParsedCommand::Click { target: parse_target(cmd) },
        Rule::cmd_type => {
            let mut inner = cmd.into_inner();
            let target = parse_target_pair(inner.next()?);
            let text = unquote(inner.next()?.as_str());
            ParsedCommand::Type { target, text }
        }
        Rule::cmd_scroll => {
            let mut inner = cmd.into_inner();
            let direction = inner.next()?.as_str().to_string();
            let amount = inner.next().and_then(|n| n.as_str().parse().ok());
            ParsedCommand::Scroll { direction, amount }
        }
        Rule::cmd_hover => ParsedCommand::Hover { target: parse_target(cmd) },
        Rule::cmd_drag => {
            let mut inner = cmd.into_inner();
            let from = parse_target_pair(inner.next()?);
            let to = parse_target_pair(inner.next()?);
            ParsedCommand::Drag { from, to }
        }
        Rule::cmd_select => {
            let mut inner = cmd.into_inner();
            let target = parse_target_pair(inner.next()?);
            let value = unquote(inner.next()?.as_str());
            ParsedCommand::Select { target, value }
        }
        Rule::cmd_upload => {
            let mut inner = cmd.into_inner();
            let target = parse_target_pair(inner.next()?);
            let path = unquote(inner.next()?.as_str());
            ParsedCommand::Upload { target, path }
        }
        Rule::cmd_wait => {
            let dur = cmd.into_inner().find(|p| p.as_rule() == Rule::duration)?;
            ParsedCommand::Wait { duration_ms: parse_duration(dur.as_str()) }
        }
        Rule::cmd_wait_for => {
            let mut inner = cmd.into_inner().peekable();
            let target = parse_target_pair(inner.next()?);
            let timeout_ms = inner
                .find(|p| p.as_rule() == Rule::duration)
                .map(|d| parse_duration(d.as_str()));
            ParsedCommand::WaitFor { target, timeout_ms }
        }
        Rule::cmd_assert => ParsedCommand::Assert { target: parse_target(cmd) },
        Rule::cmd_screenshot => {
            let name = first_string(cmd);
            ParsedCommand::Screenshot { name }
        }
        Rule::cmd_pause => ParsedCommand::Pause,
        _ => return None,
    })
}

fn parse_target(cmd_pair: Pair<Rule>) -> RawTarget {
    let target = cmd_pair.into_inner().find(|p| p.as_rule() == Rule::target);
    match target {
        Some(t) => parse_target_pair(t),
        None => RawTarget::Text(String::new()),
    }
}

fn parse_target_pair(pair: Pair<Rule>) -> RawTarget {
    let inner = pair.into_inner().next();
    match inner {
        Some(p) => match p.as_rule() {
            // `first_string` strips the target prefix and returns the inner string.
            Rule::target_text => RawTarget::Text(first_string(p)),
            Rule::target_selector => RawTarget::Selector(first_string(p)),
            Rule::target_testid => RawTarget::TestId(first_string(p)),
            Rule::target_aria => RawTarget::Aria(first_string(p)),
            _ => RawTarget::Text(String::new()),
        },
        None => RawTarget::Text(String::new()),
    }
}

fn first_string(pair: Pair<Rule>) -> String {
    pair.into_inner()
        .find(|p| p.as_rule() == Rule::string)
        .map(|s| unquote(s.as_str()))
        .unwrap_or_default()
}

fn first_string_str(pair: Pair<Rule>) -> &str {
    let raw = pair.as_str();
    raw
}

fn unquote(s: &str) -> String {
    let trimmed = s.trim();
    let inner = trimmed.strip_prefix('"').and_then(|x| x.strip_suffix('"')).unwrap_or(trimmed);
    // Unescape \" and \\
    let mut out = String::with_capacity(inner.len());
    let mut chars = inner.chars();
    while let Some(c) = chars.next() {
        if c == '\\' {
            match chars.next() {
                Some('"') => out.push('"'),
                Some('\\') => out.push('\\'),
                Some('n') => out.push('\n'),
                Some('t') => out.push('\t'),
                Some(other) => out.push(other),
                None => {}
            }
        } else {
            out.push(c);
        }
    }
    out
}

/// Parse `1500ms`, `2s`, `3m` → milliseconds.
pub fn parse_duration(s: &str) -> u64 {
    let s = s.trim();
    let (num, unit) = if let Some(stripped) = s.strip_suffix("ms") {
        (stripped, "ms")
    } else if let Some(stripped) = s.strip_suffix('s') {
        (stripped, "s")
    } else if let Some(stripped) = s.strip_suffix('m') {
        (stripped, "m")
    } else {
        (s, "ms")
    };
    let n: f64 = num.parse().unwrap_or(0.0);
    match unit {
        "ms" => n as u64,
        "s" => (n * 1000.0) as u64,
        "m" => (n * 60_000.0) as u64,
        _ => n as u64,
    }
}
