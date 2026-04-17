//! Capture target types (Plan 05-01).
//!
//! `CaptureTarget` replaces the old `CaptureConfig.display_id: DisplayId`
//! with a richer variant that supports full-display, explicit-window, and
//! "window owned by this PID" (Playwright auto-follow — resolved at
//! `SckBackend::start` time, Plan 05-02 wires the sentinel).

use crate::display::DisplayId;
use serde::{Deserialize, Serialize};

/// Platform-tagged window identifier.
///
/// On macOS SCK uses `u32` window ids; on Windows WGC uses `HWND` (isize).
/// We widen to `u64` so the IPC wire format is stable across platforms —
/// platform-scope awareness is enforced by the backends (Window variant
/// only works on platforms that implemented it).
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize,
)]
pub struct WindowId(pub u64);

/// What the capture backend should capture.
///
/// Variants:
///
/// - `Display { display_id }` — the entire display identified by `display_id`
///   (the old behavior). Supported by every backend, including the xcap
///   fallback.
/// - `Window { window_id }` — a single OS window. macOS SCK + Windows WGC
///   only; xcap returns `CaptureError::UnsupportedTarget`.
/// - `WindowByPid { pid, title_hint }` — resolved at start time to the
///   largest on-screen window whose owning application's pid matches.
///   Title hint narrows when a PID owns multiple windows. Used by the
///   Playwright auto-follow path in Plan 05-02.
///
/// The sentinel `WindowByPid { pid: -1, title_hint: Some("storycapture-playwright") }`
/// represents "Playwright auto (resolve when a story launches)" in UI-facing
/// persistence; Plan 05-02 replaces the sentinel with the real Playwright PID.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CaptureTarget {
    Display {
        display_id: DisplayId,
    },
    Window {
        window_id: WindowId,
    },
    WindowByPid {
        pid: i32,
        title_hint: Option<String>,
    },
}

impl CaptureTarget {
    /// Human-readable label for logs. Avoids leaking titles above TRACE.
    pub fn kind_label(&self) -> &'static str {
        match self {
            Self::Display { .. } => "display",
            Self::Window { .. } => "window",
            Self::WindowByPid { .. } => "window_by_pid",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn target_display_round_trips_json() {
        let t = CaptureTarget::Display { display_id: DisplayId(7) };
        let s = serde_json::to_string(&t).unwrap();
        let back: CaptureTarget = serde_json::from_str(&s).unwrap();
        assert_eq!(t, back);
        assert!(s.contains("\"display\""), "tag serialized: {s}");
    }

    #[test]
    fn target_window_round_trips_json() {
        let t = CaptureTarget::Window { window_id: WindowId(42) };
        let s = serde_json::to_string(&t).unwrap();
        let back: CaptureTarget = serde_json::from_str(&s).unwrap();
        assert_eq!(t, back);
        assert!(s.contains("\"window\""));
    }

    #[test]
    fn target_window_by_pid_round_trips_json() {
        let t = CaptureTarget::WindowByPid {
            pid: 12345,
            title_hint: Some("chromium".into()),
        };
        let s = serde_json::to_string(&t).unwrap();
        let back: CaptureTarget = serde_json::from_str(&s).unwrap();
        assert_eq!(t, back);
    }

    #[test]
    fn enum_round_trip_without_hint() {
        let t = CaptureTarget::WindowByPid { pid: -1, title_hint: None };
        let s = serde_json::to_string(&t).unwrap();
        let back: CaptureTarget = serde_json::from_str(&s).unwrap();
        assert_eq!(t, back);
    }
}
