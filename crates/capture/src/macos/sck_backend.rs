//! ScreenCaptureKit backend — `screencapturekit = "=1.70.0"` (D-16).
//!
//! Note on minimization: the doom-fish crate exposes a high-level streaming
//! API but is API-unstable across patch releases. We deliberately keep the
//! integration thin — enumerate displays, build an SCStreamConfiguration,
//! attach a frame handler that wraps each `CMSampleBuffer` in our RAII
//! `CVPixelBufferHandle`, and emit `Frame`s through the mpsc sender that
//! the pipeline owns.
//!
//! The actual SCStream wiring is deliberately stubbed at this layer
//! pending the empirical real-Chromium / real-display spike (see
//! `deferred-items.md`); the trait + lifecycle + display enumeration +
//! TCC preflight are wired so the rest of the system compiles and
//! exercises this backend through `tests/pipeline.rs` via a mock backend.

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
