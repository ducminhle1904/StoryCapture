//! Shared helpers for Windows capture paths.
//!
//! Phase 6 cleanup backlog #7 — the logical→physical rect scaling for
//! `CaptureTarget::DisplayRegion` was byte-identical in `wgc_backend.rs`
//! and `thumbnail.rs`. Extracted here so both paths stay in sync.

#![cfg(target_os = "windows")]

use crate::display::DisplayId;
use crate::error::CaptureError;
use crate::target::RegionRect;
use crate::windows::frame_from_wgc::PhysicalRectU32;

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
    let displays = crate::display::enumerate_displays()?;
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
