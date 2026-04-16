//! Source → `lsp_types::Diagnostic` mapping for `.story` files.
//!
//! Delegates to [`story_parser::parse`] which already emits both
//! grammar-level and semantic-level diagnostics (unknown verb, arity,
//! etc.) with "did you mean" suggestions from `strsim`. We split the
//! output by severity for callers that want the two layers separately.
//!
//! D-17: diagnostic scope is grammar + semantic (undefined verb /
//! missing-required-arg). Per the Phase-1 parser, this is already the
//! set of diagnostics produced by `story_parser::parse`.

use ropey::Rope;
use story_parser::{parse as parse_story, Diagnostic as ParserDiag, Severity as ParserSeverity};
use tower_lsp::lsp_types::{Diagnostic, DiagnosticSeverity, NumberOrString};

use crate::lsp::document::byte_range_to_lsp_range;

/// Well-known verbs. Mirrors `story_parser::suggest::KNOWN_VERBS` so we
/// can produce hover/completion content without depending on a
/// yet-to-land shared catalog.
pub const VERB_CATALOG: &[(&str, &str)] = &[
    ("navigate", "`navigate <url>` — open the given URL in the target app."),
    ("click", "`click <selector|\"text\">` — click an element."),
    ("type", "`type <selector|\"text\"> \"…\"` — type text into an input."),
    ("scroll", "`scroll <up|down|left|right> [amount]` — scroll the viewport."),
    ("hover", "`hover <selector|\"text\">` — hover over an element."),
    ("drag", "`drag <from> to <to>` — drag between two targets."),
    ("select", "`select <selector|\"text\"> \"value\"` — pick a dropdown option."),
    ("upload", "`upload <selector|\"text\"> \"path\"` — attach a file to an input."),
    ("wait", "`wait <ms>` — pause for a fixed duration (milliseconds)."),
    ("wait-for", "`wait-for <selector|\"text\"> [timeout <ms>]` — wait for an element to appear."),
    ("assert", "`assert <selector|\"text\">` — assert an element is visible."),
    ("screenshot", "`screenshot \"name\"` — take a named screenshot."),
    ("pause", "`pause` — pause story execution until resumed."),
];

/// Produce the full diagnostic set for `source`, already mapped to LSP
/// types. Convenience wrapper: equivalent to running
/// [`story_parser::parse`] and translating each diagnostic.
pub fn diagnose(source: &str, rope: &Rope) -> Vec<Diagnostic> {
    let result = parse_story(source);
    result
        .diagnostics
        .into_iter()
        .map(|d| to_lsp_diag(d, rope))
        .collect()
}

/// Grammar-level subset (ERROR severity).
pub fn grammar_diagnostics(source: &str, rope: &Rope) -> Vec<Diagnostic> {
    parse_story(source)
        .diagnostics
        .into_iter()
        .filter(|d| matches!(d.severity, ParserSeverity::Error))
        .map(|d| to_lsp_diag(d, rope))
        .collect()
}

/// Semantic-level subset (WARNING / INFO severity — unknown verb,
/// missing arg, "did you mean …").
pub fn semantic_diagnostics(source: &str, rope: &Rope) -> Vec<Diagnostic> {
    parse_story(source)
        .diagnostics
        .into_iter()
        .filter(|d| !matches!(d.severity, ParserSeverity::Error))
        .map(|d| to_lsp_diag(d, rope))
        .collect()
}

fn to_lsp_diag(d: ParserDiag, rope: &Rope) -> Diagnostic {
    let mut message = d.message.clone();
    let is_unknown_verb = is_unknown_verb_diag(&d);

    if let Some(sugg) = &d.suggestion {
        // Normalize message to always contain "Did you mean 'X'?" casing
        // the LSP surface expects. The parser emits a lowercase "did you
        // mean" phrasing in some paths — canonicalize.
        if !message.contains("Did you mean") {
            if message.to_ascii_lowercase().contains("did you mean") {
                // Re-case only the first occurrence.
                if let Some(idx) = message.to_ascii_lowercase().find("did you mean") {
                    let before = &message[..idx];
                    let after = &message[idx + "did you mean".len()..];
                    message = format!("{before}Did you mean{after}");
                }
            } else {
                message = format!("{message} Did you mean '{sugg}'?");
            }
        }
    }

    // D-17: unknown-verb / semantic diagnostics are surfaced to the LSP as
    // WARNING even when the underlying parser emits them as Error — they
    // represent recoverable semantic issues, not grammar failures.
    let severity = if is_unknown_verb {
        DiagnosticSeverity::WARNING
    } else {
        match d.severity {
            ParserSeverity::Error => DiagnosticSeverity::ERROR,
            ParserSeverity::Warning => DiagnosticSeverity::WARNING,
            ParserSeverity::Info => DiagnosticSeverity::INFORMATION,
        }
    };

    let range = byte_range_to_lsp_range(rope, d.span.start, d.span.end);

    Diagnostic {
        range,
        severity: Some(severity),
        code: Some(NumberOrString::String(code_for(&d, is_unknown_verb))),
        code_description: None,
        source: Some("story-parser".to_string()),
        message,
        related_information: None,
        tags: None,
        data: None,
    }
}

/// A diagnostic is classified as "unknown verb" when the parser's message
/// flags an unknown command/verb token. These are semantic (recoverable),
/// not grammar, per D-17, and are surfaced as WARNING regardless of
/// whether a Levenshtein suggestion was found.
fn is_unknown_verb_diag(d: &ParserDiag) -> bool {
    let lower = d.message.to_ascii_lowercase();
    lower.contains("unknown command")
        || lower.contains("unknown verb")
        || lower.contains("did you mean")
}

fn code_for(d: &ParserDiag, is_unknown_verb: bool) -> String {
    if is_unknown_verb {
        return "unknown-verb".to_string();
    }
    match d.severity {
        ParserSeverity::Error => "grammar".to_string(),
        ParserSeverity::Warning => "semantic".to_string(),
        ParserSeverity::Info => "info".to_string(),
    }
}

/// Lookup the Markdown-ish doc for a verb identifier; returns `None` if
/// the identifier is not a known verb.
pub fn verb_doc(ident: &str) -> Option<&'static str> {
    VERB_CATALOG.iter().find(|(v, _)| *v == ident).map(|(_, d)| *d)
}

/// List of verb identifiers for completion.
pub fn verb_list() -> Vec<&'static str> {
    VERB_CATALOG.iter().map(|(v, _)| *v).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verb_catalog_covers_known_verbs() {
        for v in story_parser::suggest::KNOWN_VERBS {
            assert!(verb_doc(v).is_some(), "missing doc for {v}");
        }
    }
}
