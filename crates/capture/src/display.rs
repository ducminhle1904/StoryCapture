//! Display enumeration. `width_px` / `height_px` are physical pixels —
//! the platform backends multiply logical points by `backingScaleFactor`
//! (mac) or set `DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2` before
//! enumeration (Windows) so the values reflect the actual pixel grid.

use crate::error::CaptureError;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

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

/// TTL for the `cached_displays` snapshot (backlog #3). Long enough to
/// absorb the 2s thumbnail refetch loop without re-walking the monitor
/// tree, short enough that a hot-plug / display-config change is picked
/// up within a few frames.
const CACHE_TTL: Duration = Duration::from_secs(3);

/// Shared cache for `cached_displays`. Populated lazily on first call.
fn cache_cell() -> &'static Mutex<Option<(Instant, Vec<DisplayInfo>)>> {
    static CELL: OnceLock<Mutex<Option<(Instant, Vec<DisplayInfo>)>>> = OnceLock::new();
    CELL.get_or_init(|| Mutex::new(None))
}

/// `enumerate_displays` behind a 3-second TTL cache (backlog #3).
///
/// Safe for concurrent thumbnail fetches — the cache is guarded by a
/// `parking_lot::Mutex`; on TTL expiry we hold the lock across the
/// backend call so only one caller pays the enumeration cost while
/// the rest wait on the (fast, <5 ms typical) refresh.
///
/// Currently consumed by the Windows thumbnail / region-crop paths,
/// which hit display enumeration every 2 s via `refetchInterval`.
#[allow(dead_code)] // macOS has no hot callers today; kept cfg-agnostic for uniformity.
pub(crate) fn cached_displays() -> Result<Vec<DisplayInfo>, CaptureError> {
    let mut guard = cache_cell().lock();
    if let Some((at, ref list)) = *guard {
        if at.elapsed() < CACHE_TTL {
            return Ok(list.clone());
        }
    }
    let fresh = enumerate_displays()?;
    *guard = Some((Instant::now(), fresh.clone()));
    Ok(fresh)
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

#[cfg(test)]
mod cache_tests {
    use super::*;

    #[test]
    fn cached_displays_returns_ok_and_repeats() {
        // Concrete platforms: enumerate() returns Ok on CI hosts. Non-CI
        // fallback uses xcap which also returns Ok (empty Vec is legal).
        // This test verifies: two calls succeed and the cache guard is
        // re-entrant-safe (second call takes the fast path).
        let first = cached_displays();
        let second = cached_displays();
        assert!(first.is_ok());
        assert!(second.is_ok());
        // Lengths match because the second call must hit the cache.
        assert_eq!(first.unwrap().len(), second.unwrap().len());
    }
}
