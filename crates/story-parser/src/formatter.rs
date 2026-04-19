//! Minimal DSL formatter for the Story DSL.
//!
//! **Scope:** serializes a parsed [`Story`] back to DSL text such that a
//! parse → format → parse cycle is a structural fixpoint on the AST
//! (ignoring source spans). Preserves:
//!
//! - `story "<name>" { ... }` + `scene "<name>" { ... }` structure
//! - `meta { ... }` entries (app, viewport, theme, speed)
//! - All command variants and every [`SelectorOrText`] target form,
//!   including Tier 1 role/field/text-exact forms
//! - Trailing `# @id=<uuidv7>` step-id comments (plan 07-04b)
//! - Indentation: scenes at 2 spaces, commands at 4 spaces, meta entries
//!   at 4 spaces
//!
//! **Known limitation — not in scope (documented by design):**
//!
//! - Free-form user comments (anything starting with `#` that is NOT a
//!   `# @id=<uuidv7>` step-id comment) are NOT preserved. This formatter
//!   is invoked only when writing step ids back to `.story` source after
//!   a first pick (plan 07-04c territory); user-authored files are not
//!   auto-formatted.
//! - Blank lines between scenes / commands are NOT preserved — output
//!   has canonical whitespace.
//!
//! Invoke via [`format_story`].

use std::fmt::Write;

use crate::ast::{AriaRole, Command, Meta, ScrollDir, SelectorOrText, Story, Theme, Viewport};

/// Format a [`Story`] as DSL text.
///
/// The produced string always re-parses via [`crate::parse`] to an AST
/// structurally equal to the input (modulo [`crate::ast::Span`] byte
/// offsets). See `tests/round_trip.rs` for the fixpoint assertions.
pub fn format_story(story: &Story) -> String {
    let mut out = String::new();
    match &story.name {
        Some(name) => {
            let _ = writeln!(out, "story {} {{", dsl_quote(name));
        }
        None => {
            let _ = writeln!(out, "story {{");
        }
    }
    format_meta(&mut out, &story.meta);
    for scene in &story.scenes {
        let _ = writeln!(out, "  scene {} {{", dsl_quote(&scene.name));
        for cmd in &scene.commands {
            format_command(&mut out, cmd);
        }
        let _ = writeln!(out, "  }}");
    }
    let _ = writeln!(out, "}}");
    out
}

fn format_meta(out: &mut String, meta: &Meta) {
    // Emit only if at least one field is set — the parser's `Meta::default`
    // is structurally equivalent to an absent meta block.
    if meta.app.is_none() && meta.viewport.is_none() && meta.theme.is_none() && meta.speed.is_none()
    {
        return;
    }
    let _ = writeln!(out, "  meta {{");
    if let Some(app) = &meta.app {
        let _ = writeln!(out, "    app: {}", dsl_quote(app));
    }
    if let Some(Viewport { width, height }) = meta.viewport {
        let _ = writeln!(out, "    viewport: {}x{}", width, height);
    }
    if let Some(theme) = meta.theme {
        let keyword = match theme {
            Theme::Light => "light",
            Theme::Dark => "dark",
            Theme::Auto => "auto",
        };
        let _ = writeln!(out, "    theme: {}", keyword);
    }
    if let Some(speed) = meta.speed {
        // `speed` is an f32 — emit just enough precision for round-trip.
        let _ = writeln!(out, "    speed: {}", speed);
    }
    let _ = writeln!(out, "  }}");
}

fn format_command(out: &mut String, cmd: &Command) {
    let line = match cmd {
        Command::Navigate { url, .. } => format!("navigate {}", dsl_quote(url)),
        Command::Click { target, .. } => format!("click {}", format_target(target)),
        Command::Type { target, text, .. } => {
            format!("type {} {}", format_target(target), dsl_quote(text))
        }
        Command::Scroll {
            direction, amount, ..
        } => {
            let dir = match direction {
                ScrollDir::Up => "up",
                ScrollDir::Down => "down",
                ScrollDir::Left => "left",
                ScrollDir::Right => "right",
            };
            match amount {
                Some(a) => format!("scroll {} {}", dir, a),
                None => format!("scroll {}", dir),
            }
        }
        Command::Hover { target, .. } => format!("hover {}", format_target(target)),
        Command::Drag { from, to, .. } => {
            format!("drag {} to {}", format_target(from), format_target(to))
        }
        Command::Select { target, value, .. } => {
            format!("select {} {}", format_target(target), dsl_quote(value))
        }
        Command::Upload { target, path, .. } => {
            format!("upload {} {}", format_target(target), dsl_quote(path))
        }
        Command::Wait { duration_ms, .. } => format!("wait {}ms", duration_ms),
        Command::WaitFor {
            target, timeout_ms, ..
        } => match timeout_ms {
            Some(t) => format!("wait-for {} timeout {}ms", format_target(target), t),
            None => format!("wait-for {}", format_target(target)),
        },
        Command::Assert { target, .. } => format!("assert {}", format_target(target)),
        Command::Screenshot { name, .. } => format!("screenshot {}", dsl_quote(name)),
        Command::Pause { .. } => "pause".to_string(),
    };
    let _ = write!(out, "    {}", line);
    if let Some(id) = cmd.step_id() {
        let _ = write!(out, "  # @id={}", id);
    }
    let _ = writeln!(out);
}

fn format_target(t: &SelectorOrText) -> String {
    match t {
        SelectorOrText::Text(s) => dsl_quote(s),
        SelectorOrText::Selector(s) => format!("selector {}", dsl_quote(s)),
        SelectorOrText::TestId(s) => format!("testid {}", dsl_quote(s)),
        SelectorOrText::Aria(s) => format!("aria {}", dsl_quote(s)),
        SelectorOrText::Role { role, name } => {
            format!("{} {}", role_keyword(*role), dsl_quote(name))
        }
        SelectorOrText::Label(s) => format!("field {}", dsl_quote(s)),
        SelectorOrText::TextExact(s) => format!("text {}", dsl_quote(s)),
    }
}

fn role_keyword(role: AriaRole) -> &'static str {
    // Mirrors `grammar.pest::role_kw`. Note `AriaRole::Image` round-trips as
    // the canonical `image` spelling (the `img` alias is accepted on input
    // but both map to the same variant, so we emit the canonical form).
    role.as_kebab()
}

/// Quote and escape a string for DSL output.
///
/// Mirrors the DSL's quoted-string escape rules: backslash-escapes `"` and
/// `\`. Does NOT attempt to re-emit `\n` / `\t` escapes — the lenient
/// tokenizer converts those to literal characters on parse, so a literal
/// tab/newline is the correct byte-for-byte round-trip representation.
fn dsl_quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            other => out.push(other),
        }
    }
    out.push('"');
    out
}
