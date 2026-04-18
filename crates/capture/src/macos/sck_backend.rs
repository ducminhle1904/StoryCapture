//! ScreenCaptureKit backend.
//!
//! Builds `SCContentFilter`s, wraps sample buffers, and emits `Frame`s.
//! Stay pinned to `screencapturekit = "=1.5.4"` until an upgrade is re-verified.
//! Also do not trust a single TCC preflight check on recent macOS versions.

use crate::backend::{BackendKind, CaptureBackend, CaptureConfig, CaptureStats};
use crate::display::DisplayInfo;
use crate::error::CaptureError;
use crate::events::CaptureEvent;
use crate::frame::Frame;
use crate::target::CaptureTarget;
use async_trait::async_trait;
use parking_lot::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::mpsc;

use screencapturekit::cg::CGRect;
use screencapturekit::cm::CMTime;
use screencapturekit::shareable_content::SCShareableContent;
use screencapturekit::stream::{
    configuration::{PixelFormat as SckPixelFormat, SCStreamConfiguration},
    content_filter::SCContentFilter,
    delegate_trait::StreamCallbacks,
    output_type::SCStreamOutputType,
    sc_stream::SCStream,
};

pub struct SckBackend {
    state: Arc<Mutex<SckState>>,
    /// Optional lifecycle-event sink.
    event_sink: Arc<Mutex<Option<mpsc::UnboundedSender<CaptureEvent>>>>,
    /// Frames dropped because `try_send` hit a full channel.
    dropped: Arc<AtomicU64>,
    delivered: Arc<AtomicU64>,
}

struct SckState {
    started_at: Option<Instant>,
    stats: CaptureStats,
    /// Live `SCStream`. Rebuilt on every `start()`.
    stream: Option<SCStream>,
}

impl SckBackend {
    pub fn new() -> Result<Self, CaptureError> {
        // Log preflight for diagnostics, but do not gate on it.
        let pre = crate::macos::tcc::preflight_screen_capture_access();
        tracing::info!(
            target: "capture::macos::sck_backend",
            preflight = ?pre,
            "SckBackend::new — proceeding regardless of preflight (Sequoia false-negative guard)"
        );
        Ok(Self {
            state: Arc::new(Mutex::new(SckState {
                started_at: None,
                stats: CaptureStats::default(),
                stream: None,
            })),
            event_sink: Arc::new(Mutex::new(None)),
            dropped: Arc::new(AtomicU64::new(0)),
            delivered: Arc::new(AtomicU64::new(0)),
        })
    }

    /// Register a lifecycle-event sink before `start()`.
    pub fn set_event_sink(&self, tx: mpsc::UnboundedSender<CaptureEvent>) {
        *self.event_sink.lock() = Some(tx);
    }

    /// Dropped frame count for the current session.
    pub fn dropped_frames(&self) -> u64 {
        self.dropped.load(Ordering::Relaxed)
    }

    /// Build an `SCContentFilter` and output dimensions for a target.
    ///
    /// `source_rect_opt` is in logical points when present.
    pub(crate) fn build_filter(
        target: &CaptureTarget,
    ) -> Result<(SCContentFilter, u32, u32, Option<CGRect>), CaptureError> {
        match target {
            CaptureTarget::Display { display_id } => {
                let content = SCShareableContent::get().map_err(|e| {
                    CaptureError::Native(format!("SCShareableContent::get: {e}"))
                })?;
                // Use the requested display when possible, else fall back to the first.
                let displays = content.displays();
                let disp = displays
                    .iter()
                    .find(|d| d.display_id() as u64 == display_id.0)
                    .or_else(|| displays.first())
                    .ok_or_else(|| CaptureError::Native("no SCDisplay available".into()))?;
                let width = disp.width();
                let height = disp.height();
                let filter = SCContentFilter::create()
                    .with_display(disp)
                    .with_excluding_windows(&[])
                    .build();
                // The builder handles an empty exclusion list safely.
                Ok((filter, width, height, None))
            }
            CaptureTarget::Window { window_id } => {
                let window = crate::macos::window::resolve_sc_window_by_id(*window_id)?
                    .ok_or(CaptureError::WindowNotFound(window_id.0))?;
                let frame = window.frame();
                // Approximate retina scale until we plumb the owning display.
                let width = (frame.width * 2.0) as u32;
                let height = (frame.height * 2.0) as u32;
                let filter = SCContentFilter::create().with_window(&window).build();
                Ok((filter, width, height, None))
            }
            CaptureTarget::WindowByPid { pid, title_hint } => {
                // Command-layer callers already did the retry loop.
                if let Some(h) = title_hint.as_deref() {
                    if h.len() > 256 {
                        return Err(CaptureError::Backend(
                            "title_hint exceeds 256 chars".into(),
                        ));
                    }
                    if h.chars().any(|c| c.is_ascii_control()) {
                        return Err(CaptureError::Backend(
                            "title_hint contains ASCII control chars".into(),
                        ));
                    }
                }
                let window = crate::macos::window::resolve_sc_window_by_pid_sync(
                    *pid,
                    title_hint.as_deref(),
                )?
                .ok_or(CaptureError::WindowNotFound(*pid as u64))?;
                let frame = window.frame();
                // Same 2x retina approximation as the Window branch.
                let width = (frame.width * 2.0) as u32;
                let height = (frame.height * 2.0) as u32;
                let filter = SCContentFilter::create().with_window(&window).build();
                Ok((filter, width, height, None))
            }
            // Region capture uses logical-point source rects and pixel output sizes.
            CaptureTarget::DisplayRegion { display_id, rect } => {
                let content = SCShareableContent::get().map_err(|e| {
                    CaptureError::Native(format!("SCShareableContent::get: {e}"))
                })?;
                let displays = content.displays();
                let disp = displays
                    .iter()
                    .find(|d| d.display_id() as u64 == display_id.0)
                    .or_else(|| displays.first())
                    .ok_or_else(|| CaptureError::Native("no SCDisplay available".into()))?;
                // Use shared math so tests and production round the same way.
                let frame = disp.frame();
                let (width_px, height_px, source_rect) =
                    compute_region_math(rect, frame.width, disp.width());
                let filter = SCContentFilter::create()
                    .with_display(disp)
                    .with_excluding_windows(&[])
                    .build();
                Ok((filter, width_px, height_px, Some(source_rect)))
            }
        }
    }
}

#[async_trait]
impl CaptureBackend for SckBackend {
    fn kind(&self) -> BackendKind {
        BackendKind::Native
    }

    async fn start(
        &mut self,
        cfg: CaptureConfig,
        out: mpsc::Sender<Frame>,
    ) -> Result<(), CaptureError> {
        // Resolve the filter off the async runtime.
        let target = cfg.target.clone();
        let (filter, width_px, height_px, source_rect) =
            tokio::task::spawn_blocking(move || Self::build_filter(&target))
                .await
                .map_err(|e| CaptureError::Native(format!("spawn_blocking join: {e}")))??;

        tracing::info!(
            target_kind = %cfg.target.kind_label(),
            width_px,
            height_px,
            fps = cfg.fps_target,
            "SckBackend: building SCStream"
        );

        // Frame-interval CMTime: 1 / fps seconds.
        let frame_interval = CMTime {
            value: 1,
            timescale: cfg.fps_target.max(1) as i32,
            flags: 1, // kCMTimeFlags_Valid
            epoch: 0,
        };

        let sck_pf = match cfg.pixel_format {
            crate::frame::PixelFormat::Bgra => SckPixelFormat::BGRA,
            // Force BGRA until we add native NV12 handling.
            crate::frame::PixelFormat::Nv12 => SckPixelFormat::BGRA,
        };

        let mut config = SCStreamConfiguration::new()
            .with_width(width_px)
            .with_height(height_px)
            .with_pixel_format(sck_pf)
            .with_shows_cursor(cfg.include_cursor)
            .with_minimum_frame_interval(&frame_interval)
            .with_queue_depth(8);

        // Apply native region crop when a source rect is present.
        if let Some(src) = source_rect {
            let dest = CGRect::new(0.0, 0.0, width_px as f64, height_px as f64);
            config = config
                .with_source_rect(src)
                .with_destination_rect(dest)
                .with_scales_to_fit(false);
        }

        // Forward delegate failures to the optional event sink.
        let event_sink_for_err = self.event_sink.clone();
        let event_sink_for_stop = self.event_sink.clone();
        let delegate = StreamCallbacks::new()
            .on_error(move |err| {
                let reason = format!("SCStream error: {err}");
                tracing::warn!(reason = %reason, "SckBackend: delegate on_error");
                if let Some(tx) = event_sink_for_err.lock().as_ref() {
                    let _ = tx.send(CaptureEvent::BackendFailed { reason });
                }
            })
            .on_stop(move |maybe| {
                if let Some(reason) = maybe {
                    tracing::warn!(reason = %reason, "SckBackend: delegate on_stop with error");
                    if let Some(tx) = event_sink_for_stop.lock().as_ref() {
                        let _ = tx.send(CaptureEvent::BackendFailed { reason });
                    }
                }
            });

        let mut stream = SCStream::new_with_delegate(&filter, &config, delegate);

        // Runs on SCK's GCD queue; keep it non-blocking.
        let out_for_handler = out.clone();
        let dropped_for_handler = self.dropped.clone();
        let delivered_for_handler = self.delivered.clone();
        let added = stream.add_output_handler(
            move |sample, kind| {
                if kind != SCStreamOutputType::Screen {
                    return;
                }
                if let Some(frame) = crate::macos::frame_from_sample::to_frame(&sample) {
                    match out_for_handler.try_send(frame) {
                        Ok(()) => {
                            delivered_for_handler.fetch_add(1, Ordering::Relaxed);
                        }
                        Err(tokio::sync::mpsc::error::TrySendError::Full(_)) => {
                            dropped_for_handler.fetch_add(1, Ordering::Relaxed);
                        }
                        Err(tokio::sync::mpsc::error::TrySendError::Closed(_)) => {
                            // Consumer went away; drop the frame.
                        }
                    }
                }
            },
            SCStreamOutputType::Screen,
        );
        if added.is_none() {
            return Err(CaptureError::Native(
                "SCStream::add_output_handler returned None".into(),
            ));
        }

        // Start after the output handler is attached.
        stream.start_capture().map_err(|e| {
            CaptureError::Backend(format!("SCStream::start_capture: {e}"))
        })?;

        // Evidence breadcrumb: when a window target is in use, the SCK stream
        // is bound to a specific SCWindow id — it is focus-independent by the
        // OS contract. If a future "lost frames on alt-tab" report appears,
        // the absence of this log proves we dropped to a display-target path
        // or the xcap fallback.
        if matches!(
            cfg.target,
            CaptureTarget::Window { .. } | CaptureTarget::WindowByPid { .. }
        ) {
            tracing::info!(
                target: "storycapture::capture",
                target_kind = %cfg.target.kind_label(),
                width_px,
                height_px,
                "SckBackend: window-target stream started — capture is focus-independent (SCContentFilter bound to window id)"
            );
        }

        let mut s = self.state.lock();
        s.started_at = Some(Instant::now());
        s.stream = Some(stream);
        Ok(())
    }

    async fn stop(&mut self) -> Result<CaptureStats, CaptureError> {
        // Stop the stream off-thread, then rebuild on the next start.
        let stream_opt = {
            let mut s = self.state.lock();
            s.stream.take()
        };
        if let Some(stream) = stream_opt {
            let _ = tokio::task::spawn_blocking(move || {
                let _ = stream.stop_capture();
                drop(stream);
            })
            .await;
        }
        let mut s = self.state.lock();
        if let Some(t) = s.started_at.take() {
            s.stats.duration_ms = t.elapsed().as_millis() as u64;
        }
        let mut stats = s.stats;
        stats.frames_delivered = self.delivered.load(Ordering::Relaxed);
        stats.frames_dropped = self.dropped.load(Ordering::Relaxed);
        drop(s);
        // Reset counters for the next session.
        self.delivered.store(0, Ordering::Relaxed);
        self.dropped.store(0, Ordering::Relaxed);
        Ok(stats)
    }

    fn list_displays(&self) -> Result<Vec<DisplayInfo>, CaptureError> {
        enumerate()
    }
}

/// Compute a region source rect and pixel size for display-region capture.
pub(crate) fn compute_region_math(
    rect: &crate::target::RegionRect,
    disp_logical_width: f64,
    disp_pixel_width: u32,
) -> (u32, u32, CGRect) {
    let scale = if disp_logical_width > 0.0 {
        (disp_pixel_width as f64) / disp_logical_width
    } else {
        2.0
    };
    let src = CGRect::new(rect.x, rect.y, rect.w, rect.h);
    let width_px = (rect.w * scale).round() as u32;
    let height_px = (rect.h * scale).round() as u32;
    (width_px, height_px, src)
}

#[cfg(test)]
mod region_tests {
    use super::*;
    use crate::target::RegionRect;

    #[test]
    fn region_math_retina_2x() {
        // 1440 logical points backed by 2880 pixels -> 2x scale.
        let rect = RegionRect { x: 100.0, y: 50.0, w: 640.0, h: 480.0 };
        let (w_px, h_px, src) = compute_region_math(&rect, 1440.0, 2880);
        assert_eq!(w_px, 1280);
        assert_eq!(h_px, 960);
        // Source rect stays in logical points.
        assert_eq!(src.x, 100.0);
        assert_eq!(src.y, 50.0);
        assert_eq!(src.width, 640.0);
        assert_eq!(src.height, 480.0);
    }

    #[test]
    fn region_math_non_retina_1x() {
        let rect = RegionRect { x: 0.0, y: 0.0, w: 800.0, h: 600.0 };
        let (w_px, h_px, src) = compute_region_math(&rect, 1920.0, 1920);
        assert_eq!(w_px, 800);
        assert_eq!(h_px, 600);
        assert_eq!(src.width, 800.0);
    }

    #[test]
    fn region_math_fractional_scale_1_5x() {
        // 1920 logical points backed by 2880 pixels -> 1.5x scale.
        let rect = RegionRect { x: 0.0, y: 0.0, w: 640.0, h: 360.0 };
        let (w_px, h_px, _src) = compute_region_math(&rect, 1920.0, 2880);
        assert_eq!(w_px, 960);
        assert_eq!(h_px, 540);
    }
}

/// Test hook for the display-region source-rect path.
///
/// Returns `(width_px, height_px, source_rect)` when filter construction succeeds.
#[cfg(test)]
pub(crate) fn build_filter_for_test_region(
    display_id: u64,
    rect: crate::target::RegionRect,
) -> Option<(u32, u32, Option<CGRect>)> {
    let target = CaptureTarget::DisplayRegion {
        display_id: crate::display::DisplayId(display_id),
        rect,
    };
    SckBackend::build_filter(&target)
        .ok()
        .map(|(_, w, h, r)| (w, h, r))
}

/// Enumerate displays without constructing an `SckBackend`.
///
/// This uses xcap because its monitor API is more stable than SCK's.
pub fn enumerate() -> Result<Vec<DisplayInfo>, CaptureError> {
    use crate::display::DisplayId;
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
