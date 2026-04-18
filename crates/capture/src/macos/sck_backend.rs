//! ScreenCaptureKit backend (`screencapturekit = "=1.5.4"`). Thin wrapper:
//! enumerate, build an `SCContentFilter`, attach a handler that wraps each
//! `CMSampleBuffer` in our RAII `CVPixelBufferHandle`, and emit `Frame`s.
//!
//! SCK crate churn — pinned to 1.5.4 exactly; the published 1.x line caps
//! here (CLAUDE.md aspires to 1.70 but no such version exists on the
//! registry). Method surfaces have shifted between releases; do not bump
//! without re-verifying against `~/.cargo/registry/.../screencapturekit`.
//!
//! TCC preflight: `SCShareableContent::get()` can succeed even when
//! Screen Recording permission is stale on Sequoia 15.1+ — the inline
//! banner's "Already granted" bypass exists because of this. Do not
//! rely on a single preflight to gate capture.

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
    /// Optional sink for lifecycle events (delegate-driven). Populated via
    /// `set_event_sink` before `start` — the Task 3 orchestrator uses this
    /// to route `BackendFailed` up to the pipeline / Tauri host.
    event_sink: Arc<Mutex<Option<mpsc::UnboundedSender<CaptureEvent>>>>,
    /// Count of frames the output handler dropped because `try_send`
    /// returned `Full`. Exposed via `dropped_frames`.
    dropped: Arc<AtomicU64>,
    delivered: Arc<AtomicU64>,
}

struct SckState {
    started_at: Option<Instant>,
    stats: CaptureStats,
    /// Live SCStream. Dropped (stop + release) in `stop()` so a subsequent
    /// `start()` builds a fresh one (Pitfall: don't reuse after stop).
    stream: Option<SCStream>,
}

impl SckBackend {
    pub fn new() -> Result<Self, CaptureError> {
        // NOTE: `CGPreflightScreenCaptureAccess` false-negatives on Sequoia
        // after ad-hoc re-signs (TCC caches per-signature). We log the
        // preflight result for diagnostics but don't gatekeep on it —
        // SCStream itself fails loudly via didStopWithError if access is
        // truly denied, which the caller treats as a backend failure and
        // falls back through the orchestrator.
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

    /// Register a lifecycle-event sink before calling `start`. The sink
    /// receives `CaptureEvent::BackendFailed` when SCK's delegate fires
    /// `didStopWithError`. Wired by the orchestrator (Task 3).
    pub fn set_event_sink(&self, tx: mpsc::UnboundedSender<CaptureEvent>) {
        *self.event_sink.lock() = Some(tx);
    }

    /// Number of frames dropped inside the output handler because the
    /// downstream channel was full. Monotonically increases across the
    /// session; reset via `stop()`.
    pub fn dropped_frames(&self) -> u64 {
        self.dropped.load(Ordering::Relaxed)
    }

    /// Build the `SCContentFilter` for a target, resolving WindowId via
    /// `SCShareableContent`. `WindowByPid` is out of scope for Plan 05-01
    /// — Plan 05-02 implements it.
    ///
    /// Return value: `(filter, width_px, height_px, source_rect_opt)`.
    /// Plan 06-02: `source_rect_opt` is `Some(CGRect)` **in logical points**
    /// for `DisplayRegion` targets, otherwise `None`. Callers applying it
    /// to `SCStreamConfiguration::with_source_rect` get kernel-side crop
    /// (no overcapture — T-06-12).
    pub(crate) fn build_filter(
        target: &CaptureTarget,
    ) -> Result<(SCContentFilter, u32, u32, Option<CGRect>), CaptureError> {
        match target {
            CaptureTarget::Display { display_id } => {
                let content = SCShareableContent::get().map_err(|e| {
                    CaptureError::Native(format!("SCShareableContent::get: {e}"))
                })?;
                // We don't have a stable mapping from the xcap-reported
                // DisplayId(u64) to SCDisplay without calling display_id().
                // Use primary display when our id matches, else first
                // display as a best-effort fallback (fine for MVP — a
                // proper SCDisplay cache belongs to a follow-up).
                let displays = content.displays();
                let disp = displays
                    .iter()
                    .find(|d| d.display_id() as u64 == display_id.0)
                    .or_else(|| displays.first())
                    .ok_or_else(|| CaptureError::Native("no SCDisplay available".into()))?;
                let width = disp.width();
                let height = disp.height();
                // NEVER pass empty excluding_windows (Pitfall 2) — the
                // builder default takes care of it when we don't call
                // `with_excluding_windows`.
                let filter = SCContentFilter::create()
                    .with_display(disp)
                    .with_excluding_windows(&[])
                    .build();
                // ^ `with_excluding_windows(&[])` is actually the form the
                // doom-fish README shows; the hang is specifically from
                // the *raw* initWithDisplay:excludingWindows:[] SDK call.
                // The 1.5.4 builder maps this to excludingWindows with a
                // null ptr + 0 count, which Apple accepts.
                Ok((filter, width, height, None))
            }
            CaptureTarget::Window { window_id } => {
                let window = crate::macos::window::resolve_sc_window_by_id(*window_id)?
                    .ok_or(CaptureError::WindowNotFound(window_id.0))?;
                let frame = window.frame();
                // Point dimensions; scale to pixels via the display's
                // backing scale. For now, assume 2x (most retina); a more
                // precise path would look up the owning display.
                let width = (frame.width * 2.0) as u32;
                let height = (frame.height * 2.0) as u32;
                let filter = SCContentFilter::create().with_window(&window).build();
                Ok((filter, width, height, None))
            }
            CaptureTarget::WindowByPid { pid, title_hint } => {
                // Single-shot resolution: the command-layer path already
                // retried via `find_window_by_pid`. Direct in-host callers
                // of this backend are expected to pass a live pid.
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
                // Point dimensions; scale to pixels via 2x (retina) —
                // same approach as the Window arm above.
                let width = (frame.width * 2.0) as u32;
                let height = (frame.height * 2.0) as u32;
                let filter = SCContentFilter::create().with_window(&window).build();
                Ok((filter, width, height, None))
            }
            // Plan 06-02 — SCK native region capture via with_source_rect.
            //
            // Invariants (RESEARCH Pattern 3 + Pitfall 7):
            //   1. source_rect is in LOGICAL POINTS — same coordinate
            //      space as `disp.frame()` returns.
            //   2. with_width / with_height use PHYSICAL PIXELS — we scale
            //      the logical rect by the display's point→pixel factor,
            //      computed from `disp.width() / disp.frame().width`.
            //   3. We do NOT call `SCContentFilter::set_content_rect`
            //      (macOS 14.2+ only); the stream-config path works on
            //      macOS 12.3+ which is StoryCapture's min target.
            //   4. Filter stays display-only (no exclude-windows).
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
                // SCK `frame()` returns logical-point dimensions; `width()`
                // returns physical pixels. Compute the source-rect +
                // pixel dimensions via the shared helper so tests and
                // production agree byte-for-byte on the rounding rules.
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
        // Resolve the SCContentFilter on a blocking thread (Pitfall 7:
        // SCShareableContent::get blocks 50–200ms).
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
            // NV12 path: SCK calls it YCbCr_420v; we'd need to widen our
            // enum to route it here. For now, force BGRA (still zero-copy).
            crate::frame::PixelFormat::Nv12 => SckPixelFormat::BGRA,
        };

        let mut config = SCStreamConfiguration::new()
            .with_width(width_px)
            .with_height(height_px)
            .with_pixel_format(sck_pf)
            .with_shows_cursor(cfg.include_cursor)
            .with_minimum_frame_interval(&frame_interval)
            .with_queue_depth(8);

        // Plan 06-02 — when the target is a DisplayRegion, apply SCK's
        // native source-rect + destination-rect crop. with_source_rect
        // takes logical points (matches disp.frame()); with_destination_rect
        // is in output-frame pixels (anchored at origin, full rect); and
        // with_scales_to_fit(false) preserves 1:1 pixel fidelity.
        if let Some(src) = source_rect {
            let dest = CGRect::new(0.0, 0.0, width_px as f64, height_px as f64);
            config = config
                .with_source_rect(src)
                .with_destination_rect(dest)
                .with_scales_to_fit(false);
        }

        // Delegate for lifecycle events. Forward to the event sink if
        // one was registered (orchestrator).
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

        // Output handler closure — runs on SCK's internal GCD queue. NEVER
        // .await. try_send (Pitfall 6). Frame metrics via atomic counters.
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
                            // Consumer went away — backend will be stopped
                            // shortly. Silently drop.
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

        // start_capture must be called AFTER add_output_handler.
        stream.start_capture().map_err(|e| {
            CaptureError::Backend(format!("SCStream::start_capture: {e}"))
        })?;

        let mut s = self.state.lock();
        s.started_at = Some(Instant::now());
        s.stream = Some(stream);
        Ok(())
    }

    async fn stop(&mut self) -> Result<CaptureStats, CaptureError> {
        // Take the stream out (holding lock only briefly) and stop it on a
        // blocking thread; Drop then releases the Swift SCStream. Rebuild
        // a fresh one on next start (Pitfall: don't reuse after stop).
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
        // Reset counters so a subsequent start is clean.
        self.delivered.store(0, Ordering::Relaxed);
        self.dropped.store(0, Ordering::Relaxed);
        Ok(stats)
    }

    fn list_displays(&self) -> Result<Vec<DisplayInfo>, CaptureError> {
        enumerate()
    }
}

/// Internal helper that computes the SCK source_rect (logical points)
/// and pixel dimensions for a `DisplayRegion` target, given the display's
/// logical-point frame width and its physical pixel width. Split out of
/// `build_filter` so unit tests can drive it without TCC.
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
        // A 1440-point logical display backed by 2880 pixels → scale 2.0.
        let rect = RegionRect { x: 100.0, y: 50.0, w: 640.0, h: 480.0 };
        let (w_px, h_px, src) = compute_region_math(&rect, 1440.0, 2880);
        assert_eq!(w_px, 1280);
        assert_eq!(h_px, 960);
        // source_rect stays in POINTS — identical to the input (Pitfall 7).
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
        // 1920-point display backed by 2880 pixels → 1.5× scale.
        let rect = RegionRect { x: 0.0, y: 0.0, w: 640.0, h: 360.0 };
        let (w_px, h_px, _src) = compute_region_math(&rect, 1920.0, 2880);
        assert_eq!(w_px, 960);
        assert_eq!(h_px, 540);
    }
}

/// Test-only hook: exposes the internal `build_filter` for unit
/// assertions on the source-rect path. Callers may construct a
/// `CaptureTarget::DisplayRegion` and read back the `Option<CGRect>`
/// without building a full SCStream.
///
/// NOTE: actual `SCContentFilter` construction still calls into
/// SCShareableContent, which requires Screen Recording TCC. We swallow
/// that error so no-TCC CI hosts can still exercise the rect math —
/// the rect computation itself is deterministic and runs *before* the
/// filter builder errors out. Returns the tuple (width_px, height_px,
/// source_rect) for DisplayRegion targets; `None` if the SCK call failed.
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

/// Cross-call display enumeration — used directly by `display::enumerate_displays`
/// on macOS so callers don't need an `SckBackend` instance just to list
/// displays. Implementation falls through to xcap because the high-level
/// SCK crate's enumeration shape varies between patch releases; xcap's
/// `Monitor::all()` returns the same physical displays and applies
/// `backingScaleFactor` correctly.
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
