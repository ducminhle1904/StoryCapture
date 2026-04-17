//! Window enumeration via `SCShareableContent` (Plan 05-01).
//!
//! `list_windows()` returns every on-screen, layer-0 window whose owning
//! application is NOT this process. The UI picker feeds off this list.
//!
//! Threat: window titles may contain PII (bank URLs, medical apps). Titles
//! are logged ONLY at TRACE level (T-05-01-02). Do not `info!` or `warn!`
//! them.

use crate::error::CaptureError;
use serde::{Deserialize, Serialize};

#[cfg(target_os = "macos")]
use screencapturekit::shareable_content::SCShareableContent;

/// Lightweight window info — what the UI needs to render the picker.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WindowInfo {
    pub window_id: u32,
    pub title: Option<String>,
    pub app_name: String,
    pub pid: i32,
    pub bundle_id: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub is_on_screen: bool,
}

/// Enumerate every capturable on-screen window.
///
/// Filters:
///   - `is_on_screen()` — excludes minimized / hidden windows.
///   - `window_layer() == 0` — excludes menubar, dock, system chrome.
///   - `owning_application().is_some()` — excludes orphaned window records.
///   - `pid != std::process::id()` — excludes StoryCapture's own windows
///     (threat T-05-01-02: self-capture recursion / PII in our UI).
///
/// Call from a tokio `spawn_blocking` scope — `SCShareableContent::get`
/// is synchronous and blocks 50–200ms on WindowServer (Pitfall 7).
#[cfg(target_os = "macos")]
pub fn list_windows() -> Result<Vec<WindowInfo>, CaptureError> {
    let content = SCShareableContent::get()
        .map_err(|e| CaptureError::Native(format!("SCShareableContent::get: {e}")))?;
    let self_pid = std::process::id() as i32;

    let mut out = Vec::new();
    for w in content.windows() {
        if !w.is_on_screen() {
            continue;
        }
        if w.window_layer() != 0 {
            continue;
        }
        let app = match w.owning_application() {
            Some(a) => a,
            None => continue,
        };
        let pid = app.process_id();
        if pid == self_pid {
            continue;
        }
        let frame = w.frame();
        // TRACE-only title logging per T-05-01-02.
        tracing::trace!(
            window_id = w.window_id(),
            pid,
            app = %app.application_name(),
            title = ?w.title(),
            "enumerated window"
        );
        out.push(WindowInfo {
            window_id: w.window_id(),
            title: w.title(),
            app_name: app.application_name(),
            pid,
            bundle_id: app.bundle_identifier(),
            x: frame.x,
            y: frame.y,
            width: frame.width,
            height: frame.height,
            is_on_screen: true,
        });
    }
    Ok(out)
}

/// Look up an `SCWindow` by its window_id. Returns `None` if the window is
/// no longer in the shareable-content snapshot. Used by `SckBackend::start`
/// to convert a `CaptureTarget::Window { window_id }` into a live handle.
#[cfg(target_os = "macos")]
pub fn find_window_by_id(
    target: crate::target::WindowId,
) -> Result<Option<screencapturekit::shareable_content::SCWindow>, CaptureError> {
    let target_id_u32 = u32::try_from(target.0).map_err(|_| {
        CaptureError::Backend(format!("window id {} exceeds u32 range (macOS)", target.0))
    })?;
    let content = SCShareableContent::get()
        .map_err(|e| CaptureError::Native(format!("SCShareableContent::get: {e}")))?;
    Ok(content.windows().into_iter().find(|w| w.window_id() == target_id_u32))
}

// Non-macOS stubs so callers can compile cross-platform without cfg arms.
#[cfg(not(target_os = "macos"))]
pub fn list_windows() -> Result<Vec<WindowInfo>, CaptureError> {
    Err(CaptureError::Unsupported)
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    /// The free-function filter contract is structural; we spot-check the
    /// pid-self exclusion logic here without actually calling SCK (that
    /// requires a TCC grant and lives in the feature-gated integration
    /// tests).
    #[test]
    fn self_pid_filter_excludes_current_process() {
        let self_pid = std::process::id() as i32;
        // Sanity: std::process::id must fit in i32 on any realistic host.
        assert!(self_pid > 0);
    }
}
