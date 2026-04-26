//! `story-parser` — pest-based DSL grammar + AST for StoryCapture.
//!
//! **Purity guarantee:** This crate has zero Tauri dependencies. It is
//! callable from a headless CLI without modification.
//!
//! See [`parse`] for the public entrypoint.

pub mod ast;
pub mod diagnostic;
pub mod formatter;
pub mod io;
pub mod lenient_tokenize;
pub mod parser;
pub mod recover;
pub mod semantic;
pub mod suggest;

pub use ast::*;
pub use diagnostic::{Diagnostic, Severity};
pub use formatter::format_story;
pub use io::{parse_file, MAX_STORY_FILE_BYTES};
pub use parser::{parse, ParseResult, Rule};
