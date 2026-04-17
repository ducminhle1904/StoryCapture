//! Cross-platform window info. Shape is identical on macOS (SCK) and
//! Windows (WGC); the per-platform enumerators in `macos::window` and
//! `windows::window` populate the same struct.

use serde::{Deserialize, Serialize};

/// Lightweight window info consumed by the UI picker.
///
/// Field conventions:
///   - `window_id`: platform-scoped id. macOS = SCK `window_id` (u32 widened);
///     Windows = HWND reinterpreted as `u64` (via `isize as u64`).
///   - `bundle_id`: on macOS, the owning app's bundle identifier. On Windows
///     we don't have bundle ids, so the process name (e.g. `chrome.exe`) is
///     stored here for grouping.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WindowInfo {
    pub window_id: u64,
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
