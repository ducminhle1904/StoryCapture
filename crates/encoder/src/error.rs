//! Encoder error taxonomy (D-31). `EncoderError` is a `thiserror` enum that
//! every public API on the crate returns. The Tauri host wraps it into
//! `AppError::Encoder(String)` at the IPC boundary.

use thiserror::Error;

#[derive(Debug, Error)]
pub enum EncoderError {
    #[error("failed to spawn ffmpeg sidecar: {0}")]
    SpawnFailed(String),

    /// FFmpeg exited non-zero. `stderr_tail` is the last ~2 KiB of stderr
    /// captured before exit so the UI can surface a useful diagnostic.
    #[error("ffmpeg exited with status {code}: {stderr_tail}")]
    FfmpegExit { code: i32, stderr_tail: String },

    #[error("no hardware or software encoder available: {0}")]
    NoEncoderAvailable(String),

    #[error("io error: {0}")]
    Io(String),

    #[error("invalid encode config: {0}")]
    InvalidConfig(String),

    #[error("timeout: {0}")]
    Timeout(String),

    #[error("probe failed: {0}")]
    ProbeFailed(String),

    #[error("invalid filter spec: {0}")]
    InvalidFilterSpec(String),
}

impl From<std::io::Error> for EncoderError {
    fn from(e: std::io::Error) -> Self {
        EncoderError::Io(e.to_string())
    }
}

pub type Result<T> = std::result::Result<T, EncoderError>;
