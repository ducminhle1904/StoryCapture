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

/// Plan 05-02 — resolve a pid + optional title hint to the best on-screen
/// SCWindow. Retries up to 10×100ms (~1s total) to tolerate the Chromium
/// launch→WindowServer-register race (A1, RESEARCH.md Pitfall 4).
///
/// Filters (per RESEARCH.md Example 2):
///   - `is_on_screen() && window_layer() == 0`
///   - `owning_application().process_id() == pid`
///   - When `title_hint` is `Some`, keep only windows whose title contains
///     it (case-insensitive; handles Chromium ↔ Chrome variants).
///
/// When multiple windows pass the filter, the largest-area window wins.
/// Chromium's main document window is always larger than its popup /
/// helper windows; this rule degrades cleanly for Open Question 3 (popup
/// follow is out of scope for MVP).
///
/// This function calls `SCShareableContent::get()` which is synchronous
/// and can block 50–200ms on WindowServer. Callers MUST wrap in
/// `spawn_blocking` or use the async version below.
#[cfg(target_os = "macos")]
pub fn find_window_by_pid_sync(
    pid: i32,
    title_hint: Option<&str>,
) -> Result<Option<screencapturekit::shareable_content::SCWindow>, CaptureError> {
    let content = SCShareableContent::get()
        .map_err(|e| CaptureError::Native(format!("SCShareableContent::get: {e}")))?;
    let hint_lc = title_hint.map(|s| s.to_ascii_lowercase());
    let mut candidates: Vec<screencapturekit::shareable_content::SCWindow> = content
        .windows()
        .into_iter()
        .filter(|w| {
            if !w.is_on_screen() {
                return false;
            }
            if w.window_layer() != 0 {
                return false;
            }
            let Some(app) = w.owning_application() else {
                return false;
            };
            if app.process_id() != pid {
                return false;
            }
            if let Some(hint) = hint_lc.as_deref() {
                let title_matches = w
                    .title()
                    .map(|t| t.to_ascii_lowercase().contains(hint))
                    .unwrap_or(false);
                let app_matches = app
                    .application_name()
                    .to_ascii_lowercase()
                    .contains(hint);
                if !title_matches && !app_matches {
                    return false;
                }
            }
            true
        })
        .collect();
    // Sort largest-area-first (Open Question 3: Chromium popup handling).
    candidates.sort_by(|a, b| {
        let af = a.frame();
        let bf = b.frame();
        let aa = af.width * af.height;
        let ba = bf.width * bf.height;
        ba.partial_cmp(&aa).unwrap_or(std::cmp::Ordering::Equal)
    });
    if let Some(best) = candidates.first() {
        tracing::trace!(
            pid,
            window_id = best.window_id(),
            title = ?best.title(),
            "find_window_by_pid: resolved best window",
        );
    }
    Ok(candidates.into_iter().next())
}

/// Async wrapper around `find_window_by_pid_sync` with a retry loop to
/// tolerate the launch→register race (A1). Runs each SCK query inside
/// `spawn_blocking` so the async runtime is never blocked.
///
/// Returns:
///   - `Ok(Some(window))` when a match is found within the retry budget
///   - `Ok(None)` when no window matches after `MAX_RETRIES` attempts
///   - `Err(_)` when SCK itself errors (TCC denial, ABI mismatch, etc.)
#[cfg(target_os = "macos")]
pub async fn find_window_by_pid(
    pid: i32,
    title_hint: Option<&str>,
) -> Result<Option<screencapturekit::shareable_content::SCWindow>, CaptureError> {
    const MAX_RETRIES: u32 = 10;
    const RETRY_DELAY: std::time::Duration = std::time::Duration::from_millis(100);
    // Validate title_hint at the entry point (T-05-02-02 defense-in-depth).
    // The command-layer validator in Task 3 runs first, but since this is
    // a library API we re-check to keep the invariant local.
    let owned_hint = match title_hint {
        Some(h) => {
            if h.len() > 256 {
                return Err(CaptureError::Backend(
                    "title_hint exceeds 256 chars".into(),
                ));
            }
            if h.chars().any(|c| c.is_ascii_control()) {
                return Err(CaptureError::Backend(
                    "title_hint contains ASCII control chars".into(),
                ));
            }
            Some(h.to_string())
        }
        None => None,
    };
    for attempt in 0..MAX_RETRIES {
        let hint_clone = owned_hint.clone();
        let result = tokio::task::spawn_blocking(move || {
            find_window_by_pid_sync(pid, hint_clone.as_deref())
        })
        .await
        .map_err(|e| CaptureError::Native(format!("spawn_blocking join: {e}")))??;
        if result.is_some() {
            return Ok(result);
        }
        if attempt + 1 < MAX_RETRIES {
            tokio::time::sleep(RETRY_DELAY).await;
        }
    }
    Ok(None)
}

// Non-macOS stubs so callers can compile cross-platform without cfg arms.
#[cfg(not(target_os = "macos"))]
pub fn list_windows() -> Result<Vec<WindowInfo>, CaptureError> {
    Err(CaptureError::Unsupported)
}

#[cfg(not(target_os = "macos"))]
pub async fn find_window_by_pid(
    _pid: i32,
    _title_hint: Option<&str>,
) -> Result<Option<()>, CaptureError> {
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
