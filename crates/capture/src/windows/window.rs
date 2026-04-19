//! Window enumeration and pid-to-HWND resolution.
//!
//! Titles are PII-sensitive, so log them at TRACE only.

use crate::error::CaptureError;
pub use crate::window::WindowInfo;

/// Enumerate capturable top-level windows.
#[cfg(target_os = "windows")]
pub fn list_windows() -> Result<Vec<WindowInfo>, CaptureError> {
    use windows_capture::window::Window;

    let wins =
        Window::enumerate().map_err(|e| CaptureError::Native(format!("Window::enumerate: {e}")))?;

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
        // Skip cross-session windows when session IDs are available.
        if let (Some(ours), Some(theirs)) = (self_session, pid_to_session(pid_u32)) {
            if ours != theirs {
                continue;
            }
        }
        let title = w.title().ok();
        let process_name = w.process_name().unwrap_or_default();
        // Require a title or process name.
        if title.as_deref().unwrap_or("").is_empty() && process_name.is_empty() {
            continue;
        }
        let rect = match w.rect() {
            Ok(r) => r,
            Err(_) => continue,
        };
        let hwnd = w.as_raw_hwnd();
        // TRACE only: titles may contain PII.
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

/// Resolve `pid` to the best matching HWND.
#[cfg(target_os = "windows")]
pub async fn find_window_by_pid(
    pid: i32,
    title_hint: Option<&str>,
) -> Result<Option<isize>, CaptureError> {
    use tokio::time::{sleep, Duration};
    // Allow the retry budget to be overridden in tests.
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
    // Last resort: walk Chromium child processes.
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

    let wins =
        Window::enumerate().map_err(|e| CaptureError::Native(format!("Window::enumerate: {e}")))?;
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

/// Collect Chromium-family child PIDs for a parent process.
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
                    if matches!(lower.as_str(), "chrome.exe" | "msedge.exe" | "chromium.exe") {
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

/// Resolve a process's Terminal Services session ID.
#[cfg(target_os = "windows")]
fn pid_to_session(pid: u32) -> Option<u32> {
    // SAFETY: The signature is `BOOL ProcessIdToSessionId(DWORD, DWORD*)`
    // from kernel32. We pass a valid outparam; the function is stateless.
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn ProcessIdToSessionId(dw_process_id: u32, p_session_id: *mut u32) -> i32;
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
