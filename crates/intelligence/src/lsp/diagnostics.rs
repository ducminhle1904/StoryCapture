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
use story_parser::ast::{Command, SelectorOrText};
use story_parser::{parse as parse_story, Diagnostic as ParserDiag, Severity as ParserSeverity};
use tower_lsp::lsp_types::{Diagnostic, DiagnosticSeverity, NumberOrString, Range};

use crate::lsp::document::byte_range_to_lsp_range;
use crate::lsp::selector_lint;

/// Well-known verbs. Mirrors `story_parser::suggest::KNOWN_VERBS` so we
/// can produce hover/completion content without depending on a
/// yet-to-land shared catalog.
pub const VERB_CATALOG: &[(&str, &str)] = &[
    (
        "navigate",
        "`navigate <url>` — open the given URL in the target app.",
    ),
    ("click", "`click <selector|\"text\">` — click an element."),
    (
        "type",
        "`type <selector|\"text\"> \"…\"` — type text into an input.",
    ),
    (
        "scroll",
        "`scroll <up|down|left|right> [amount]` — scroll the viewport.",
    ),
    (
        "hover",
        "`hover <selector|\"text\">` — hover over an element.",
    ),
    ("drag", "`drag <from> to <to>` — drag between two targets."),
    (
        "select",
        "`select <selector|\"text\"> \"value\"` — pick a dropdown option.",
    ),
    (
        "upload",
        "`upload <selector|\"text\"> \"path\"` — attach a file to an input.",
    ),
    (
        "wait",
        "`wait <ms>` — pause for a fixed duration (milliseconds).",
    ),
    (
        "wait-for",
        "`wait-for <selector|\"text\"> [timeout <ms>]` — wait for an element to appear.",
    ),
    (
        "assert",
        "`assert <selector|\"text\">` — assert an element is visible.",
    ),
    (
        "screenshot",
        "`screenshot \"name\"` — take a named screenshot.",
    ),
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
/// missing arg, "did you mean …") plus selector-lint warnings for
/// commands that take a selector argument (click, type, hover, assert,
/// etc.). D-17 + AI-SPEC E11.
pub fn semantic_diagnostics(source: &str, rope: &Rope) -> Vec<Diagnostic> {
    let result = parse_story(source);
    let mut diags: Vec<Diagnostic> = result
        .diagnostics
        .into_iter()
        .filter(|d| !matches!(d.severity, ParserSeverity::Error))
        .map(|d| to_lsp_diag(d, rope))
        .collect();

    // Selector lint: walk the AST and lint every Selector target in
    // commands that accept selectors (click, type, hover, assert, etc.)
    if let Some(ref story) = result.ast {
        for scene in &story.scenes {
            for cmd in &scene.commands {
                lint_command_selectors(cmd, rope, &mut diags);
            }
        }
    }

    diags
}

/// Extract selector strings from a command and run the selector linter.
/// Only `SelectorOrText::Selector` variants are linted — Text, TestId,
/// and Aria targets are inherently stable and don't need heuristic checks.
fn lint_command_selectors(cmd: &Command, rope: &Rope, diags: &mut Vec<Diagnostic>) {
    let targets: Vec<(&SelectorOrText, story_parser::ast::Span)> = match cmd {
        Command::Click { target, span, .. } => vec![(target, *span)],
        Command::Type { target, span, .. } => vec![(target, *span)],
        Command::Hover { target, span, .. } => vec![(target, *span)],
        Command::Assert { target, span, .. } => vec![(target, *span)],
        Command::Select { target, span, .. } => vec![(target, *span)],
        Command::WaitFor { target, span, .. } => vec![(target, *span)],
        Command::Upload { target, span, .. } => vec![(target, *span)],
        Command::Drag { from, to, span, .. } => vec![(from, *span), (to, *span)],
        _ => vec![],
    };

    for (target, span) in targets {
        if let SelectorOrText::Selector(raw) = target {
            // The parser stores the full `selector "..."` token text.
            // Extract the inner selector value by stripping the keyword
            // prefix and surrounding quotes.
            let sel = extract_selector_value(raw);
            let warnings = selector_lint::analyze_selector(&sel, false);
            let range = byte_range_to_lsp_range(rope, span.start, span.end);
            for w in warnings {
                diags.push(selector_warning_to_diag(&w, range));
            }
        }
    }
}

/// Extract the inner CSS/XPath selector from the raw token text.
/// The parser stores `selector "..."` as the full text including
/// the keyword prefix and quotes. This strips to just the selector value.
fn extract_selector_value(raw: &str) -> String {
    let s = raw.trim();
    // Strip `selector ` prefix if present
    let s = s.strip_prefix("selector").unwrap_or(s).trim();
    // Strip surrounding quotes
    let s = s.strip_prefix('"').unwrap_or(s);
    let s = s.strip_suffix('"').unwrap_or(s);
    s.to_string()
}

fn selector_warning_to_diag(w: &selector_lint::SelectorWarning, range: Range) -> Diagnostic {
    Diagnostic {
        range,
        severity: Some(DiagnosticSeverity::WARNING),
        code: Some(NumberOrString::String("selector-lint".to_string())),
        code_description: None,
        source: Some("selector-lint".to_string()),
        message: w.message.clone(),
        related_information: None,
        tags: None,
        data: None,
    }
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
    VERB_CATALOG
        .iter()
        .find(|(v, _)| *v == ident)
        .map(|(_, d)| *d)
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

    #[test]
    fn test7_semantic_diagnostics_includes_selector_lint_warning() {
        // A .story file with a generic selector `.btn` in a click command
        // should produce a selector-lint warning in semantic_diagnostics.
        let source = "story \"test\" {\n  scene \"login\" {\n    click selector \".btn\"\n  }\n}\n";
        let rope = Rope::from_str(source);
        let diags = semantic_diagnostics(source, &rope);
        let selector_lint_diags: Vec<_> = diags
            .iter()
            .filter(|d| d.source.as_deref() == Some("selector-lint"))
            .collect();
        assert!(
            !selector_lint_diags.is_empty(),
            "expected selector-lint warnings for `.btn`, got none. All diags: {:?}",
            diags
        );
        // Should have both TooGeneric and MissingFallback warnings
        assert!(
            selector_lint_diags.len() >= 2,
            "expected at least 2 selector-lint warnings (TooGeneric + MissingFallback), got {}",
            selector_lint_diags.len()
        );
        // Verify source field
        for d in &selector_lint_diags {
            assert_eq!(d.source.as_deref(), Some("selector-lint"));
            assert_eq!(d.severity, Some(DiagnosticSeverity::WARNING));
        }
    }
}
