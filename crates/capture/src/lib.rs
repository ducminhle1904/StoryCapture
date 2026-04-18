//! Platform-native screen capture. Pure crate — zero Tauri/specta deps.
//!
//! Backends: `SckBackend` (macOS ScreenCaptureKit), `WgcBackend`
//! (Windows.Graphics.Capture), `XcapBackend` (polling fallback, owned
//! bytes — not zero-copy).
//!
//! Invariants: frame queue bounded in BYTES not frames (256 MiB default);
//! capture-API PTS preserved end-to-end; native surface handles wrapped
//! in RAII (CFRelease/Release on Drop).

pub mod audio;
mod backend;
mod clock;
mod display;
mod error;
mod events;
mod fallback;
mod frame;
mod orchestrator;
mod pipeline;
mod queue;
mod target;
pub mod thumbnail;
mod window;

#[cfg(target_os = "macos")]
pub mod macos;
#[cfg(target_os = "windows")]
pub mod windows;

pub use backend::{BackendKind, CaptureBackend, CaptureConfig, CaptureStats};
pub use clock::{default_clock, Clock};
pub use display::{enumerate_displays, DisplayId, DisplayInfo};
pub use error::CaptureError;
pub use events::CaptureEvent;
pub use fallback::XcapBackend;
pub use frame::{ClockSource, Frame, FrameData, PixelFormat, Pts};
pub use pipeline::CapturePipeline;
pub use queue::{ByteBoundedQueue, DroppedFrame, QueueStats};
pub use orchestrator::{orchestrate_start, FallbackCounter, OrchestratedStart};
pub use target::{CaptureTarget, RegionRect, WindowId};
pub use window::WindowInfo;

#[cfg(target_os = "macos")]
pub use macos::SckBackend;

#[cfg(target_os = "windows")]
pub use windows::WgcBackend;

/// Construct the recommended backend for the current platform. Falls
/// back to `XcapBackend` when the native backend can't be initialized
/// (e.g. TCC denied on macOS, WGC unavailable on Windows).
///
/// The per-target fallback orchestration for window-only-captures lives
/// in `orchestrator::orchestrate_start`; this helper picks the *kind*
/// of backend to try first when the caller doesn't want to drive the
/// orchestrator directly.
pub fn pick_default_backend(_cfg: &CaptureConfig) -> Box<dyn CaptureBackend> {
    #[cfg(target_os = "windows")]
    {
        match WgcBackend::new() {
            Ok(b) => return Box::new(b),
            Err(e) => {
                tracing::warn!(error = %e, "WgcBackend::new failed; using xcap fallback");
            }
        }
    }
    #[cfg(target_os = "macos")]
    {
        if let Ok(b) = SckBackend::new() {
            return Box::new(b);
        }
    }
    Box::new(XcapBackend::new())
}
