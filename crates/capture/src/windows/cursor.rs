//! Windows cursor sampling for trajectory recording (Phase 19-02).
//!
//! Uses `GetCursorPos` from `Win32_UI_WindowsAndMessaging`. The
//! `windows` crate (0.58) is already a workspace dep with that feature
//! enabled (see capture/Cargo.toml), so this adds zero new deps.

use windows::Win32::Foundation::POINT;
use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;

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
