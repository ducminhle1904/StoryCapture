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

    /// An unknown waypoint kind was encountered while loading from a storage
    /// backend (e.g. the `steps` table). Surfaced by [`crate::zoom::waypoint_source`].
    #[error("unknown waypoint kind: {0}")]
    UnknownWaypointKind(String),

    /// A SQLite-backed storage operation failed.
    #[cfg(feature = "sqlite")]
    #[error("sqlite: {0}")]
    Sqlite(#[from] rusqlite::Error),

    /// An uploaded background image exceeds the max-dimensions or max-bytes cap.
    #[error("image too large ({bytes} bytes)")]
    ImageTooLarge { bytes: u64 },

    /// An uploaded background image has an unsupported extension/MIME.
    #[error("unsupported image format: {0}")]
    UnsupportedImageFormat(String),

    /// Referenced path was empty/invalid (e.g. no file_name component).
    #[error("invalid path")]
    InvalidPath,

    /// An image-crate error during decode/validation.
    #[error("image decode: {0}")]
    ImageDecode(String),

    /// A gradient preset id was referenced that is not in the static registry.
    #[error("unknown gradient preset: {0}")]
    UnknownGradient(String),

    /// FFmpeg probe or related subprocess failure.
    #[error("ffmpeg probe: {0}")]
    FfmpegProbe(String),
}

impl From<image::ImageError> for EffectsError {
    fn from(e: image::ImageError) -> Self {
        EffectsError::ImageDecode(e.to_string())
    }
}

pub type Result<T> = std::result::Result<T, EffectsError>;
