//! Display enumeration. `width_px` / `height_px` are physical pixels —
//! the platform backends multiply logical points by `backingScaleFactor`
//! (mac) or set `DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2` before
//! enumeration (Windows) so the values reflect the actual pixel grid.

use crate::error::CaptureError;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct DisplayId(pub u64);

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DisplayInfo {
    pub id: DisplayId,
    pub name: String,
    pub width_px: u32,
    pub height_px: u32,
    pub scale_factor: f32,
    pub is_primary: bool,
}

/// Cross-platform display enumeration. Dispatches to the active platform
/// backend; on hosts without a native backend, falls back to xcap.
pub fn enumerate_displays() -> Result<Vec<DisplayInfo>, CaptureError> {
    #[cfg(target_os = "macos")]
    {
        crate::macos::sck_backend::enumerate()
    }
    #[cfg(target_os = "windows")]
    {
        crate::windows::wgc_backend::enumerate()
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        crate::fallback::xcap_backend::enumerate()
    }
}
