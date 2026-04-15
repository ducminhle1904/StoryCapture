//! Error types for the effects crate.
//!
//! `EffectsError` is the canonical error; `BuilderError` is re-exported from
//! the `builder` module as a type alias for ergonomic callers.

use crate::builder::order::CanonicalStage;

/// Errors produced by AST construction, validation, serialisation, and emission.
#[derive(thiserror::Error, Debug)]
pub enum EffectsError {
    /// A later-stage node was inserted before an earlier-stage node.
    /// `(attempted, previous_max)`.
    #[error("canonical order violated: {0:?} cannot follow {1:?}")]
    CanonicalOrderViolation(CanonicalStage, CanonicalStage),

    /// Two nodes in the same graph share the same `NodeId`.
    #[error("duplicate node id")]
    DuplicateNodeId,

    /// A referenced input label was not produced by any upstream node.
    #[error("unknown input label: {0}")]
    UnknownInputLabel(String),

    #[error("serialisation: {0}")]
    Serde(#[from] serde_json::Error),

    #[error(transparent)]
    Io(#[from] std::io::Error),
}

pub type Result<T> = std::result::Result<T, EffectsError>;
