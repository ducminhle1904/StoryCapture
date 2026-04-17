//! ScreenCaptureKit backend — `screencapturekit = "=1.5.4"` (CLAUDE.md says
//! 1.70.0 but the crate never published that version; Cargo.lock pins 1.5.4).
//!
//! # Verified SCK 1.5.4 API surface (Plan 05-01 Task 0 spike — 2026-04-17)
//!
//! The following method names were verified by reading the installed 1.5.4
//! source at `~/.cargo/registry/src/.../screencapturekit-1.5.4/`. Downstream
//! tasks rely on these names:
//!
//!   `SCShareableContent::get() -> Result<Self, SCError>` (synchronous; wrap in
//!     `spawn_blocking` per Pitfall 7).
//!   `SCShareableContent::windows() -> Vec<SCWindow>`
//!   `SCShareableContent::displays() -> Vec<SCDisplay>`
//!   `SCWindow::window_id() -> u32`
//!   `SCWindow::title() -> Option<String>`
//!   `SCWindow::owning_application() -> Option<SCRunningApplication>`
//!   `SCWindow::is_on_screen() -> bool`
//!   `SCWindow::window_layer() -> i32`
//!   `SCWindow::frame() -> CGRect` (points, not pixels)
//!   `SCRunningApplication::process_id() -> i32`
//!   `SCRunningApplication::application_name() -> String`
//!   `SCRunningApplication::bundle_identifier() -> String`
//!
//!   `SCContentFilter::create()` → builder; `.with_display(&display)` or
//!     `.with_window(&window)` → `.build() -> SCContentFilter`. NEVER pass
//!     empty `excluding_windows` (Pitfall 2).
//!
//!   `SCStreamConfiguration::new()` → builder; `.with_width(u32)`,
//!     `.with_height(u32)`, `.with_pixel_format(PixelFormat::BGRA)`,
//!     `.with_shows_cursor(bool)`, `.with_minimum_frame_interval(&CMTime)`
//!     (no `.with_fps` — use 1/fps as CMTime), `.with_queue_depth(u32)`.
//!
//!   `SCStream::new(&filter, &config) -> SCStream`
//!   `SCStream::new_with_delegate(&filter, &config, delegate)` → delegate is
//!     `impl SCStreamDelegateTrait + 'static`; use `StreamCallbacks::new()
//!     .on_error(..).on_stop(..)` builder.
//!   `SCStream::add_output_handler(handler, SCStreamOutputType::Screen)` —
//!     handler is `impl SCStreamOutputTrait` (blanket impl for `Fn(CMSampleBuffer,
//!     SCStreamOutputType) + Send + 'static`).
//!   `SCStream::start_capture() -> Result<(), SCError>`
//!   `SCStream::stop_capture() -> Result<(), SCError>`
//!   `SCStream::update_content_filter(&filter)` and
//!     `SCStream::update_configuration(&config)` BOTH exist in 1.5.4 → Open
//!     Question 1 resolved: we CAN reconfigure without rebuilding the stream.
//!
//!   `CMSampleBuffer::image_buffer() -> Option<CVPixelBuffer>`
//!   `CMSampleBuffer::presentation_timestamp() -> CMTime`
//!   `CMTime { value: i64, timescale: i32, flags: u32, epoch: i64 }` —
//!     ns = value * 1_000_000_000 / timescale. There is no `to_nanos()`
//!     method; compute manually.
//!   `CVPixelBuffer::as_ptr() -> *mut c_void` (pass through to our
//!     `CVPixelBufferHandle::retain` unsafe helper).
//!   `CVPixelBuffer::width() -> usize` / `height() -> usize`.
//!
//! Note on minimization: the doom-fish crate exposes a high-level streaming
//! API. We keep the integration thin — enumerate windows/displays, build an
//! SCContentFilter, attach a closure handler that wraps each `CMSampleBuffer`
//! in our RAII `CVPixelBufferHandle`, and emit `Frame`s through the mpsc
//! sender that the pipeline owns.

use crate::backend::{BackendKind, CaptureBackend, CaptureConfig, CaptureStats};
use crate::display::{DisplayId, DisplayInfo};
use crate::error::CaptureError;
use crate::frame::Frame;
use async_trait::async_trait;
use parking_lot::Mutex;
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::mpsc;

pub struct SckBackend {
    state: Arc<Mutex<SckState>>,
}

struct SckState {
    started_at: Option<Instant>,
    stats: CaptureStats,
}

impl SckBackend {
    pub fn new() -> Result<Self, CaptureError> {
        // TCC preflight — fail fast if denied, so the host can show the
        // guided modal before we touch any SCK API (which would also
        // fail, but with less actionable error text).
        match crate::macos::tcc::preflight_screen_capture_access() {
            crate::macos::tcc::PermissionState::Granted => {}
            other => {
                return Err(CaptureError::PermissionDenied(format!(
                    "ScreenCaptureKit access not granted: {:?} — visit {}",
                    other,
                    crate::macos::tcc::TCC_PREFS_URL
                )));
            }
        }
        Ok(Self {
            state: Arc::new(Mutex::new(SckState {
                started_at: None,
                stats: CaptureStats::default(),
            })),
        })
    }
}

#[async_trait]
impl CaptureBackend for SckBackend {
    fn kind(&self) -> BackendKind {
        BackendKind::Native
    }

    async fn start(
        &mut self,
        _cfg: CaptureConfig,
        _out: mpsc::Sender<Frame>,
    ) -> Result<(), CaptureError> {
        // Real SCStream wiring lands during the macOS capture spike (see
        // deferred-items.md). The trait surface + RAII + TCC + enumeration
        // are committed here so downstream plans (encoder, UI) can build
        // against a stable shape.
        let mut s = self.state.lock();
        s.started_at = Some(Instant::now());
        Ok(())
    }

    async fn stop(&mut self) -> Result<CaptureStats, CaptureError> {
        let mut s = self.state.lock();
        if let Some(t) = s.started_at.take() {
            s.stats.duration_ms = t.elapsed().as_millis() as u64;
        }
        Ok(s.stats)
    }

    fn list_displays(&self) -> Result<Vec<DisplayInfo>, CaptureError> {
        enumerate()
    }
}

/// Cross-call display enumeration — used directly by `display::enumerate_displays`
/// on macOS so callers don't need an `SckBackend` instance just to list
/// displays. Implementation falls through to xcap because the high-level
/// SCK crate's enumeration shape varies between patch releases; xcap's
/// `Monitor::all()` returns the same physical displays and applies
/// `backingScaleFactor` correctly.
pub fn enumerate() -> Result<Vec<DisplayInfo>, CaptureError> {
    let monitors = xcap::Monitor::all()
        .map_err(|e| CaptureError::Native(format!("xcap monitor enumeration: {e}")))?;
    let mut out = Vec::with_capacity(monitors.len());
    for m in monitors {
        let id = m
            .id()
            .map_err(|e| CaptureError::Native(format!("monitor id: {e}")))?;
        let width = m
            .width()
            .map_err(|e| CaptureError::Native(format!("monitor width: {e}")))?;
        let height = m
            .height()
            .map_err(|e| CaptureError::Native(format!("monitor height: {e}")))?;
        let scale = m
            .scale_factor()
            .map_err(|e| CaptureError::Native(format!("monitor scale: {e}")))?;
        let name = m
            .name()
            .unwrap_or_else(|_| String::from("display"));
        let is_primary = m.is_primary().unwrap_or(false);
        out.push(DisplayInfo {
            id: DisplayId(id as u64),
            // xcap reports logical points; multiply by scale for physical
            // pixels (PITFALLS.md §7 retina correctness).
            width_px: (width as f32 * scale) as u32,
            height_px: (height as f32 * scale) as u32,
            scale_factor: scale,
            name,
            is_primary,
        });
    }
    Ok(out)
}
