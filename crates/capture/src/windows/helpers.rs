//! Shared helpers for Windows capture paths.
//!
//! The logical→physical rect scaling for `CaptureTarget::DisplayRegion`
//! was byte-identical in `wgc_backend.rs` and `thumbnail.rs`. Extracted
//! here so both paths stay in sync.

#![cfg(target_os = "windows")]

use crate::display::DisplayId;
use crate::error::CaptureError;
use crate::target::RegionRect;
use crate::windows::frame_from_wgc::PhysicalRectU32;
use windows::Win32::Foundation::POINT;
use windows::Win32::Graphics::Gdi::{MonitorFromPoint, MONITOR_DEFAULTTONULL};
use windows_capture::monitor::Monitor;

/// Resolve the shared `DisplayId` into the concrete WGC monitor handle that
/// `windows-capture` expects.
pub(crate) fn resolve_monitor(display_id: &DisplayId) -> Result<Monitor, CaptureError> {
    let monitor = xcap::Monitor::all()
        .map_err(|e| CaptureError::Native(format!("xcap monitor list: {e}")))?
        .into_iter()
        .find(|m| m.id().map(|id| id as u64 == display_id.0).unwrap_or(false))
        .ok_or(CaptureError::DisplayNotFound(*display_id))?;

    let x = monitor
        .x()
        .map_err(|e| CaptureError::Native(format!("monitor x: {e}")))?;
    let y = monitor
        .y()
        .map_err(|e| CaptureError::Native(format!("monitor y: {e}")))?;
    let w = monitor
        .width()
        .map_err(|e| CaptureError::Native(format!("monitor width: {e}")))?;
    let h = monitor
        .height()
        .map_err(|e| CaptureError::Native(format!("monitor height: {e}")))?;

    let center = POINT {
        x: x.saturating_add(i32::try_from(w / 2).unwrap_or(i32::MAX)),
        y: y.saturating_add(i32::try_from(h / 2).unwrap_or(i32::MAX)),
    };
    let raw = unsafe { MonitorFromPoint(center, MONITOR_DEFAULTTONULL) };
    if raw.is_invalid() {
        return Err(CaptureError::DisplayNotFound(*display_id));
    }

    Ok(Monitor::from_raw_hmonitor(raw.0))
}

/// Resolve a logical `RegionRect` on `display_id` to physical pixels by
/// multiplying against the display's DPI scale factor.
///
/// Returns `Ok(Some(rect))` on success, or `Err` if `display_id` is not
/// in the currently enumerated display set. (`Option` in the return type
/// leaves room for callers that already know the target variant could
/// map to `None` — today both callers always pass `DisplayRegion`.)
pub(crate) fn resolve_region_to_physical(
    display_id: &DisplayId,
    rect: &RegionRect,
) -> Result<PhysicalRectU32, CaptureError> {
    let displays = crate::display::cached_displays()?;
    let disp = displays
        .iter()
        .find(|d| d.id == *display_id)
        .ok_or_else(|| {
            CaptureError::Native(format!(
                "DisplayRegion references unknown display {}",
                display_id.0
            ))
        })?;
    let scale = disp.scale_factor.max(1.0) as f64;
    Ok(PhysicalRectU32 {
        x: (rect.x * scale).round() as u32,
        y: (rect.y * scale).round() as u32,
        w: (rect.w * scale).round() as u32,
        h: (rect.h * scale).round() as u32,
    })
}
