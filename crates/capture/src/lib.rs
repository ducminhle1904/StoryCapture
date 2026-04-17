//! `capture` — platform-native screen capture.
//!
//! Pure crate: zero Tauri / specta deps. The Tauri host wraps these
//! types at the IPC boundary in `apps/desktop/src-tauri/src/commands/capture.rs`.
//!
//! Backends:
//!   - **macOS**: `SckBackend` (ScreenCaptureKit, `screencapturekit = "=1.70.0"`)
//!   - **Windows**: `WgcBackend` (Windows.Graphics.Capture, `windows-capture = "=1.5.0"`)
//!   - **fallback**: `XcapBackend` (xcap polling, owned bytes — not zero-copy)
//!
//! Critical invariants (D-19 / D-21 / CAP-05 / CAP-07):
//!   - Frame queue is byte-bounded (256 MiB default), not frame-count-bounded.
//!   - Capture-API PTS preserved end-to-end; no Rust-side timestamp rewriting.
//!   - Native surface handles wrapped in RAII (CFRelease / Release on Drop).

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
pub use target::{CaptureTarget, WindowId};

#[cfg(target_os = "macos")]
pub use macos::SckBackend;

#[cfg(target_os = "windows")]
pub use windows::WgcBackend;

/// Construct the recommended backend for the current platform. Falls
/// back to `XcapBackend` when the native backend can't be initialized
/// (e.g. TCC denied, no D3D11 device available).
///
/// NOTE: the native `SckBackend` / `WgcBackend` are currently
/// trait-surface stubs (see their source) — they init cleanly but never
/// deliver frames. Until the native capture spike lands, force the
/// xcap polling backend which is fully implemented end-to-end. xcap
/// gives us ~30fps polled BGRA frames which is adequate for demo videos.
pub fn pick_default_backend(_cfg: &CaptureConfig) -> Box<dyn CaptureBackend> {
    Box::new(XcapBackend::new())
}
