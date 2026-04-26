//! Capture target variants: full display, explicit window, window-by-pid
//! (Playwright auto-follow), and display-region (logical-point sub-rect).
//! Regions are kernel-cropped on macOS (`with_source_rect`) but require
//! post-capture CPU crop on Windows — `windows-capture = 2.0.0` has no
//! native crop API.

use crate::display::DisplayId;
use serde::{Deserialize, Serialize};

/// A rectangle in **logical points/pixels** over a display.
///
/// - On macOS, coordinates are logical points; the SCK backend applies
///   `point_pixel_scale()` internally when computing physical pixel
///   `with_width`/`with_height` (RESEARCH Pitfall 7).
/// - On Windows, coordinates are logical pixels (DPI-unaware layer); the
///   WGC backend multiplies by the monitor's DPI scale to reach physical
///   pixels for the post-capture CPU crop.
///
/// Values are `f64` to round-trip overlay-drawn rects losslessly through
/// serde JSON.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct RegionRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl RegionRect {
    /// Validate the rect against the bounds of the display it targets.
    ///
    /// Rejects:
    /// - Non-finite coordinates (NaN / Inf)
    /// - Zero-area or negative dimensions (`w <= 0` or `h <= 0`)
    /// - Negative origins (`x < 0` or `y < 0`)
    /// - Rects whose origin+size exceeds display bounds
    ///
    /// `display_logical_w` / `display_logical_h` are the display's size
    /// in the same coordinate system as `self` (points on macOS, logical
    /// pixels on Windows). Callers MUST fetch these from the target
    /// display's `DisplayInfo` BEFORE starting a capture session.
    ///
    /// Returns a structured error string rather than a backend panic
    /// (T-06-08 mitigation).
    pub fn validate(&self, display_logical_w: f64, display_logical_h: f64) -> Result<(), String> {
        if !self.x.is_finite() || !self.y.is_finite() || !self.w.is_finite() || !self.h.is_finite()
        {
            return Err(format!(
                "RegionRect contains non-finite coordinate: {:?}",
                self
            ));
        }
        if self.w <= 0.0 || self.h <= 0.0 {
            return Err(format!(
                "RegionRect has non-positive size ({}×{})",
                self.w, self.h
            ));
        }
        if self.x < 0.0 || self.y < 0.0 {
            return Err(format!(
                "RegionRect has negative origin ({}, {})",
                self.x, self.y
            ));
        }
        if self.x + self.w > display_logical_w + f64::EPSILON
            || self.y + self.h > display_logical_h + f64::EPSILON
        {
            return Err(format!(
                "RegionRect ({},{},{}×{}) exceeds display bounds {}×{}",
                self.x, self.y, self.w, self.h, display_logical_w, display_logical_h
            ));
        }
        Ok(())
    }
}

/// Platform-tagged window identifier.
///
/// On macOS SCK uses `u32` window ids; on Windows WGC uses `HWND` (isize).
/// We widen to `u64` so the IPC wire format is stable across platforms —
/// platform-scope awareness is enforced by the backends (Window variant
/// only works on platforms that implemented it).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
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
///   Playwright auto-follow path.
///
/// The sentinel `WindowByPid { pid: -1, title_hint: Some("storycapture-playwright") }`
/// represents "Playwright auto (resolve when a story launches)" in UI-facing
/// persistence; the sentinel is replaced with the real Playwright PID at
/// run time.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
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
    /// Logical-point sub-rect of a specific display.
    /// macOS: SCK `with_source_rect` (kernel-side crop, no overcapture).
    /// Windows: post-capture CPU crop in `on_frame_arrived`.
    DisplayRegion {
        display_id: DisplayId,
        rect: RegionRect,
    },
}

impl CaptureTarget {
    /// Human-readable label for logs. Avoids leaking titles above TRACE.
    pub fn kind_label(&self) -> &'static str {
        match self {
            Self::Display { .. } => "display",
            Self::Window { .. } => "window",
            Self::WindowByPid { .. } => "window_by_pid",
            Self::DisplayRegion { .. } => "display_region",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn target_display_round_trips_json() {
        let t = CaptureTarget::Display {
            display_id: DisplayId(7),
        };
        let s = serde_json::to_string(&t).unwrap();
        let back: CaptureTarget = serde_json::from_str(&s).unwrap();
        assert_eq!(t, back);
        assert!(s.contains("\"display\""), "tag serialized: {s}");
    }

    #[test]
    fn target_window_round_trips_json() {
        let t = CaptureTarget::Window {
            window_id: WindowId(42),
        };
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
        let t = CaptureTarget::WindowByPid {
            pid: -1,
            title_hint: None,
        };
        let s = serde_json::to_string(&t).unwrap();
        let back: CaptureTarget = serde_json::from_str(&s).unwrap();
        assert_eq!(t, back);
    }

    // ─── DisplayRegion + RegionRect ────────────────────────────────────

    #[test]
    fn region_rect_round_trips_json_preserving_f64_precision() {
        let r = RegionRect {
            x: 100.25,
            y: 50.75,
            w: 640.125,
            h: 480.875,
        };
        let s = serde_json::to_string(&r).unwrap();
        let back: RegionRect = serde_json::from_str(&s).unwrap();
        assert_eq!(r, back);
        assert!(s.contains("\"x\":100.25"), "f64 x preserved: {s}");
        assert!(s.contains("\"w\":640.125"), "f64 w preserved: {s}");
    }

    #[test]
    fn target_display_region_round_trips_json() {
        let t = CaptureTarget::DisplayRegion {
            display_id: DisplayId(3),
            rect: RegionRect {
                x: 0.0,
                y: 0.0,
                w: 1280.0,
                h: 720.0,
            },
        };
        let s = serde_json::to_string(&t).unwrap();
        let back: CaptureTarget = serde_json::from_str(&s).unwrap();
        assert_eq!(t, back);
        assert!(s.contains("\"display_region\""), "tag serialized: {s}");
        assert!(s.contains("\"rect\""), "rect nested: {s}");
    }

    #[test]
    fn region_rect_validate_accepts_in_bounds() {
        let r = RegionRect {
            x: 100.0,
            y: 100.0,
            w: 640.0,
            h: 480.0,
        };
        assert!(r.validate(1920.0, 1080.0).is_ok());
    }

    #[test]
    fn region_rect_validate_rejects_zero_area() {
        let r = RegionRect {
            x: 0.0,
            y: 0.0,
            w: 0.0,
            h: 480.0,
        };
        assert!(r.validate(1920.0, 1080.0).is_err());
        let r = RegionRect {
            x: 0.0,
            y: 0.0,
            w: 640.0,
            h: 0.0,
        };
        assert!(r.validate(1920.0, 1080.0).is_err());
    }

    #[test]
    fn region_rect_validate_rejects_negative_size() {
        let r = RegionRect {
            x: 0.0,
            y: 0.0,
            w: -10.0,
            h: 480.0,
        };
        assert!(r.validate(1920.0, 1080.0).is_err());
    }

    #[test]
    fn region_rect_validate_rejects_negative_origin() {
        let r = RegionRect {
            x: -1.0,
            y: 0.0,
            w: 100.0,
            h: 100.0,
        };
        assert!(r.validate(1920.0, 1080.0).is_err());
    }

    #[test]
    fn region_rect_validate_rejects_overflow() {
        // origin+size exceeds display bounds
        let r = RegionRect {
            x: 1500.0,
            y: 100.0,
            w: 640.0,
            h: 480.0,
        };
        assert!(r.validate(1920.0, 1080.0).is_err());
    }

    #[test]
    fn region_rect_validate_rejects_non_finite() {
        let r = RegionRect {
            x: f64::NAN,
            y: 0.0,
            w: 640.0,
            h: 480.0,
        };
        assert!(r.validate(1920.0, 1080.0).is_err());
        let r = RegionRect {
            x: 0.0,
            y: 0.0,
            w: f64::INFINITY,
            h: 480.0,
        };
        assert!(r.validate(1920.0, 1080.0).is_err());
    }
}
