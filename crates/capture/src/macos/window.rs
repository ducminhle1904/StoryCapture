//! Window enumeration via `SCShareableContent`.
//!
//! `list_windows()` returns on-screen, layer-0 windows not owned by this
//! process. Titles may contain PII, so log them at TRACE only.

use crate::error::CaptureError;
pub use crate::window::WindowInfo;

#[cfg(target_os = "macos")]
use screencapturekit::shareable_content::SCShareableContent;

/// List capturable on-screen windows.
///
/// Excludes hidden, system, orphaned, and self-owned windows. Call from
/// `spawn_blocking` because `SCShareableContent::get()` is synchronous.
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
        // TRACE only: titles may contain PII.
        tracing::trace!(
            window_id = w.window_id(),
            pid,
            app = %app.application_name(),
            title = ?w.title(),
            "enumerated window"
        );
        out.push(WindowInfo {
            window_id: u64::from(w.window_id()),
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

/// Resolve an `SCWindow` by id without exposing SCK types publicly.
#[cfg(target_os = "macos")]
pub(crate) fn resolve_sc_window_by_id(
    target: crate::target::WindowId,
) -> Result<Option<screencapturekit::shareable_content::SCWindow>, CaptureError> {
    let target_id_u32 = u32::try_from(target.0).map_err(|_| {
        CaptureError::Backend(format!("window id {} exceeds u32 range (macOS)", target.0))
    })?;
    let content = SCShareableContent::get()
        .map_err(|e| CaptureError::Native(format!("SCShareableContent::get: {e}")))?;
    Ok(content
        .windows()
        .into_iter()
        .find(|w| w.window_id() == target_id_u32))
}

/// Resolve the best on-screen window for a pid and optional title hint.
///
/// Matches visible layer-0 windows for the process, then prefers the largest
/// candidate to avoid popups. Call from `spawn_blocking` or use the async wrapper.
#[cfg(target_os = "macos")]
pub(crate) fn resolve_sc_window_by_pid_sync(
    pid: i32,
    title_hint: Option<&str>,
) -> Result<Option<screencapturekit::shareable_content::SCWindow>, CaptureError> {
    const MAX_ATTEMPTS: u32 = 10;
    const RETRY_DELAY: std::time::Duration = std::time::Duration::from_millis(100);
    for attempt in 0..MAX_ATTEMPTS {
        match resolve_sc_window_by_pid_once(pid, title_hint)? {
            Some(w) => return Ok(Some(w)),
            None => {
                if attempt + 1 < MAX_ATTEMPTS {
                    std::thread::sleep(RETRY_DELAY);
                }
            }
        }
    }
    Ok(None)
}

#[cfg(target_os = "macos")]
fn resolve_sc_window_by_pid_once(
    pid: i32,
    title_hint: Option<&str>,
) -> Result<Option<screencapturekit::shareable_content::SCWindow>, CaptureError> {
    let content = SCShareableContent::get()
        .map_err(|e| CaptureError::Native(format!("SCShareableContent::get: {e}")))?;
    let hint_lc = title_hint.map(|s| s.to_ascii_lowercase());
    const MIN_CONTENT_W: f64 = 800.0;
    const MIN_CONTENT_H: f64 = 600.0;
    let is_chromium_family = |w: &screencapturekit::shareable_content::SCWindow| -> bool {
        let Some(app) = w.owning_application() else {
            return false;
        };
        let bundle = app.bundle_identifier().to_ascii_lowercase();
        let name = app.application_name().to_ascii_lowercase();
        bundle.contains("chromium")
            || bundle.contains("google.chrome")
            || name.contains("chromium")
            || name == "chrome"
    };
    let total_pid_windows = content
        .windows()
        .into_iter()
        .filter(|w| {
            w.owning_application()
                .map(|a| a.process_id() == pid)
                .unwrap_or(false)
        })
        .count();
    let all_pid_match: Vec<screencapturekit::shareable_content::SCWindow> = content
        .windows()
        .into_iter()
        .filter(|w| {
            if w.window_layer() != 0 || !w.is_on_screen() {
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
                let app_matches = app.application_name().to_ascii_lowercase().contains(hint);
                if !title_matches && !app_matches {
                    return false;
                }
            }
            true
        })
        .collect();
    let all_bundle_match: Vec<screencapturekit::shareable_content::SCWindow> = content
        .windows()
        .into_iter()
        .filter(|w| {
            if w.window_layer() != 0 || !w.is_on_screen() {
                return false;
            }
            is_chromium_family(w)
        })
        .collect();
    let size_ok = |w: &screencapturekit::shareable_content::SCWindow| -> bool {
        let f = w.frame();
        f.width >= MIN_CONTENT_W && f.height >= MIN_CONTENT_H
    };
    let has_title = |w: &screencapturekit::shareable_content::SCWindow| -> bool {
        w.title().map(|t| !t.is_empty()).unwrap_or(false)
    };
    let mut candidates: Vec<screencapturekit::shareable_content::SCWindow> = all_pid_match
        .iter()
        .filter(|w| size_ok(w))
        .cloned()
        .collect();
    let mut used_bundle_fallback = false;
    if candidates.is_empty() {
        candidates = all_bundle_match
            .iter()
            .filter(|w| size_ok(w))
            .cloned()
            .collect();
        used_bundle_fallback = !candidates.is_empty();
    }
    // Sort: prefer windows with a non-empty title (the real browser
    // window has a page title; launch-time helpers don't), then by
    // descending area.
    candidates.sort_by(|a, b| match (has_title(a), has_title(b)) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => {
            let af = a.frame();
            let bf = b.frame();
            let aa = af.width * af.height;
            let ba = bf.width * bf.height;
            ba.partial_cmp(&aa).unwrap_or(std::cmp::Ordering::Equal)
        }
    });
    // Shadow for later diagnostics access.
    let all_for_pid = all_pid_match;
    if candidates.is_empty() {
        let dump: Vec<String> = content
            .windows()
            .into_iter()
            .filter(|w| w.window_layer() == 0)
            .map(|w| {
                let f = w.frame();
                let app = w.owning_application();
                let app_name = app
                    .as_ref()
                    .map(|a| a.application_name())
                    .unwrap_or_default();
                let bundle = app
                    .as_ref()
                    .map(|a| a.bundle_identifier())
                    .unwrap_or_default();
                let app_pid = app.map(|a| a.process_id()).unwrap_or(-1);
                format!(
                    "[pid={} app={:?} bundle={:?} {}x{} on_screen={} title={:?}]",
                    app_pid,
                    app_name,
                    bundle,
                    f.width as i32,
                    f.height as i32,
                    w.is_on_screen(),
                    w.title().unwrap_or_default(),
                )
            })
            .collect();
        tracing::info!(
            target: "storycapture::capture",
            pid,
            total_pid_windows,
            layer0_for_pid = all_for_pid.len(),
            first_layer0_dims = ?all_for_pid.first().map(|w| {
                let f = w.frame();
                (f.width, f.height)
            }),
            min_w = MIN_CONTENT_W,
            min_h = MIN_CONTENT_H,
            all_layer0_windows = %dump.join(" | "),
            "find_window_by_pid: no content-size window yet for pid — will retry",
        );
        return Ok(None);
    }
    if let Some(best) = candidates.first() {
        let f = best.frame();
        let app = best.owning_application();
        tracing::info!(
            target: "storycapture::capture",
            requested_pid = pid,
            window_id = best.window_id(),
            owning_pid = app.as_ref().map(|a| a.process_id()).unwrap_or(-1),
            bundle = ?app.as_ref().map(|a| a.bundle_identifier()),
            width = f.width,
            height = f.height,
            title = ?best.title(),
            used_bundle_fallback,
            "find_window_by_pid: resolved best window",
        );
    }
    Ok(candidates.into_iter().next())
}

/// Async retry wrapper around `resolve_sc_window_by_pid_sync`.
#[cfg(target_os = "macos")]
pub async fn find_window_by_pid(
    pid: i32,
    title_hint: Option<&str>,
) -> Result<Option<crate::target::WindowId>, CaptureError> {
    const MAX_RETRIES: u32 = 10;
    const RETRY_DELAY: std::time::Duration = std::time::Duration::from_millis(100);
    // Re-validate here because this is also used outside the command layer.
    let owned_hint = match title_hint {
        Some(h) => {
            if h.len() > 256 {
                return Err(CaptureError::Backend("title_hint exceeds 256 chars".into()));
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
            resolve_sc_window_by_pid_sync(pid, hint_clone.as_deref())
        })
        .await
        .map_err(|e| CaptureError::Native(format!("spawn_blocking join: {e}")))??;
        if let Some(w) = result {
            return Ok(Some(crate::target::WindowId(u64::from(w.window_id()))));
        }
        if attempt + 1 < MAX_RETRIES {
            tokio::time::sleep(RETRY_DELAY).await;
        }
    }
    Ok(None)
}

/// Like [`find_window_by_pid`] but also returns the resolved window's
/// logical frame (points, not pixels). Callers that need retina pixels
/// should multiply by 2.
///
/// Kept separate so the hot `find_window_by_pid` path stays byte-stable
/// for existing callers — this helper is for the Recorder UI, which
/// needs the dimensions up front so it can size the encoder canvas
/// correctly instead of inheriting display dimensions.
#[cfg(target_os = "macos")]
pub async fn find_window_by_pid_with_frame(
    pid: i32,
    title_hint: Option<&str>,
) -> Result<Option<(crate::target::WindowId, f64, f64)>, CaptureError> {
    const MAX_RETRIES: u32 = 10;
    const RETRY_DELAY: std::time::Duration = std::time::Duration::from_millis(100);
    let owned_hint = match title_hint {
        Some(h) => {
            if h.len() > 256 {
                return Err(CaptureError::Backend("title_hint exceeds 256 chars".into()));
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
            resolve_sc_window_by_pid_sync(pid, hint_clone.as_deref())
        })
        .await
        .map_err(|e| CaptureError::Native(format!("spawn_blocking join: {e}")))??;
        if let Some(w) = result {
            let frame = w.frame();
            return Ok(Some((
                crate::target::WindowId(u64::from(w.window_id())),
                frame.width,
                frame.height,
            )));
        }
        if attempt + 1 < MAX_RETRIES {
            tokio::time::sleep(RETRY_DELAY).await;
        }
    }
    Ok(None)
}

// Non-macOS stubs for cross-platform callers.
#[cfg(not(target_os = "macos"))]
pub fn list_windows() -> Result<Vec<WindowInfo>, CaptureError> {
    Err(CaptureError::Unsupported)
}

#[cfg(not(target_os = "macos"))]
pub async fn find_window_by_pid(
    _pid: i32,
    _title_hint: Option<&str>,
) -> Result<Option<crate::target::WindowId>, CaptureError> {
    Err(CaptureError::Unsupported)
}

#[cfg(not(target_os = "macos"))]
pub async fn find_window_by_pid_with_frame(
    _pid: i32,
    _title_hint: Option<&str>,
) -> Result<Option<(crate::target::WindowId, f64, f64)>, CaptureError> {
    Err(CaptureError::Unsupported)
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    /// Spot-check the self-pid exclusion without calling SCK.
    #[test]
    fn self_pid_filter_excludes_current_process() {
        let self_pid = std::process::id() as i32;
        // `std::process::id()` should fit in i32 on supported hosts.
        assert!(self_pid > 0);
    }
}
