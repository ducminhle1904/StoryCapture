//! Plan 06-03 — platform-agnostic thumbnail capture for the recorder's
//! live-preview feature.
//!
//! Dispatches to `macos::screenshot::capture_thumbnail`
//! (SCScreenshotManager) on macOS and `windows::thumbnail::capture_thumbnail`
//! (short-lived WGC session) on Windows. The fallback (xcap on
//! unsupported platforms / CI hosts without capture capability) returns
//! a 1×1 transparent PNG so the UI surface can still render a placeholder
//! without bubbling errors up.
//!
//! Invariants (D-16/D-17/D-18):
//!   - Static single frame per call — no continuous stream
//!   - Never upscales (`scale ≤ 1.0` inside platform impl)
//!   - 320×200 default bounds; callers may request larger up to 2× for HiDPI
//!   - All capture work runs on `spawn_blocking` — the UI thread is never blocked

use crate::error::CaptureError;
use crate::target::CaptureTarget;

/// Default thumbnail bounds matching the recorder UI's fixed frame.
pub const DEFAULT_MAX_WIDTH: u32 = 320;
pub const DEFAULT_MAX_HEIGHT: u32 = 200;

/// Capture a single thumbnail of `target` as PNG bytes.
///
/// Returns a 1×1 transparent PNG placeholder on platforms without a
/// native backend. Never errors with `Unsupported` for the UI's sake —
/// the caller (React component) treats any error as a neutral
/// placeholder, so keeping a successful "empty image" return on
/// unsupported hosts keeps the IPC surface simple.
pub async fn capture_thumbnail(
    target: &CaptureTarget,
    max_width: u32,
    max_height: u32,
) -> Result<Vec<u8>, CaptureError> {
    #[cfg(target_os = "macos")]
    {
        return crate::macos::screenshot::capture_thumbnail(target, max_width, max_height).await;
    }

    #[cfg(target_os = "windows")]
    {
        return crate::windows::thumbnail::capture_thumbnail(target, max_width, max_height).await;
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = (target, max_width, max_height);
        Ok(tiny_placeholder_png())
    }
}

/// A 1×1 transparent PNG used when the platform has no native thumbnail
/// backend. Matches the UI's "neutral placeholder" expectation.
#[allow(dead_code)]
pub fn tiny_placeholder_png() -> Vec<u8> {
    // Precomputed valid PNG (1×1 transparent RGBA) — constant so the
    // fallback path has no `image` crate dependency on non-cfg platforms.
    vec![
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1F,
        0x15, 0xC4, 0x89, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0x00,
        0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00, 0x00, 0x00, 0x00, 0x49,
        0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn placeholder_has_png_magic() {
        let p = tiny_placeholder_png();
        assert_eq!(&p[..8], b"\x89PNG\r\n\x1a\n");
    }
}
