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

    /// A `CaptureTarget` variant the current backend cannot satisfy (e.g.
    /// the xcap fallback is asked to capture a specific window).
    #[error("backend does not support target kind: {0}")]
    UnsupportedTarget(&'static str),

    /// Enumerated windows did not include the requested id — the window
    /// may have closed between enumeration and capture-start.
    #[error("window not found (id={0})")]
    WindowNotFound(u64),

    /// Backend `stop()` exceeded its bounded deadline. Caller should log
    /// and proceed with teardown rather than await indefinitely (D-03).
    #[error("capture stop timed out after {timeout_ms}ms")]
    StopTimedOut { timeout_ms: u64 },

    /// Target HWND no longer refers to a live window. Emitted by the WGC
    /// backend before calling `Window::from_raw_hwnd` so a stale pid→HWND
    /// resolution fails fast and the orchestrator can fall back to xcap
    /// instead of tripping undefined behaviour inside WGC (D-05).
    #[error("window no longer exists (hwnd={hwnd})")]
    WindowGone { hwnd: u64 },

    /// The requested [`PixelFormat`](crate::frame::PixelFormat) is not supported
    /// by the active backend. Fails loudly instead of being silently coerced.
    #[error("unsupported pixel format: {format:?}")]
    UnsupportedPixelFormat { format: crate::frame::PixelFormat },
}
