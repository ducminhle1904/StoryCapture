//! Windows cursor sampling for trajectory recording (Phase 19-02).
//!
//! Uses `GetCursorPos` from `Win32_UI_WindowsAndMessaging`. The
//! `windows` crate (0.58) is already a workspace dep with that feature
//! enabled (see capture/Cargo.toml), so this adds zero new deps.

use std::sync::atomic::AtomicU64;
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::thread::{self, JoinHandle};
use std::time::Duration;
use windows::Win32::Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, POINT, WPARAM};
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, DispatchMessageW, GetCursorPos, GetMessageW, PeekMessageW, PostThreadMessageW,
    SetWindowsHookExW, TranslateMessage, UnhookWindowsHookEx, HHOOK, MSG, PM_NOREMOVE, WH_MOUSE_LL,
    WM_LBUTTONDOWN, WM_QUIT, WM_RBUTTONDOWN,
};

static CLICK_SINK: OnceLock<Mutex<Option<Arc<AtomicU64>>>> = OnceLock::new();

/// Background Windows low-level mouse hook handle.
pub struct ClickHook {
    thread_id: u32,
    join: Option<JoinHandle<()>>,
}

#[derive(Debug, thiserror::Error)]
pub enum ClickHookError {
    #[error("a Windows click hook is already installed")]
    AlreadyInstalled,
    #[error("SetWindowsHookExW(WH_MOUSE_LL) failed: {0}")]
    Install(windows::core::Error),
    #[error("Windows click hook worker did not report readiness")]
    ReadyTimeout,
    #[error("failed to spawn Windows click hook worker: {0}")]
    Spawn(std::io::Error),
}

/// Install a WH_MOUSE_LL hook for left/right mouse-down events.
///
/// The callback only records a timestamp into an atomic sink and then
/// immediately chains to the next hook.
pub fn install_click_hook(latest_click_at: Arc<AtomicU64>) -> Result<ClickHook, ClickHookError> {
    {
        let mut sink = click_sink()
            .lock()
            .map_err(|_| ClickHookError::AlreadyInstalled)?;
        if sink.is_some() {
            return Err(ClickHookError::AlreadyInstalled);
        }
        *sink = Some(latest_click_at);
    }

    let (ready_tx, ready_rx) = mpsc::sync_channel::<Result<u32, ClickHookError>>(1);
    let join = thread::Builder::new()
        .name("trajectory-click-hook".into())
        .spawn(move || {
            // SAFETY: this thread owns the message loop and hook lifetime.
            let thread_id = unsafe { GetCurrentThreadId() };
            let mut msg = MSG::default();
            // SAFETY: PeekMessageW with PM_NOREMOVE creates the thread
            // message queue so Drop can reliably PostThreadMessageW.
            let _ =
                unsafe { PeekMessageW(&mut msg, HWND(std::ptr::null_mut()), 0, 0, PM_NOREMOVE) };
            // SAFETY: WH_MOUSE_LL hooks do not require an injected DLL when
            // dwThreadId is 0. The callback is static and non-panicking.
            let hook = match unsafe {
                SetWindowsHookExW(
                    WH_MOUSE_LL,
                    Some(mouse_hook_proc),
                    HINSTANCE(std::ptr::null_mut()),
                    0,
                )
            } {
                Ok(hook) => hook,
                Err(error) => {
                    let _ = ready_tx.send(Err(ClickHookError::Install(error)));
                    clear_click_sink();
                    return;
                }
            };

            let _ = ready_tx.send(Ok(thread_id));

            // SAFETY: msg points to valid storage for the duration of the loop.
            while unsafe { GetMessageW(&mut msg, HWND(std::ptr::null_mut()), 0, 0) }.as_bool() {
                // SAFETY: standard message loop calls for a message returned by GetMessageW.
                let _ = unsafe { TranslateMessage(&msg) };
                let _ = unsafe { DispatchMessageW(&msg) };
            }

            // SAFETY: hook was returned by SetWindowsHookExW in this thread.
            if let Err(error) = unsafe { UnhookWindowsHookEx(hook) } {
                tracing::warn!(%error, "trajectory click hook unhook failed");
            }
        })
        .map_err(|error| {
            clear_click_sink();
            ClickHookError::Spawn(error)
        })?;

    let thread_id = match ready_rx.recv_timeout(Duration::from_secs(2)) {
        Ok(Ok(thread_id)) => thread_id,
        Ok(Err(error)) => {
            let _ = join.join();
            return Err(error);
        }
        Err(_) => {
            clear_click_sink();
            return Err(ClickHookError::ReadyTimeout);
        }
    };

    Ok(ClickHook {
        thread_id,
        join: Some(join),
    })
}

impl Drop for ClickHook {
    fn drop(&mut self) {
        if self.thread_id != 0 {
            // SAFETY: thread_id was reported by the hook thread after its
            // message queue was created. Failure only affects shutdown.
            if let Err(error) =
                unsafe { PostThreadMessageW(self.thread_id, WM_QUIT, WPARAM(0), LPARAM(0)) }
            {
                tracing::warn!(%error, "trajectory click hook stop post failed");
            }
        }
        if let Some(join) = self.join.take() {
            if let Err(error) = join.join() {
                tracing::warn!(?error, "trajectory click hook thread panicked");
            }
        }
        clear_click_sink();
    }
}

unsafe extern "system" fn mouse_hook_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 && lparam.0 != 0 {
        let message = wparam.0 as u32;
        if matches!(message, WM_LBUTTONDOWN | WM_RBUTTONDOWN) {
            if let Ok(sink) = click_sink().try_lock() {
                if let Some(latest_click_at) = sink.as_ref() {
                    crate::trajectory::record_click_now(latest_click_at);
                }
            }
        }
    }

    // SAFETY: low-level hooks must chain unless intentionally swallowing input.
    unsafe { CallNextHookEx(HHOOK(std::ptr::null_mut()), code, wparam, lparam) }
}

fn click_sink() -> &'static Mutex<Option<Arc<AtomicU64>>> {
    CLICK_SINK.get_or_init(|| Mutex::new(None))
}

fn clear_click_sink() {
    if let Ok(mut sink) = click_sink().lock() {
        *sink = None;
    }
}

/// Sample the current cursor position in screen px (top-left origin).
/// Returns `None` if the API call fails (e.g. session-locked).
pub fn sample_cursor() -> Option<(f32, f32)> {
    let mut point = POINT::default();
    // SAFETY: GetCursorPos writes into the POINT we own; failure is
    // surfaced via the BOOL return.
    let ok = unsafe { GetCursorPos(&mut point) };
    if ok.is_ok() {
        Some((point.x as f32, point.y as f32))
    } else {
        None
    }
}
