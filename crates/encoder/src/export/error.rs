//! Export-specific error variants. Converts cleanly into
//! [`crate::EncoderError`] at the orchestrator boundary.

use std::path::PathBuf;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ExportError {
    #[error("invalid fps: {0} (expected one of 24, 30, 60)")]
    InvalidFps(u32),

    /// Combination of format + resolution + fps that has no real consumer.
    /// Current rules:
    ///   - GIF at 4K (nobody wants a ~500 MB GIF)
    ///   - GIF at fps > 30 (GIF spec supports 100 fps but renderer tooling
    ///     gives brittle output above 30)
    #[error("unsupported combination of format/resolution/fps")]
    UnsupportedCombination,

    #[error("output folder is not allowed: {0}")]
    OutputFolderNotAllowed(PathBuf),

    #[error("output folder does not exist or is not a directory: {0}")]
    OutputFolderMissing(PathBuf),

    #[error("empty batch (no outputs requested)")]
    EmptyBatch,

    #[error("serialisation error: {0}")]
    Serialization(String),

    #[error("io error: {0}")]
    Io(String),

    #[error("storage error: {0}")]
    Storage(String),

    #[error("render queue send failed: {0}")]
    Queue(String),

    #[error("cursor overlay render failed: {0}")]
    CursorRender(String),

    #[error("psnr output could not be parsed")]
    PsnrParse,

    #[error("psnr fixture missing: {0}")]
    PsnrFixtureMissing(PathBuf),

    #[error("ffmpeg not available at: {0}")]
    FfmpegMissing(PathBuf),
}

impl From<std::io::Error> for ExportError {
    fn from(e: std::io::Error) -> Self {
        ExportError::Io(e.to_string())
    }
}

impl From<serde_json::Error> for ExportError {
    fn from(e: serde_json::Error) -> Self {
        ExportError::Serialization(e.to_string())
    }
}
