//! Language server surface for `.story` files.
//!
//! In-process `tower-lsp` implementation that reuses
//! [`story_parser::parse`] directly (D-16). The IPC bridge lives in a
//! later plan; this module exposes the `LanguageServer` trait impl and
//! an in-memory testable facade.
//!
//! Diagnostic scope (D-17):
//! - grammar errors from pest
//! - semantic errors already emitted by `story_parser::semantic` (unknown
//!   verb with "did you mean" suggestion, arity, etc.)
//!
//! Module layout:
//! - [`server`]: `StoryLanguageServer` — the `LanguageServer` impl.
//! - [`diagnostics`]: pest/semantic diagnostic → `lsp_types::Diagnostic` mapping.
//! - [`document`]: Rope wrapper + position/offset helpers.

pub mod diagnostics;
pub mod document;
pub mod server;

pub use server::StoryLanguageServer;
