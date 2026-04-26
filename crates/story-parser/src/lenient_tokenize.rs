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
        /// Raw UUID text from a trailing `# @id=<uuidv7>` comment, if any.
        /// Layer 2 validates via `Uuid::parse_str`; invalid values become
        /// a warn-level diagnostic and leave `step_id` as `None`.
        step_id_raw: Option<String>,
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
    ViewportPair {
        width: u32,
        height: u32,
    },
    /// `{ width: N, height: N }` struct.
    ViewportStruct {
        width: u32,
        height: u32,
    },
}

/// Raw nth modifier as written in source. Preserved (including out-of-range
/// values like 0 or > 100) so layer 2 can lint and decide whether to keep
/// or collapse it. The `span` covers the `nth N` token pair.
#[derive(Debug, Clone, Copy)]
pub struct RawNth {
    pub value: u32,
    pub span: Span,
}

#[derive(Debug, Clone)]
pub enum ParsedCommand {
    Navigate {
        url: String,
    },
    Click {
        target: RawTarget,
        target_nth: Option<RawNth>,
    },
    Type {
        target: RawTarget,
        target_nth: Option<RawNth>,
        text: String,
    },
    Scroll {
        direction: String,
        amount: Option<f32>,
    },
    Hover {
        target: RawTarget,
        target_nth: Option<RawNth>,
    },
    Drag {
        from: RawTarget,
        from_nth: Option<RawNth>,
        to: RawTarget,
        to_nth: Option<RawNth>,
    },
    Select {
        target: RawTarget,
        target_nth: Option<RawNth>,
        value: String,
    },
    Upload {
        target: RawTarget,
        target_nth: Option<RawNth>,
        path: String,
    },
    Wait {
        duration_ms: u64,
    },
    WaitFor {
        target: RawTarget,
        target_nth: Option<RawNth>,
        timeout_ms: Option<u64>,
    },
    Assert {
        target: RawTarget,
        target_nth: Option<RawNth>,
    },
    Screenshot {
        name: String,
    },
    Pause,
}

#[derive(Debug, Clone)]
pub enum RawTarget {
    Text(String),
    Selector(String),
    TestId(String),
    Aria(String),
    /// `<role> "name"`. `role` is kept stringly-typed at
    /// layer 1; layer 2 (`semantic.rs`) validates against `AriaRole` and
    /// emits a did-you-mean diagnostic on miss.
    Role {
        role: String,
        name: String,
    },
    /// `field "Label"`.
    Label(String),
    /// `text "Verbatim"` — distinct from bare `Text`.
    TextExact(String),
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
    MetaEntry {
        key,
        key_span,
        value,
        value_span,
        entry_span,
    }
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
                let w: u32 = nums
                    .next()
                    .and_then(|n| n.as_str().parse().ok())
                    .unwrap_or(0);
                let h: u32 = nums
                    .next()
                    .and_then(|n| n.as_str().parse().ok())
                    .unwrap_or(0);
                MetaRawValue::ViewportStruct {
                    width: w,
                    height: h,
                }
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
                            // Collect children once so we can look at the
                            // `command` pair AND the optional `step_id_comment`.
                            let children: Vec<_> = stmt_child.into_inner().collect();
                            let step_id_raw = children
                                .iter()
                                .find(|p| p.as_rule() == Rule::step_id_comment)
                                .and_then(|sic| {
                                    sic.clone()
                                        .into_inner()
                                        .find(|c| c.as_rule() == Rule::uuidv7_text)
                                        .map(|t| t.as_str().to_string())
                                });
                            if let Some(cmd) =
                                children.into_iter().find(|p| p.as_rule() == Rule::command)
                            {
                                if let Some(parsed) = parse_command(cmd) {
                                    out.push(LenientToken::Command {
                                        pair_kind: parsed,
                                        span: line_span,
                                        step_id_raw,
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
        Rule::cmd_click => {
            let (target, target_nth) = parse_target(cmd);
            ParsedCommand::Click { target, target_nth }
        }
        Rule::cmd_fill => {
            // `fill <target> with "<text>"` desugars to Type at layer 1.
            // No new ParsedCommand variant — the executor sees an
            // ordinary Type.
            let mut inner = cmd.into_inner();
            let (target, target_nth) = parse_target_pair(inner.next()?);
            let text = unquote(inner.next()?.as_str());
            ParsedCommand::Type {
                target,
                target_nth,
                text,
            }
        }
        Rule::cmd_type => {
            let mut inner = cmd.into_inner();
            let (target, target_nth) = parse_target_pair(inner.next()?);
            let text = unquote(inner.next()?.as_str());
            ParsedCommand::Type {
                target,
                target_nth,
                text,
            }
        }
        Rule::cmd_scroll => {
            let mut inner = cmd.into_inner();
            let direction = inner.next()?.as_str().to_string();
            let amount = inner.next().and_then(|n| n.as_str().parse().ok());
            ParsedCommand::Scroll { direction, amount }
        }
        Rule::cmd_hover => {
            let (target, target_nth) = parse_target(cmd);
            ParsedCommand::Hover { target, target_nth }
        }
        Rule::cmd_drag => {
            let mut inner = cmd.into_inner();
            let (from, from_nth) = parse_target_pair(inner.next()?);
            let (to, to_nth) = parse_target_pair(inner.next()?);
            ParsedCommand::Drag {
                from,
                from_nth,
                to,
                to_nth,
            }
        }
        Rule::cmd_select => {
            let mut inner = cmd.into_inner();
            let (target, target_nth) = parse_target_pair(inner.next()?);
            let value = unquote(inner.next()?.as_str());
            ParsedCommand::Select {
                target,
                target_nth,
                value,
            }
        }
        Rule::cmd_upload => {
            let mut inner = cmd.into_inner();
            let (target, target_nth) = parse_target_pair(inner.next()?);
            let path = unquote(inner.next()?.as_str());
            ParsedCommand::Upload {
                target,
                target_nth,
                path,
            }
        }
        Rule::cmd_wait => {
            let dur = cmd.into_inner().find(|p| p.as_rule() == Rule::duration)?;
            ParsedCommand::Wait {
                duration_ms: parse_duration(dur.as_str()),
            }
        }
        Rule::cmd_wait_for => {
            let mut inner = cmd.into_inner().peekable();
            let (target, target_nth) = parse_target_pair(inner.next()?);
            let timeout_ms = inner
                .find(|p| p.as_rule() == Rule::duration)
                .map(|d| parse_duration(d.as_str()));
            ParsedCommand::WaitFor {
                target,
                target_nth,
                timeout_ms,
            }
        }
        Rule::cmd_assert => {
            let (target, target_nth) = parse_target(cmd);
            ParsedCommand::Assert { target, target_nth }
        }
        Rule::cmd_screenshot => {
            let name = first_string(cmd);
            ParsedCommand::Screenshot { name }
        }
        Rule::cmd_pause => ParsedCommand::Pause,
        _ => return None,
    })
}

fn parse_target(cmd_pair: Pair<Rule>) -> (RawTarget, Option<RawNth>) {
    let target = cmd_pair.into_inner().find(|p| p.as_rule() == Rule::target);
    match target {
        Some(t) => parse_target_pair(t),
        None => (RawTarget::Text(String::new()), None),
    }
}

fn parse_target_pair(pair: Pair<Rule>) -> (RawTarget, Option<RawNth>) {
    // `target` is now `(target_inner ~ nth_modifier?)` so we walk both.
    // The raw nth value (including 0 / very large) flows through to layer 2
    // which lints and decides whether to keep it. Span covers the entire
    // `nth N` token so diagnostics can highlight it precisely.
    let mut raw: RawTarget = RawTarget::Text(String::new());
    let mut nth: Option<RawNth> = None;
    for child in pair.into_inner() {
        match child.as_rule() {
            Rule::target_text => raw = RawTarget::Text(first_string(child)),
            Rule::target_selector => raw = RawTarget::Selector(first_string(child)),
            Rule::target_testid => raw = RawTarget::TestId(first_string(child)),
            Rule::target_aria => raw = RawTarget::Aria(first_string(child)),
            Rule::target_role => {
                let inner: Vec<_> = child.into_inner().collect();
                let role = inner
                    .iter()
                    .find(|c| c.as_rule() == Rule::role_kw)
                    .map(|r| r.as_str().to_string())
                    .unwrap_or_default();
                let name = inner
                    .iter()
                    .find(|c| c.as_rule() == Rule::string)
                    .map(|s| unquote(s.as_str()))
                    .unwrap_or_default();
                raw = RawTarget::Role { role, name };
            }
            Rule::target_field => raw = RawTarget::Label(first_string(child)),
            Rule::target_text_kw => raw = RawTarget::TextExact(first_string(child)),
            Rule::nth_modifier => {
                // `nth N` — capture span + the inner number_lit value.
                let span = Span::from_pair(&child);
                if let Some(n) = child
                    .into_inner()
                    .find(|p| p.as_rule() == Rule::number_lit)
                    .and_then(|p| p.as_str().parse::<u32>().ok())
                {
                    // Preserve raw (including 0); semantic.rs validates.
                    nth = Some(RawNth { value: n, span });
                }
            }
            _ => {}
        }
    }
    (raw, nth)
}

fn first_string(pair: Pair<Rule>) -> String {
    pair.into_inner()
        .find(|p| p.as_rule() == Rule::string)
        .map(|s| unquote(s.as_str()))
        .unwrap_or_default()
}

fn unquote(s: &str) -> String {
    let trimmed = s.trim();
    let inner = trimmed
        .strip_prefix('"')
        .and_then(|x| x.strip_suffix('"'))
        .unwrap_or(trimmed);
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
