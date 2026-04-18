//! Public parser entrypoint backed by pest, recovery, and semantic validation.

use pest_derive::Parser;
use serde::{Deserialize, Serialize};

use crate::ast::Story;
use crate::diagnostic::Diagnostic;

#[derive(Parser)]
#[grammar = "grammar.pest"]
pub struct StoryParser;

/// Result of parsing `.story` source.
///
/// `ast` may still be present when diagnostics were recovered.
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

/// Parse `.story` source without panicking on valid UTF-8 input.
pub fn parse(source: &str) -> ParseResult {
    use pest::Parser as _;

    // Empty input is valid.
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
            // Fall back to line-based recovery when pest stops early.
            let (tokens, mut diagnostics) =
                crate::recover::recover_from_pest_error(source, &err);
            let (story, more) = crate::semantic::validate(tokens, source);
            diagnostics.extend(more);
            ParseResult { ast: Some(story), diagnostics }
        }
    }
}
