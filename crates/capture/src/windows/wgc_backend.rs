//! Windows.Graphics.Capture backend — `windows-capture` crate.
//!
//! Per CONTEXT.md D-17, the plan calls for `=1.5.0` but crates.io's
//! `windows-capture` line is at `2.0.0`; pinned to the latest published
//! 2.x release as a Rule 3 (blocking dep) deviation — see SUMMARY.
//!
//! We deliberately keep the integration thin (matching the macOS
//! SckBackend shape): trait + lifecycle + display enumeration with
//! per-monitor DPI awareness so `width_px`/`height_px` reflect physical
//! pixels (PITFALLS §7). Real frame ingestion via the windows-capture
//! `CaptureHandler` lands during the WGC empirical spike.

use crate::backend::{BackendKind, CaptureBackend, CaptureConfig, CaptureStats};
use crate::display::{DisplayId, DisplayInfo};
use crate::error::CaptureError;
use crate::frame::Frame;
use async_trait::async_trait;
use parking_lot::Mutex;
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::mpsc;

pub struct WgcBackend {
    state: Arc<Mutex<WgcState>>,
}

struct WgcState {
    started_at: Option<Instant>,
    stats: CaptureStats,
}

impl WgcBackend {
    pub fn new() -> Result<Self, CaptureError> {
        // PITFALLS §7: Per-monitor DPI awareness must be set BEFORE any
        // HMONITOR / monitor-size query so the OS reports physical pixels.
        // The windows-capture crate handles its own setup, but we set
        // `PER_MONITOR_AWARE_V2` here defensively for our enumeration path.
        #[cfg(target_os = "windows")]
        unsafe {
            use windows::Win32::UI::HiDpi::{
                SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
            };
            // Failure is non-fatal: a process may have already had its
            // DPI awareness set by a host (e.g. Tauri webview).
            let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        }
        Ok(Self {
            state: Arc::new(Mutex::new(WgcState {
                started_at: None,
                stats: CaptureStats::default(),
            })),
        })
    }
}

#[async_trait]
impl CaptureBackend for WgcBackend {
    fn kind(&self) -> BackendKind {
        BackendKind::Native
    }

    async fn start(
        &mut self,
        _cfg: CaptureConfig,
        _out: mpsc::Sender<Frame>,
    ) -> Result<(), CaptureError> {
        // Real WGC capture session wiring lands during the Windows
        // capture spike (see deferred-items.md). Trait + lifecycle +
        // enumeration committed so dependent plans (encoder, UI) can
        // build against a stable shape.
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

/// Enumeration via xcap — like the macOS shim, this returns the same
/// physical-pixel display list as `windows-capture`'s own enumeration
/// without coupling us to that crate's enumeration shape (which has
/// shifted between 1.x and 2.x). DPI awareness was set in `WgcBackend::new`
/// so xcap's reported widths reflect physical pixels.
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
        let name = m.name().unwrap_or_else(|_| String::from("display"));
        let is_primary = m.is_primary().unwrap_or(false);
        out.push(DisplayInfo {
            id: DisplayId(id as u64),
            width_px: (width as f32 * scale) as u32,
            height_px: (height as f32 * scale) as u32,
            scale_factor: scale,
            name,
            is_primary,
        });
    }
    Ok(out)
}
