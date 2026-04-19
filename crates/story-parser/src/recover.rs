//! Panic-mode recovery (D-09): when pest returns a hard error, we rebuild
//! a best-effort lenient token stream by scanning the source line by line
//! so that the semantic layer can still report multiple diagnostics from
//! a single `parse()` call.

use crate::ast::Span;
use crate::diagnostic::Diagnostic;
use crate::lenient_tokenize::LenientToken;
use crate::parser::Rule;

/// Best-effort fallback when the pest grammar rejects the input outright.
///
/// We emit:
/// - a single `Diagnostic::error` describing the pest failure (with the
///   approximate location it pointed at), and
/// - a stream of `LenientToken::Unknown` covering every non-blank line
///   that doesn't open or close a `meta`/`scene`/`story` block.
///
/// The semantic layer then iterates the unknown tokens producing one
/// diagnostic per offending line — which is the multi-error UX guaranteed
/// by DSL-06.
pub fn recover_from_pest_error(
    source: &str,
    err: &pest::error::Error<Rule>,
) -> (Vec<LenientToken>, Vec<Diagnostic>) {
    let (line, col) = match err.line_col {
        pest::error::LineColLocation::Pos((l, c)) => (l as u32, c as u32),
        pest::error::LineColLocation::Span((l, c), _) => (l as u32, c as u32),
    };
    let approx_offset = approximate_offset(source, line as usize, col as usize);
    let span = Span {
        start: approx_offset,
        end: (approx_offset + 1).min(source.len()),
        line,
        col,
    };
    let diag = Diagnostic::error(format!("parse error: {}", err.variant.message()), span);

    let mut tokens = Vec::new();
    // Always emit a minimal StoryStart / StoryEnd so downstream code has
    // a Story to attach scenes to.
    tokens.push(LenientToken::StoryStart {
        name: None,
        span: Span {
            start: 0,
            end: 0,
            line: 1,
            col: 1,
        },
    });

    // Scan line-by-line for command-shaped fragments and emit Unknowns.
    let mut in_scene = false;
    let mut current_scene_started = false;
    let mut byte_offset = 0usize;
    for (line_idx, raw_line) in source.lines().enumerate() {
        let trimmed = raw_line.trim();
        let line_no = (line_idx + 1) as u32;
        let line_span = Span {
            start: byte_offset,
            end: byte_offset + raw_line.len(),
            line: line_no,
            col: 1,
        };
        byte_offset += raw_line.len() + 1; // +1 for newline

        if trimmed.is_empty() || trimmed.starts_with('#') || trimmed.starts_with("//") {
            continue;
        }
        if trimmed.starts_with("story") || trimmed.starts_with("meta") {
            continue;
        }
        if trimmed.starts_with("scene") {
            in_scene = true;
            current_scene_started = true;
            tokens.push(LenientToken::SceneStart {
                name: extract_scene_name(trimmed).unwrap_or_default(),
                span: line_span,
            });
            continue;
        }
        if trimmed == "}" {
            if in_scene && current_scene_started {
                tokens.push(LenientToken::SceneEnd);
                current_scene_started = false;
                in_scene = false;
            }
            continue;
        }
        if trimmed == "{" {
            continue;
        }
        // Treat as unknown command so semantic + suggest can suggest.
        tokens.push(LenientToken::Unknown {
            text: trimmed.to_string(),
            span: line_span,
        });
    }
    if current_scene_started {
        tokens.push(LenientToken::SceneEnd);
    }
    tokens.push(LenientToken::StoryEnd);

    (tokens, vec![diag])
}

fn extract_scene_name(line: &str) -> Option<String> {
    let q1 = line.find('"')?;
    let rest = &line[q1 + 1..];
    let q2 = rest.find('"')?;
    Some(rest[..q2].to_string())
}

fn approximate_offset(source: &str, line: usize, col: usize) -> usize {
    let mut current_line = 1usize;
    let mut offset = 0usize;
    for ch in source.chars() {
        if current_line == line {
            return offset + col.saturating_sub(1);
        }
        if ch == '\n' {
            current_line += 1;
        }
        offset += ch.len_utf8();
    }
    source.len()
}
