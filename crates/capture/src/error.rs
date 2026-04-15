//! Capture error taxonomy (D-31). Pure crate — `thiserror` only, no `anyhow`,
//! no Tauri types. The host (`apps/desktop/src-tauri`) maps these into
//! `AppError` at the IPC boundary.

use crate::display::DisplayId;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum CaptureError {
    #[error("backend error: {0}")]
    Backend(String),

    #[error("screen-capture permission denied: {0}")]
    PermissionDenied(String),

    #[error("display not found: {0:?}")]
    DisplayNotFound(DisplayId),

    #[error("io error: {0}")]
    Io(String),

    #[error("native API error: {0}")]
    Native(String),

    #[error("timeout: {0}")]
    Timeout(String),

    #[error("backend not available on this platform")]
    Unsupported,
}
