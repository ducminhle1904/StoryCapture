//! ScreenCaptureKit backend.
//!
//! Builds `SCContentFilter`s, wraps sample buffers, and emits `Frame`s.
//! Stay pinned to `screencapturekit = "=1.5.4"` until an upgrade is re-verified.
//! Also do not trust a single TCC preflight check on recent macOS versions.

use crate::backend::{BackendKind, CaptureBackend, CaptureConfig, CaptureStats};
use crate::display::DisplayInfo;
use crate::error::CaptureError;
use crate::events::CaptureEvent;
use crate::frame::{Frame, FrameCropRect};
use crate::target::CaptureTarget;
use async_trait::async_trait;
use core_graphics::color_space::kCGColorSpaceSRGB;
use objc2::runtime::Sel;
use parking_lot::Mutex;
use std::ffi::c_void;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::mpsc;

use screencapturekit::cg::CGRect;
use screencapturekit::cm::CMTime;
use screencapturekit::shareable_content::{SCShareableContent, SCShareableContentInfo};
use screencapturekit::stream::{
    configuration::{
        PixelFormat as SckPixelFormat, SCCaptureResolutionType, SCStreamConfiguration,
    },
    content_filter::SCContentFilter,
    delegate_trait::StreamCallbacks,
    output_type::SCStreamOutputType,
    sc_stream::SCStream,
};

/// Coarse state machine for pause/resume. `Transitioning` is set for the
/// duration of the `spawn_blocking` stop/start call so a racing caller
/// holding the mutex sees the in-progress transition and either waits for
/// it or exits early when the outer intent matches.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PauseState {
    Running,
    Paused,
    Transitioning,
}

pub struct SckBackend {
    state: Arc<Mutex<SckState>>,
    /// Optional lifecycle-event sink.
    event_sink: Arc<Mutex<Option<mpsc::UnboundedSender<CaptureEvent>>>>,
    /// Frames dropped because `try_send` hit a full channel.
    dropped: Arc<AtomicU64>,
    delivered: Arc<AtomicU64>,
    /// Fast-path read signal for the SCK output handler (hot callback on
    /// SCK's GCD queue — cannot afford to await a tokio mutex there).
    paused: Arc<AtomicBool>,
    /// Slow-path serializer for `pause()` / `resume()` callers.
    pause_state: Arc<tokio::sync::Mutex<PauseState>>,
}

struct SckState {
    started_at: Option<Instant>,
    stats: CaptureStats,
    /// Live `SCStream`. Rebuilt on every `start()`.
    stream: Option<SCStream>,
}

struct SckStreamPlan {
    filter: SCContentFilter,
    width_px: u32,
    height_px: u32,
    source_rect: Option<CGRect>,
    needs_scales_to_fit: bool,
    native_sck_crop: bool,
    crop_scale_hint: Option<f64>,
    effective_scale: Option<f64>,
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
            paused: Arc::new(AtomicBool::new(false)),
            pause_state: Arc::new(tokio::sync::Mutex::new(PauseState::Running)),
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

    fn build_stream_plan(
        target: &CaptureTarget,
        frame_crop: Option<FrameCropRect>,
    ) -> Result<SckStreamPlan, CaptureError> {
        Self::build_stream_plan_with_scale_hint(
            target,
            frame_crop,
            frame_crop.and_then(|rect| rect.scale_hint),
        )
    }

    fn build_stream_plan_with_scale_hint(
        target: &CaptureTarget,
        frame_crop: Option<FrameCropRect>,
        scale_hint: Option<f64>,
    ) -> Result<SckStreamPlan, CaptureError> {
        match target {
            CaptureTarget::Display { display_id } => {
                let content = SCShareableContent::get()
                    .map_err(|e| CaptureError::Native(format!("SCShareableContent::get: {e}")))?;
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
                let (width_px, height_px) = filter_pixel_size(&filter).unwrap_or((width, height));
                // The builder handles an empty exclusion list safely.
                Ok(SckStreamPlan {
                    filter,
                    width_px,
                    height_px,
                    source_rect: None,
                    needs_scales_to_fit: false,
                    native_sck_crop: false,
                    crop_scale_hint: scale_hint,
                    effective_scale: None,
                })
            }
            CaptureTarget::Window { window_id } => {
                let window = crate::macos::window::resolve_sc_window_by_id(*window_id)?
                    .ok_or(CaptureError::WindowNotFound(window_id.0))?;
                let frame = window.frame();
                if let Some(crop) = frame_crop {
                    validate_window_crop(crop)?;
                }
                // Request the canvas at the physical scale of the display
                // containing this window. Using the primary display scale
                // upscaled 1× external-monitor windows to 2× and softened
                // text even though Retina/MacBook captures looked correct.
                let display_scale = window_display_scale(frame)?;
                let scale = effective_window_scale(display_scale, scale_hint);
                let filter = SCContentFilter::create().with_window(&window).build();
                build_window_stream_plan(
                    filter,
                    frame,
                    display_scale,
                    scale,
                    scale_hint,
                    frame_crop,
                )
            }
            CaptureTarget::WindowByPid { pid, title_hint } => {
                // Command-layer callers already did the retry loop.
                if let Some(h) = title_hint.as_deref() {
                    if h.len() > 256 {
                        return Err(CaptureError::Backend("title_hint exceeds 256 chars".into()));
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
                if let Some(crop) = frame_crop {
                    validate_window_crop(crop)?;
                }
                // Same physical-pixel treatment as Window — derive the
                // scale from the display containing the resolved window.
                let display_scale = window_display_scale(frame)?;
                let scale = effective_window_scale(display_scale, scale_hint);
                let filter = SCContentFilter::create().with_window(&window).build();
                build_window_stream_plan(
                    filter,
                    frame,
                    display_scale,
                    scale,
                    scale_hint,
                    frame_crop,
                )
            }
            // Region capture uses logical-point source rects and pixel output sizes.
            CaptureTarget::DisplayRegion { display_id, rect } => {
                let content = SCShareableContent::get()
                    .map_err(|e| CaptureError::Native(format!("SCShareableContent::get: {e}")))?;
                let displays = content.displays();
                let disp = displays
                    .iter()
                    .find(|d| d.display_id() as u64 == display_id.0)
                    .or_else(|| displays.first())
                    .ok_or_else(|| CaptureError::Native("no SCDisplay available".into()))?;
                let filter = SCContentFilter::create()
                    .with_display(disp)
                    .with_excluding_windows(&[])
                    .build();
                let scale = filter_point_pixel_scale(&filter)
                    .unwrap_or_else(|| display_scale(disp.frame(), disp.width(), disp.height()));
                // Use shared math so tests and production round the same way.
                let (width_px, height_px, source_rect) = compute_region_math(rect, scale);
                Ok(SckStreamPlan {
                    filter,
                    width_px,
                    height_px,
                    source_rect: Some(source_rect),
                    needs_scales_to_fit: false,
                    native_sck_crop: false,
                    crop_scale_hint: scale_hint,
                    effective_scale: Some(scale),
                })
            }
        }
    }

    /// Build an `SCContentFilter` and output dimensions for a target.
    ///
    /// Returns `(filter, width_px, height_px, source_rect_opt, needs_scales_to_fit)`.
    /// `source_rect_opt` is in logical points when present.
    /// `needs_scales_to_fit` is true for window captures so SCK composites the
    /// native Retina backing store onto our physical-pixel canvas instead of
    /// padding the unused area with black.
    pub(crate) fn build_filter(
        target: &CaptureTarget,
        scale_hint: Option<f64>,
    ) -> Result<(SCContentFilter, u32, u32, Option<CGRect>, bool), CaptureError> {
        let plan = Self::build_stream_plan_with_scale_hint(target, None, scale_hint)?;
        Ok((
            plan.filter,
            plan.width_px,
            plan.height_px,
            plan.source_rect,
            plan.needs_scales_to_fit,
        ))
    }

    async fn stop_stream(&self) -> Result<(), CaptureError> {
        let stream = { self.state.lock().stream.clone() };
        let Some(stream) = stream else {
            return Ok(());
        };
        tokio::task::spawn_blocking(move || {
            stream
                .stop_capture()
                .map_err(|e| CaptureError::Backend(format!("SCStream::stop_capture: {e}")))
        })
        .await
        .map_err(|e| CaptureError::Native(format!("spawn_blocking join: {e}")))?
    }

    async fn resume_stream(&self) -> Result<(), CaptureError> {
        let stream = {
            self.state
                .lock()
                .stream
                .clone()
                .ok_or_else(|| CaptureError::Backend("SCStream missing for resume".into()))?
        };
        tokio::task::spawn_blocking(move || {
            stream
                .start_capture()
                .map_err(|e| CaptureError::Backend(format!("SCStream::start_capture: {e}")))
        })
        .await
        .map_err(|e| CaptureError::Native(format!("spawn_blocking join: {e}")))?
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
        cfg.require_supported_pixel_format()?;
        self.dropped.store(0, Ordering::Relaxed);
        self.delivered.store(0, Ordering::Relaxed);

        // Resolve the filter off the async runtime.
        let target = cfg.target.clone();
        let frame_crop_for_plan = cfg.frame_crop;
        let plan = tokio::task::spawn_blocking(move || {
            Self::build_stream_plan(&target, frame_crop_for_plan)
        })
        .await
        .map_err(|e| CaptureError::Native(format!("spawn_blocking join: {e}")))??;
        let SckStreamPlan {
            filter,
            width_px,
            height_px,
            source_rect,
            needs_scales_to_fit,
            native_sck_crop,
            crop_scale_hint,
            effective_scale,
        } = plan;

        tracing::info!(
            target: "storycapture::capture",
            target_kind = %cfg.target.kind_label(),
            width_px,
            height_px,
            fps = cfg.fps_target,
            frame_crop = ?cfg.frame_crop,
            native_sck_crop,
            crop_scale_hint,
            effective_scale,
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
            // Nv12 is rejected at start() entry above; unreachable here.
            crate::frame::PixelFormat::Nv12 => unreachable!("NV12 rejected at start()"),
        };

        let mut config = SCStreamConfiguration::new()
            .with_width(width_px)
            .with_height(height_px)
            .with_pixel_format(sck_pf)
            .with_capture_resolution_type(SCCaptureResolutionType::Best)
            .with_shows_cursor(cfg.include_cursor)
            .with_minimum_frame_interval(&frame_interval)
            .with_queue_depth(8);
        set_srgb_color_space_name(&mut config);

        // Apply native SCK crop when a source rect is present.
        if let Some(src) = source_rect {
            let dest = CGRect::new(0.0, 0.0, width_px as f64, height_px as f64);
            tracing::info!(
                target: "storycapture::capture",
                native_sck_crop,
                source_x = src.x,
                source_y = src.y,
                source_w = src.width,
                source_h = src.height,
                output_width_px = width_px,
                output_height_px = height_px,
                crop_scale_hint,
                effective_scale,
                "SckBackend: applying SCStream source rect"
            );
            config = config
                .with_source_rect(src)
                .with_destination_rect(dest)
                .with_scales_to_fit(false);
        } else if needs_scales_to_fit {
            // Window capture at physical (Retina) pixels requires
            // scales_to_fit so SCK composites the native backing store onto
            // the canvas instead of leaving unused area black.
            config = config.with_scales_to_fit(true);
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
        let paused_for_handler = self.paused.clone();
        let frame_crop = if native_sck_crop {
            None
        } else {
            cfg.frame_crop
        };
        let crop_logged = Arc::new(AtomicBool::new(false));
        let crop_logged_for_handler = crop_logged.clone();
        let added = stream.add_output_handler(
            move |sample, kind| {
                if kind != SCStreamOutputType::Screen {
                    return;
                }
                if paused_for_handler.load(Ordering::Relaxed) {
                    return;
                }
                if let Some(frame) = crate::macos::frame_from_sample::to_frame(&sample) {
                    let frame = if let Some(rect) = frame_crop {
                        let source_width_px = frame.width_px;
                        let source_height_px = frame.height_px;
                        match crate::frame::crop_bgra_frame(frame, rect) {
                            Ok(Some(cropped)) => {
                                if !crop_logged_for_handler.swap(true, Ordering::Relaxed) {
                                    tracing::info!(
                                        target: "storycapture::capture",
                                        source_width_px,
                                        source_height_px,
                                        crop_x = rect.x,
                                        crop_y = rect.y,
                                        crop_w = rect.w,
                                        crop_h = rect.h,
                                        crop_basis_w = rect.basis_w,
                                        crop_basis_h = rect.basis_h,
                                        crop_scale_hint = rect.scale_hint,
                                        output_width_px = cropped.width_px,
                                        output_height_px = cropped.height_px,
                                        "SckBackend: applied frame crop"
                                    );
                                }
                                cropped
                            }
                            Ok(None) => {
                                dropped_for_handler.fetch_add(1, Ordering::Relaxed);
                                return;
                            }
                            Err(error) => {
                                tracing::warn!(
                                    target: "storycapture::capture",
                                    %error,
                                    "SckBackend: frame crop failed; dropping frame"
                                );
                                dropped_for_handler.fetch_add(1, Ordering::Relaxed);
                                return;
                            }
                        }
                    } else {
                        frame
                    };
                    match out_for_handler.try_send(frame) {
                        Ok(()) => {
                            // Relaxed: pure counter, no data ordering depends on this. Stream-stop provides happens-before for the final read.
                            delivered_for_handler.fetch_add(1, Ordering::Relaxed);
                        }
                        Err(tokio::sync::mpsc::error::TrySendError::Full(_)) => {
                            // Relaxed: pure counter, no data ordering depends on this. Stream-stop provides happens-before for the final read.
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
        stream
            .start_capture()
            .map_err(|e| CaptureError::Backend(format!("SCStream::start_capture: {e}")))?;

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

        {
            let mut s = self.state.lock();
            s.started_at = Some(Instant::now());
            s.stats = CaptureStats::default();
            s.stream = Some(stream);
        }
        self.paused.store(false, Ordering::Release);
        // Reset state machine for the new session.
        *self.pause_state.lock().await = PauseState::Running;
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
        let mut stats = {
            let mut s = self.state.lock();
            if let Some(t) = s.started_at.take() {
                s.stats.duration_ms = t.elapsed().as_millis() as u64;
            }
            s.stats
        };
        // Relaxed load: stream stop provides happens-before for the final count.
        stats.frames_delivered = self.delivered.load(Ordering::Relaxed);
        stats.frames_dropped = self.dropped.load(Ordering::Relaxed);
        // Reset counters for the next session.
        self.delivered.store(0, Ordering::Release);
        self.dropped.store(0, Ordering::Release);
        self.paused.store(false, Ordering::Release);
        // Session ended, state machine back to Running baseline.
        *self.pause_state.lock().await = PauseState::Running;
        Ok(stats)
    }

    async fn pause(&mut self) -> Result<(), CaptureError> {
        // Slow-path serialization. Concurrent callers wait on the mutex;
        // whoever sees Paused/Transitioning returns Ok (idempotent).
        let mut guard = self.pause_state.lock().await;
        match *guard {
            PauseState::Paused | PauseState::Transitioning => return Ok(()),
            PauseState::Running => {}
        }
        *guard = PauseState::Transitioning;
        drop(guard);

        let stop_res = self.stop_stream().await;

        let mut guard = self.pause_state.lock().await;
        match stop_res {
            Ok(()) => {
                self.paused.store(true, Ordering::Release);
                *guard = PauseState::Paused;
                Ok(())
            }
            Err(err) => {
                // Roll back on failure so a retry is possible.
                *guard = PauseState::Running;
                Err(err)
            }
        }
    }

    async fn resume(&mut self) -> Result<(), CaptureError> {
        let mut guard = self.pause_state.lock().await;
        match *guard {
            PauseState::Running | PauseState::Transitioning => return Ok(()),
            PauseState::Paused => {}
        }
        *guard = PauseState::Transitioning;
        drop(guard);

        let start_res = self.resume_stream().await;

        let mut guard = self.pause_state.lock().await;
        match start_res {
            Ok(()) => {
                self.paused.store(false, Ordering::Release);
                *guard = PauseState::Running;
                Ok(())
            }
            Err(err) => {
                *guard = PauseState::Paused;
                Err(err)
            }
        }
    }

    fn list_displays(&self) -> Result<Vec<DisplayInfo>, CaptureError> {
        enumerate()
    }
}

/// ScreenCaptureKit defaults to the display color space when `colorSpaceName`
/// is unspecified. On wide-gamut macOS displays that yields Display P3 buffers,
/// while our encoder path writes SDR BT.709. Use the CoreGraphics CFString
/// constant directly instead of screencapturekit 1.5.4's Swift String bridge,
/// which can trap in `SCStreamConfiguration.copyWithZone` on macOS 26.4.
fn set_srgb_color_space_name(config: &mut SCStreamConfiguration) {
    unsafe {
        let config_ptr = *(config as *mut SCStreamConfiguration as *mut *mut c_void);
        let color_space_name = kCGColorSpaceSRGB as *const c_void;
        sc_stream_configuration_set_color_space_name_cfstring(config_ptr, color_space_name);
    }
    tracing::info!(
        target: "storycapture::capture",
        color_space_name = "kCGColorSpaceSRGB",
        "SckBackend: requested sRGB capture color space"
    );
}

fn sc_stream_configuration_set_color_space_name_cfstring(
    config: *mut c_void,
    color_space_name: *const c_void,
) {
    unsafe {
        objc_msg_send_set_color_space_name(
            config,
            objc2::sel!(setColorSpaceName:),
            color_space_name,
        );
    }
}

#[link(name = "objc")]
unsafe extern "C" {
    #[link_name = "objc_msgSend"]
    fn objc_msg_send_set_color_space_name(
        receiver: *mut c_void,
        selector: Sel,
        color_space_name: *const c_void,
    );
}

/// Pick the primary display's backing scale factor. Used by window capture
/// to request a physical-pixel canvas on Retina displays. Falls back to 1.0
/// (non-Retina) when enumeration fails, so a failure degrades to legacy
/// behavior instead of crashing.
fn primary_display_scale() -> f32 {
    enumerate()
        .unwrap_or_default()
        .iter()
        .find(|d| d.is_primary)
        .map(|d| d.scale_factor)
        .unwrap_or(1.0)
        .max(1.0)
}

fn rect_intersection_area(a: CGRect, b: CGRect) -> f64 {
    let left = a.x.max(b.x);
    let top = a.y.max(b.y);
    let right = (a.x + a.width).min(b.x + b.width);
    let bottom = (a.y + a.height).min(b.y + b.height);
    let width = (right - left).max(0.0);
    let height = (bottom - top).max(0.0);
    width * height
}

fn display_scale(logical_frame: CGRect, width_px: u32, height_px: u32) -> f64 {
    let scale_x = if logical_frame.width > 0.0 {
        width_px as f64 / logical_frame.width
    } else {
        0.0
    };
    let scale_y = if logical_frame.height > 0.0 {
        height_px as f64 / logical_frame.height
    } else {
        0.0
    };
    if scale_x.is_finite() && scale_y.is_finite() && scale_x > 0.0 && scale_y > 0.0 {
        ((scale_x + scale_y) / 2.0).max(1.0)
    } else {
        scale_x.max(scale_y).max(1.0)
    }
}

fn filter_content_info(filter: &SCContentFilter) -> Option<(u32, u32, f64, CGRect)> {
    let info = SCShareableContentInfo::for_filter(filter)?;
    let (width, height) = info.pixel_size();
    let scale = f64::from(info.point_pixel_scale()).max(1.0);
    let rect = info.content_rect();
    if width > 0 && height > 0 && scale.is_finite() {
        Some((width, height, scale, rect))
    } else {
        None
    }
}

fn filter_pixel_size(filter: &SCContentFilter) -> Option<(u32, u32)> {
    filter_content_info(filter).map(|(width, height, ..)| (width, height))
}

fn filter_point_pixel_scale(filter: &SCContentFilter) -> Option<f64> {
    filter_content_info(filter).map(|(_, _, scale, _)| scale)
}

fn normalize_scale_hint(scale_hint: Option<f64>) -> Option<f64> {
    let scale = scale_hint?;
    if scale.is_finite() && scale >= 1.0 && scale <= 4.0 {
        Some(scale)
    } else {
        None
    }
}

fn effective_window_scale(display_scale: f64, scale_hint: Option<f64>) -> f64 {
    let base = if display_scale.is_finite() && display_scale > 0.0 {
        display_scale
    } else {
        1.0
    };
    normalize_scale_hint(scale_hint)
        .map(|hint| hint.max(base))
        .unwrap_or(base)
}

fn log_window_canvas_scale(
    frame: CGRect,
    display_scale: f64,
    scale_hint: Option<f64>,
    effective_scale: f64,
    width_px: u32,
    height_px: u32,
) {
    let hint = normalize_scale_hint(scale_hint);
    if hint.is_some_and(|hint| hint > display_scale + 0.01) {
        tracing::warn!(
            target: "storycapture::capture",
            window_w = frame.width,
            window_h = frame.height,
            display_scale,
            scale_hint = hint,
            effective_scale,
            width_px,
            height_px,
            "SckBackend: using capture scale hint for window Retina canvas"
        );
    } else {
        tracing::info!(
            target: "storycapture::capture",
            window_w = frame.width,
            window_h = frame.height,
            display_scale,
            scale_hint = hint,
            effective_scale,
            width_px,
            height_px,
            "SckBackend: resolved window capture canvas"
        );
    }
}

fn build_window_stream_plan(
    filter: SCContentFilter,
    frame: CGRect,
    display_scale: f64,
    effective_scale: f64,
    scale_hint: Option<f64>,
    frame_crop: Option<FrameCropRect>,
) -> Result<SckStreamPlan, CaptureError> {
    if let Some(crop) = frame_crop {
        let (width_px, height_px, source_rect) =
            compute_window_crop_math(crop, frame.width, frame.height, effective_scale).ok_or_else(
                || {
                    CaptureError::Backend(format!(
                        "invalid window frame_crop for native SCK crop: {:?}",
                        crop
                    ))
                },
            )?;
        tracing::info!(
            target: "storycapture::capture",
            native_sck_crop = true,
            source_x = source_rect.x,
            source_y = source_rect.y,
            source_w = source_rect.width,
            source_h = source_rect.height,
            output_width_px = width_px,
            output_height_px = height_px,
            scale_hint = normalize_scale_hint(scale_hint),
            effective_scale,
            window_w = frame.width,
            window_h = frame.height,
            "SckBackend: planned native SCK window crop"
        );
        Ok(SckStreamPlan {
            filter,
            width_px,
            height_px,
            source_rect: Some(source_rect),
            needs_scales_to_fit: false,
            native_sck_crop: true,
            crop_scale_hint: scale_hint,
            effective_scale: Some(effective_scale),
        })
    } else {
        let (width_px, height_px) = window_canvas_size(frame, effective_scale);
        log_window_canvas_scale(
            frame,
            display_scale,
            scale_hint,
            effective_scale,
            width_px,
            height_px,
        );
        Ok(SckStreamPlan {
            filter,
            width_px,
            height_px,
            source_rect: None,
            needs_scales_to_fit: true,
            native_sck_crop: false,
            crop_scale_hint: scale_hint,
            effective_scale: Some(effective_scale),
        })
    }
}

fn validate_window_crop(crop: FrameCropRect) -> Result<(), CaptureError> {
    match (crop.basis_w, crop.basis_h) {
        (None, None) => Ok(()),
        (Some(w), Some(h)) if w > 0 && h > 0 => Ok(()),
        _ => Err(CaptureError::Backend(format!(
            "invalid window frame_crop basis: {:?}",
            crop
        ))),
    }
}

fn window_canvas_size(frame: CGRect, effective_scale: f64) -> (u32, u32) {
    (
        (frame.width * effective_scale).round().max(1.0) as u32,
        (frame.height * effective_scale).round().max(1.0) as u32,
    )
}

fn window_display_scale(window_frame: CGRect) -> Result<f64, CaptureError> {
    let content = SCShareableContent::get()
        .map_err(|e| CaptureError::Native(format!("SCShareableContent::get: {e}")))?;
    let displays = content.displays();
    let mut best: Option<(f64, u32, f64, CGRect, u32, u32)> = None;

    for display in displays.iter() {
        let display_frame = display.frame();
        let area = rect_intersection_area(window_frame, display_frame);
        let scale = display_scale(display_frame, display.width(), display.height());
        let display_id = display.display_id();
        if best
            .as_ref()
            .map(|(best_area, ..)| area > *best_area)
            .unwrap_or(true)
        {
            best = Some((
                area,
                display_id,
                scale,
                display_frame,
                display.width(),
                display.height(),
            ));
        }
    }

    let Some((area, display_id, scale, display_frame, display_width_px, display_height_px)) = best
    else {
        return Ok(primary_display_scale() as f64);
    };

    tracing::info!(
        window_x = window_frame.x,
        window_y = window_frame.y,
        window_w = window_frame.width,
        window_h = window_frame.height,
        matched_display_id = display_id,
        matched_display_overlap_area = area,
        matched_display_x = display_frame.x,
        matched_display_y = display_frame.y,
        matched_display_w = display_frame.width,
        matched_display_h = display_frame.height,
        matched_display_width_px = display_width_px,
        matched_display_height_px = display_height_px,
        matched_display_scale = scale,
        "SckBackend: resolved window display scale"
    );

    Ok(scale)
}

/// Compute a region source rect and pixel size for display-region capture.
pub(crate) fn compute_region_math(
    rect: &crate::target::RegionRect,
    point_pixel_scale: f64,
) -> (u32, u32, CGRect) {
    let scale = if point_pixel_scale.is_finite() && point_pixel_scale > 0.0 {
        point_pixel_scale
    } else {
        1.0
    };
    let src = CGRect::new(rect.x, rect.y, rect.w, rect.h);
    let width_px = (rect.w * scale).round() as u32;
    let height_px = (rect.h * scale).round() as u32;
    (width_px, height_px, src)
}

fn compute_window_crop_math(
    rect: FrameCropRect,
    window_logical_w: f64,
    window_logical_h: f64,
    effective_scale: f64,
) -> Option<(u32, u32, CGRect)> {
    if rect.w == 0
        || rect.h == 0
        || !window_logical_w.is_finite()
        || !window_logical_h.is_finite()
        || !effective_scale.is_finite()
        || window_logical_w <= 0.0
        || window_logical_h <= 0.0
        || effective_scale <= 0.0
    {
        return None;
    }

    let (mut x, mut y, mut w, mut h) = match (rect.basis_w, rect.basis_h) {
        (Some(basis_w), Some(basis_h)) if basis_w > 0 && basis_h > 0 => {
            let scale_x = window_logical_w / basis_w as f64;
            let scale_y = window_logical_h / basis_h as f64;
            (
                rect.x as f64 * scale_x,
                rect.y as f64 * scale_y,
                rect.w as f64 * scale_x,
                rect.h as f64 * scale_y,
            )
        }
        _ => (rect.x as f64, rect.y as f64, rect.w as f64, rect.h as f64),
    };

    if !x.is_finite() || !y.is_finite() || !w.is_finite() || !h.is_finite() {
        return None;
    }
    if x < 0.0 || y < 0.0 || w <= 0.0 || h <= 0.0 || x >= window_logical_w || y >= window_logical_h
    {
        return None;
    }

    if x + w > window_logical_w {
        w = window_logical_w - x;
    }
    if y + h > window_logical_h {
        h = window_logical_h - y;
    }
    if w <= 0.0 || h <= 0.0 {
        return None;
    }

    // SCK source rects are logical points; stream width/height are pixels.
    x = clamp_near_zero(x);
    y = clamp_near_zero(y);
    let source_rect = CGRect::new(x, y, w, h);
    let width_px = (w * effective_scale).round().max(1.0) as u32;
    let height_px = (h * effective_scale).round().max(1.0) as u32;
    Some((width_px, height_px, source_rect))
}

fn clamp_near_zero(value: f64) -> f64 {
    if value.abs() < f64::EPSILON {
        0.0
    } else {
        value
    }
}

#[cfg(test)]
mod pause_state_tests {
    use super::PauseState;
    use std::sync::Arc;
    use tokio::sync::Mutex;

    /// Simulate `pause()` / `resume()` against a shared `PauseState`
    /// without requiring a real `SCStream`. Mirrors the branching in
    /// the real backend so a regression in the state machine surfaces
    /// here even when SCK hardware tests are skipped.
    async fn simulate_pause(state: Arc<Mutex<PauseState>>, work_ms: u64) -> bool {
        let mut guard = state.lock().await;
        match *guard {
            PauseState::Paused | PauseState::Transitioning => return false,
            PauseState::Running => {}
        }
        *guard = PauseState::Transitioning;
        drop(guard);
        tokio::time::sleep(std::time::Duration::from_millis(work_ms)).await;
        let mut guard = state.lock().await;
        *guard = PauseState::Paused;
        true
    }

    async fn simulate_resume(state: Arc<Mutex<PauseState>>, work_ms: u64) -> bool {
        let mut guard = state.lock().await;
        match *guard {
            PauseState::Running | PauseState::Transitioning => return false,
            PauseState::Paused => {}
        }
        *guard = PauseState::Transitioning;
        drop(guard);
        tokio::time::sleep(std::time::Duration::from_millis(work_ms)).await;
        let mut guard = state.lock().await;
        *guard = PauseState::Running;
        true
    }

    #[tokio::test]
    async fn concurrent_pause_is_idempotent_and_finalises_paused() {
        let state = Arc::new(Mutex::new(PauseState::Running));
        let a = tokio::spawn(simulate_pause(state.clone(), 30));
        let b = tokio::spawn(simulate_pause(state.clone(), 30));
        let (ra, rb) = (a.await.unwrap(), b.await.unwrap());
        // Exactly one caller wins the transition; the other no-ops.
        assert!(ra ^ rb, "expected exactly one winner");
        assert_eq!(*state.lock().await, PauseState::Paused);
    }

    #[tokio::test]
    async fn concurrent_resume_mid_transition_ends_in_running() {
        // Start in Paused so resume() is meaningful.
        let state = Arc::new(Mutex::new(PauseState::Paused));
        let a = tokio::spawn(simulate_resume(state.clone(), 30));
        let b = tokio::spawn(simulate_resume(state.clone(), 30));
        let (ra, rb) = (a.await.unwrap(), b.await.unwrap());
        assert!(ra ^ rb, "expected exactly one winner");
        assert_eq!(*state.lock().await, PauseState::Running);
    }

    #[tokio::test]
    async fn pause_then_resume_round_trip() {
        let state = Arc::new(Mutex::new(PauseState::Running));
        assert!(simulate_pause(state.clone(), 5).await);
        assert_eq!(*state.lock().await, PauseState::Paused);
        assert!(simulate_resume(state.clone(), 5).await);
        assert_eq!(*state.lock().await, PauseState::Running);
    }
}

#[cfg(test)]
mod region_tests {
    use super::*;
    use crate::target::RegionRect;

    #[test]
    fn region_math_retina_2x() {
        // 1440 logical points backed by 2880 pixels -> 2x scale.
        let rect = RegionRect {
            x: 100.0,
            y: 50.0,
            w: 640.0,
            h: 480.0,
        };
        let (w_px, h_px, src) = compute_region_math(&rect, 2.0);
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
        let rect = RegionRect {
            x: 0.0,
            y: 0.0,
            w: 800.0,
            h: 600.0,
        };
        let (w_px, h_px, src) = compute_region_math(&rect, 1.0);
        assert_eq!(w_px, 800);
        assert_eq!(h_px, 600);
        assert_eq!(src.width, 800.0);
    }

    #[test]
    fn region_math_fractional_scale_1_5x() {
        // 1920 logical points backed by 2880 pixels -> 1.5x scale.
        let rect = RegionRect {
            x: 0.0,
            y: 0.0,
            w: 640.0,
            h: 360.0,
        };
        let (w_px, h_px, _src) = compute_region_math(&rect, 1.5);
        assert_eq!(w_px, 960);
        assert_eq!(h_px, 540);
    }

    #[test]
    fn display_scale_uses_display_backing_ratio() {
        let logical = CGRect::new(-1920.0, -137.0, 1920.0, 1080.0);
        assert_eq!(display_scale(logical, 1920, 1080), 1.0);

        let retina = CGRect::new(0.0, 0.0, 1728.0, 1117.0);
        assert_eq!(display_scale(retina, 3456, 2234), 2.0);
    }

    #[test]
    fn rect_intersection_area_picks_external_window_overlap() {
        let window = CGRect::new(-1920.0, -137.0, 1440.0, 987.0);
        let external = CGRect::new(-1920.0, -137.0, 1920.0, 1080.0);
        let internal = CGRect::new(0.0, 0.0, 1728.0, 1117.0);

        assert!(rect_intersection_area(window, external) > 1_000_000.0);
        assert_eq!(rect_intersection_area(window, internal), 0.0);
    }

    #[test]
    fn window_crop_math_retina_2x_keeps_logical_source_rect() {
        let crop = FrameCropRect {
            x: 0,
            y: 0,
            w: 1800,
            h: 1012,
            basis_w: None,
            basis_h: None,
            scale_hint: Some(2.0),
        };

        let (w_px, h_px, src) = compute_window_crop_math(crop, 1800.0, 1012.0, 2.0).unwrap();

        assert_eq!(w_px, 3600);
        assert_eq!(h_px, 2024);
        assert_eq!(src.x, 0.0);
        assert_eq!(src.y, 0.0);
        assert_eq!(src.width, 1800.0);
        assert_eq!(src.height, 1012.0);
    }

    #[test]
    fn window_crop_math_scales_basis_to_window_logical_points() {
        let crop = FrameCropRect {
            x: 100,
            y: 80,
            w: 900,
            h: 506,
            basis_w: Some(1800),
            basis_h: Some(1012),
            scale_hint: Some(2.0),
        };

        let (w_px, h_px, src) = compute_window_crop_math(crop, 900.0, 506.0, 2.0).unwrap();

        assert_eq!(w_px, 900);
        assert_eq!(h_px, 506);
        assert_eq!(src.x, 50.0);
        assert_eq!(src.y, 40.0);
        assert_eq!(src.width, 450.0);
        assert_eq!(src.height, 253.0);
    }

    #[test]
    fn window_crop_with_basis_is_valid_for_native_window_crop() {
        let crop = FrameCropRect {
            x: 0,
            y: 88,
            w: 1800,
            h: 1012,
            basis_w: Some(1800),
            basis_h: Some(1100),
            scale_hint: Some(2.0),
        };

        assert!(validate_window_crop(crop).is_ok());
    }

    #[test]
    fn window_crop_without_basis_can_use_native_crop() {
        let crop = FrameCropRect {
            x: 0,
            y: 88,
            w: 1800,
            h: 1012,
            basis_w: None,
            basis_h: None,
            scale_hint: Some(2.0),
        };

        assert!(validate_window_crop(crop).is_ok());
    }

    #[test]
    fn window_crop_with_partial_basis_is_invalid() {
        let crop = FrameCropRect {
            x: 0,
            y: 88,
            w: 1800,
            h: 1012,
            basis_w: Some(1800),
            basis_h: None,
            scale_hint: Some(2.0),
        };

        assert!(validate_window_crop(crop).is_err());
    }

    #[test]
    fn native_window_crop_with_basis_uses_physical_crop_size() {
        let frame = CGRect::new(0.0, 0.0, 900.0, 550.0);
        let crop = FrameCropRect {
            x: 0,
            y: 44,
            w: 900,
            h: 506,
            basis_w: Some(900),
            basis_h: Some(550),
            scale_hint: Some(2.0),
        };

        assert!(validate_window_crop(crop).is_ok());
        let (width_px, height_px, source_rect) =
            compute_window_crop_math(crop, frame.width, frame.height, 2.0).unwrap();
        assert_eq!(width_px, 1800);
        assert_eq!(height_px, 1012);
        assert_eq!(source_rect.y, 44.0);
        assert_eq!(source_rect.height, 506.0);
    }

    #[test]
    fn native_window_crop_honors_retina_scale_hint() {
        let crop = FrameCropRect {
            x: 0,
            y: 87,
            w: 1800,
            h: 1012,
            basis_w: Some(1800),
            basis_h: Some(1099),
            scale_hint: Some(2.0),
        };
        let (width_px, height_px, source_rect) =
            compute_window_crop_math(crop, 1800.0, 1099.0, 2.0).unwrap();

        assert_eq!(width_px, 3600);
        assert_eq!(height_px, 2024);
        assert_eq!(source_rect.x, 0.0);
        assert_eq!(source_rect.y, 87.0);
        assert_eq!(source_rect.width, 1800.0);
        assert_eq!(source_rect.height, 1012.0);
    }

    #[test]
    fn window_crop_math_rounds_fractional_scale_output() {
        let crop = FrameCropRect {
            x: 10,
            y: 20,
            w: 333,
            h: 222,
            basis_w: None,
            basis_h: None,
            scale_hint: Some(1.5),
        };

        let (w_px, h_px, src) = compute_window_crop_math(crop, 800.0, 600.0, 1.5).unwrap();

        assert_eq!(w_px, 500);
        assert_eq!(h_px, 333);
        assert_eq!(src.x, 10.0);
        assert_eq!(src.y, 20.0);
        assert_eq!(src.width, 333.0);
        assert_eq!(src.height, 222.0);
    }

    #[test]
    fn window_crop_math_rejects_invalid_crop() {
        let zero = FrameCropRect {
            x: 0,
            y: 0,
            w: 0,
            h: 100,
            basis_w: None,
            basis_h: None,
            scale_hint: Some(2.0),
        };
        assert!(compute_window_crop_math(zero, 800.0, 600.0, 2.0).is_none());

        let outside = FrameCropRect {
            x: 801,
            y: 0,
            w: 10,
            h: 10,
            basis_w: None,
            basis_h: None,
            scale_hint: Some(2.0),
        };
        assert!(compute_window_crop_math(outside, 800.0, 600.0, 2.0).is_none());

        let valid = FrameCropRect {
            x: 790,
            y: 590,
            w: 20,
            h: 20,
            basis_w: None,
            basis_h: None,
            scale_hint: Some(2.0),
        };
        let (w_px, h_px, src) = compute_window_crop_math(valid, 800.0, 600.0, 2.0).unwrap();
        assert_eq!(w_px, 20);
        assert_eq!(h_px, 20);
        assert_eq!(src.width, 10.0);
        assert_eq!(src.height, 10.0);
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
    SckBackend::build_filter(&target, None)
        .ok()
        .map(|(_, w, h, r, _)| (w, h, r))
}

#[cfg(test)]
mod nv12_reject_tests {
    use super::*;
    use crate::display::DisplayId;
    use crate::frame::PixelFormat;
    use crate::target::CaptureTarget;

    #[test]
    fn effective_window_scale_uses_larger_valid_hint() {
        assert_eq!(effective_window_scale(1.0, Some(2.0)), 2.0);
        assert_eq!(effective_window_scale(2.0, Some(1.0)), 2.0);
        assert_eq!(effective_window_scale(1.0, Some(f64::NAN)), 1.0);
        assert_eq!(effective_window_scale(1.0, Some(8.0)), 1.0);
    }

    /// Nv12 must be rejected at `start()` entry before any OS resource is
    /// acquired. We don't need SCK permissions or a real display for this
    /// — the guard runs before `build_filter`.
    #[tokio::test]
    async fn start_with_nv12_returns_unsupported_pixel_format() {
        let Ok(mut backend) = SckBackend::new() else {
            // CI macOS runners may lack the SCK framework at link time.
            return;
        };
        let mut cfg = CaptureConfig::new(DisplayId(1));
        cfg.pixel_format = PixelFormat::Nv12;
        // Use a display target; the guard fires before any filter build.
        cfg.target = CaptureTarget::Display {
            display_id: DisplayId(1),
        };
        let (tx, _rx) = tokio::sync::mpsc::channel(1);
        let err = backend
            .start(cfg, tx)
            .await
            .expect_err("Nv12 must be rejected");
        assert!(
            matches!(
                err,
                CaptureError::UnsupportedPixelFormat {
                    format: PixelFormat::Nv12
                }
            ),
            "expected UnsupportedPixelFormat{{format=Nv12}}, got {err:?}"
        );
    }
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
        let x = m
            .x()
            .map_err(|e| CaptureError::Native(format!("monitor x: {e}")))?;
        let y = m
            .y()
            .map_err(|e| CaptureError::Native(format!("monitor y: {e}")))?;
        let scale = m
            .scale_factor()
            .map_err(|e| CaptureError::Native(format!("monitor scale: {e}")))?;
        let name = m.name().unwrap_or_else(|_| String::from("display"));
        let is_primary = m.is_primary().unwrap_or(false);
        out.push(DisplayInfo {
            id: DisplayId(id as u64),
            width_px: (width as f32 * scale) as u32,
            height_px: (height as f32 * scale) as u32,
            x,
            y,
            scale_factor: scale,
            name,
            is_primary,
        });
    }
    Ok(out)
}
