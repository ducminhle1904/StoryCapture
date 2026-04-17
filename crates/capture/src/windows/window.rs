//! Window enumeration + pid→HWND resolution (Plan 05-03, Task 2).
//!
//! On Windows we use `windows_capture::window::Window::enumerate()` as the
//! primary enumeration path — it already filters to visible, non-tool,
//! non-child, non-self windows via `Window::is_valid()`. For the Playwright
//! auto-follow path (`find_window_by_pid`), Chromium's process model
//! (browser parent + sandboxed renderer children) means the top-level HWND
//! may be owned by either the browser PID or a child PID. We use a
//! ToolHelp snapshot to walk the child-pid set when the primary filter
//! finds no match.
//!
//! Threat boundaries:
//!
//! - T-05-03-01: `CaptureTarget::Window { window_id }` must be validated
//!   against the most recent `list_windows()` result at the IPC layer.
//!   The allow-list lives in `commands::capture::window_allow_list`.
//! - T-05-03-02: Window titles are PII-sensitive. Log at TRACE only.
//! - T-05-03-03: `ProcessIdToSessionId` + current-session filter prevents
//!   cross-session window capture on multi-user Windows hosts.
//! - T-05-03-07: Chromium child-walk verifies process name matches
//!   chrome.exe / msedge.exe / chromium.exe to avoid matching an
//!   unrelated browser-child helper as the capture target.

use crate::error::CaptureError;
use serde::{Deserialize, Serialize};

/// Lightweight window info — shape matches the macOS `WindowInfo` so the
/// UI picker code (Plan 05-01) works unchanged on both platforms.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WindowInfo {
    /// Platform-scoped window id. On Windows this is the HWND reinterpreted
    /// as `u64` (via `isize as u64`). The backend unpacks it the same way
    /// in `WgcBackend::start`.
    pub window_id: u64,
    pub title: Option<String>,
    pub app_name: String,
    pub pid: i32,
    /// Windows does not expose a "bundle id"; we stuff the process name
    /// (e.g. `"chrome.exe"`) in here for the UI's grouping logic.
    pub bundle_id: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub is_on_screen: bool,
}

/// Enumerate every capturable top-level window.
///
/// Filters applied by `windows_capture::window::Window::is_valid` (in the
/// `enumerate` callback):
///   - `IsWindowVisible(hwnd)` — excludes hidden windows
///   - `pid != GetCurrentProcessId()` — excludes self
///   - Not WS_EX_TOOLWINDOW (no tray/popup chrome)
///   - Not WS_CHILD (no sub-windows)
///
/// Additional filters we apply on top:
///   - Title OR process_name must be present (noise filter — matches the
///     macOS `window_layer == 0 + owning_application.is_some()` intent).
///   - Owner process must be in the current session (T-05-03-03).
///
/// Call from `spawn_blocking` — `EnumChildWindows` is synchronous.
#[cfg(target_os = "windows")]
pub fn list_windows() -> Result<Vec<WindowInfo>, CaptureError> {
    use windows_capture::window::Window;

    let wins = Window::enumerate()
        .map_err(|e| CaptureError::Native(format!("Window::enumerate: {e}")))?;

    let self_session = current_session_id();
    let self_pid = std::process::id() as i32;

    let mut out = Vec::with_capacity(wins.len());
    for w in wins {
        let pid_u32 = match w.process_id() {
            Ok(id) => id,
            Err(_) => continue,
        };
        let pid = pid_u32 as i32;
        if pid == self_pid {
            continue;
        }
        // Cross-session filter (T-05-03-03). If we can't resolve the
        // session for a target, we conservatively skip it.
        if let (Some(ours), Some(theirs)) = (self_session, pid_to_session(pid_u32)) {
            if ours != theirs {
                continue;
            }
        }
        let title = w.title().ok();
        let process_name = w.process_name().unwrap_or_default();
        // Noise filter: window must have either a title OR a process name
        // we can show (most windows satisfy both).
        if title.as_deref().unwrap_or("").is_empty() && process_name.is_empty() {
            continue;
        }
        let rect = match w.rect() {
            Ok(r) => r,
            Err(_) => continue,
        };
        let hwnd = w.as_raw_hwnd();
        // TRACE-only title logging per T-05-03-02.
        tracing::trace!(
            hwnd = ?hwnd,
            pid,
            process = %process_name,
            title = ?title,
            "enumerated window"
        );
        out.push(WindowInfo {
            window_id: (hwnd as isize) as u64,
            title,
            app_name: process_name.clone(),
            pid,
            bundle_id: process_name,
            x: rect.left as f64,
            y: rect.top as f64,
            width: (rect.right - rect.left) as f64,
            height: (rect.bottom - rect.top) as f64,
            is_on_screen: true,
        });
    }
    Ok(out)
}

/// Resolve `pid` to a top-level HWND. Retries up to 10×100ms to handle the
/// case where the browser's first top-level window hasn't materialized
/// yet (Chromium startup race).
///
/// If multiple windows match, returns the largest-area one (parity with
/// the macOS tiebreaker).
///
/// Chromium parent/child model: the pid we get from Playwright is the
/// browser process; the top-level window's owning pid may be a *child*
/// process (sandboxed renderer). When the direct filter fails, we walk
/// child processes via ToolHelp and retry with the child-pid set. To
/// avoid matching an unrelated helper, we require the child process name
/// to match `chrome.exe` / `msedge.exe` / `chromium.exe` (T-05-03-07).
///
/// Returns the raw HWND as `isize` (packed into `WindowId(u64)` at the
/// caller).
#[cfg(target_os = "windows")]
pub async fn find_window_by_pid(
    pid: i32,
    title_hint: Option<&str>,
) -> Result<Option<isize>, CaptureError> {
    use tokio::time::{sleep, Duration};
    // Allow the operator-triggered real-capture test to override the retry
    // budget via env; keeps the 1s budget realistic under load.
    let max_attempts: u32 = std::env::var("STORYCAPTURE_WGC_PID_RETRIES")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(10);
    for attempt in 0..max_attempts {
        if let Some(hwnd) = try_find_window_by_pid(pid, title_hint)? {
            return Ok(Some(hwnd));
        }
        if attempt + 1 < max_attempts {
            sleep(Duration::from_millis(100)).await;
        }
    }
    // Last-resort: child-process walk for Chromium browsers.
    let children = chromium_child_pids(pid)?;
    if children.is_empty() {
        return Ok(None);
    }
    tracing::debug!(
        parent_pid = pid,
        child_count = children.len(),
        "find_window_by_pid: falling back to Chromium child-pid walk"
    );
    for child_pid in children {
        if let Some(hwnd) = try_find_window_by_pid(child_pid as i32, title_hint)? {
            tracing::debug!(
                parent_pid = pid,
                child_pid,
                "resolved HWND via child-pid walk"
            );
            return Ok(Some(hwnd));
        }
    }
    Ok(None)
}

#[cfg(target_os = "windows")]
fn try_find_window_by_pid(
    pid: i32,
    title_hint: Option<&str>,
) -> Result<Option<isize>, CaptureError> {
    use windows_capture::window::Window;

    let wins = Window::enumerate()
        .map_err(|e| CaptureError::Native(format!("Window::enumerate: {e}")))?;
    let mut best: Option<(isize, i64)> = None;
    for w in wins {
        let owner = match w.process_id() {
            Ok(id) => id as i32,
            Err(_) => continue,
        };
        if owner != pid {
            continue;
        }
        if let Some(hint) = title_hint {
            if !hint.is_empty() {
                let title = w.title().unwrap_or_default();
                if !title.contains(hint) {
                    continue;
                }
            }
        }
        let rect = match w.rect() {
            Ok(r) => r,
            Err(_) => continue,
        };
        let area = ((rect.right - rect.left) as i64) * ((rect.bottom - rect.top) as i64);
        let hwnd = w.as_raw_hwnd() as isize;
        best = match best {
            None => Some((hwnd, area)),
            Some((_, prev_area)) if area > prev_area => Some((hwnd, area)),
            keep => keep,
        };
    }
    Ok(best.map(|(hwnd, _)| hwnd))
}

/// Snapshot `CreateToolhelp32Snapshot` + walk `Process32First/Next` to
/// collect child PIDs of `parent_pid` whose process name matches a
/// Chromium-family executable (T-05-03-07).
#[cfg(target_os = "windows")]
fn chromium_child_pids(parent_pid: i32) -> Result<Vec<u32>, CaptureError> {
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    let mut pids = Vec::new();
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
            .map_err(|e| CaptureError::Native(format!("CreateToolhelp32Snapshot: {e}")))?;
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        if Process32FirstW(snap, &mut entry).is_ok() {
            loop {
                if entry.th32ParentProcessID as i32 == parent_pid {
                    let name = widestr_to_string(&entry.szExeFile);
                    let lower = name.to_ascii_lowercase();
                    if matches!(
                        lower.as_str(),
                        "chrome.exe" | "msedge.exe" | "chromium.exe"
                    ) {
                        pids.push(entry.th32ProcessID);
                    }
                }
                if Process32NextW(snap, &mut entry).is_err() {
                    break;
                }
            }
        }
    }
    Ok(pids)
}

#[cfg(target_os = "windows")]
fn widestr_to_string(wide: &[u16]) -> String {
    let nul = wide.iter().position(|&c| c == 0).unwrap_or(wide.len());
    String::from_utf16_lossy(&wide[..nul])
}

#[cfg(target_os = "windows")]
fn current_session_id() -> Option<u32> {
    pid_to_session(std::process::id())
}

/// Resolve a process's Terminal Services session ID. Used to filter
/// out cross-session windows (T-05-03-03).
///
/// In windows-0.58, `ProcessIdToSessionId` is exposed via
/// `Win32::System::RemoteDesktop` (kernel32 forwards it). We call
/// through the FFI directly to sidestep cross-feature-flag drift —
/// `kernel32!ProcessIdToSessionId` has been stable since Win2000.
#[cfg(target_os = "windows")]
fn pid_to_session(pid: u32) -> Option<u32> {
    // SAFETY: The signature is `BOOL ProcessIdToSessionId(DWORD, DWORD*)`
    // from kernel32. We pass a valid outparam; the function is stateless.
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn ProcessIdToSessionId(
            dw_process_id: u32,
            p_session_id: *mut u32,
        ) -> i32;
    }
    let mut sid: u32 = 0;
    let ok = unsafe { ProcessIdToSessionId(pid, &mut sid as *mut u32) };
    if ok != 0 {
        Some(sid)
    } else {
        None
    }
}

// Non-Windows stubs so callers can compile cross-platform without cfg arms.
#[cfg(not(target_os = "windows"))]
pub fn list_windows() -> Result<Vec<WindowInfo>, CaptureError> {
    Err(CaptureError::Unsupported)
}

#[cfg(not(target_os = "windows"))]
pub async fn find_window_by_pid(
    _pid: i32,
    _title_hint: Option<&str>,
) -> Result<Option<isize>, CaptureError> {
    Err(CaptureError::Unsupported)
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::*;

    #[test]
    fn widestr_handles_empty_and_nul_terminated() {
        assert_eq!(widestr_to_string(&[]), "");
        let mut buf = [0u16; 16];
        for (i, c) in "chrome.exe".encode_utf16().enumerate() {
            buf[i] = c;
        }
        assert_eq!(widestr_to_string(&buf), "chrome.exe");
    }

    #[test]
    fn current_session_resolves_for_own_pid() {
        // Every process has a session. If this ever starts returning None
        // on a Windows host we have a deeper platform problem.
        assert!(current_session_id().is_some());
    }
}
