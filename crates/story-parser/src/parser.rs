//! pest-derived parser + public `parse` entrypoint.
//!
//! Pipeline:
//! 1. Try `StoryParser::parse(Rule::file, source)`
//! 2. On Ok → walk pairs into [`crate::lenient_tokenize`]
//! 3. On Err → fall back to [`crate::recover::recover_from_pest_error`]
//! 4. Pass tokens into [`crate::semantic::validate`] → `(Story, Vec<Diagnostic>)`

use pest_derive::Parser;
use serde::{Deserialize, Serialize};

use crate::ast::Story;
use crate::diagnostic::Diagnostic;

#[derive(Parser)]
#[grammar = "grammar.pest"]
pub struct StoryParser;

/// Result of parsing a `.story` source string.
///
/// `ast` is `Some` even when `diagnostics` is non-empty (best-effort AST,
/// per DSL-06 panic-mode recovery).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-export", derive(ts_rs::TS))]
#[cfg_attr(
    feature = "ts-export",
    ts(export, export_to = "../../../packages/story-dsl/src/ast.ts")
)]
pub struct ParseResult {
    pub ast: Option<Story>,
    pub diagnostics: Vec<Diagnostic>,
}

/// Parse a `.story` source string. Never panics on any byte sequence
/// (T-04-04 mitigation: input must already be valid UTF-8 — caller
/// responsibility, see [`crate::io`]).
pub fn parse(source: &str) -> ParseResult {
    use pest::Parser as _;

    // Empty input is valid: no story block.
    if source.trim().is_empty() {
        return ParseResult { ast: Some(Story::default()), diagnostics: vec![] };
    }

    match StoryParser::parse(Rule::file, source) {
        Ok(mut pairs) => {
            let file_pair = pairs.next().expect("file rule always produces one pair");
            let tokens = crate::lenient_tokenize::tokenize(file_pair);
            let (story, diagnostics) = crate::semantic::validate(tokens, source);
            ParseResult { ast: Some(story), diagnostics }
        }
        Err(err) => {
            // pest hit something it cannot tolerate. Try line-based recovery.
            let (tokens, mut diagnostics) =
                crate::recover::recover_from_pest_error(source, &err);
            let (story, more) = crate::semantic::validate(tokens, source);
            diagnostics.extend(more);
            ParseResult { ast: Some(story), diagnostics }
        }
    }
}
