//! Windows.Graphics.Capture backend.
//!
//! Copy each frame buffer before the callback returns.

#![cfg(target_os = "windows")]

use crate::backend::{BackendKind, CaptureBackend, CaptureConfig, CaptureStats};
use crate::display::DisplayInfo;
use crate::error::CaptureError;
use crate::events::CaptureEvent;
use crate::frame::Frame;
use crate::target::CaptureTarget;
use crate::windows::frame_from_wgc;
use crate::windows::pool::{self, FramePool};
use async_trait::async_trait;
use parking_lot::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::mpsc;

use windows_capture::capture::{Context, GraphicsCaptureApiError, GraphicsCaptureApiHandler};
use windows_capture::frame::Frame as WgcFrame;
use windows_capture::graphics_capture_api::InternalCaptureControl;
use windows_capture::settings::{
    ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings,
    MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings,
};
use windows_capture::window::Window;

pub struct WgcBackend {
    state: Arc<Mutex<WgcState>>,
    event_sink: Arc<Mutex<Option<mpsc::UnboundedSender<CaptureEvent>>>>,
    dropped: Arc<AtomicU64>,
    delivered: Arc<AtomicU64>,
    paused: Arc<AtomicBool>,
    /// Shared BGRA scratch pool.
    frame_pool: FramePool,
}

type WgcCaptureControl = windows_capture::capture::CaptureControl<WgcHandler, WgcHandlerError>;

struct WgcState {
    started_at: Option<Instant>,
    stats: CaptureStats,
    /// `CaptureControl` returned by `start_free_threaded`.
    control: Option<WgcCaptureControl>,
    session: Option<WgcSession>,
}

#[derive(Clone)]
struct WgcSession {
    cfg: CaptureConfig,
    out: mpsc::Sender<Frame>,
}

/// Handler passed to `start_free_threaded`.
struct WgcHandler {
    out: mpsc::Sender<Frame>,
    event_sink: Option<mpsc::UnboundedSender<CaptureEvent>>,
    start_epoch: Instant,
    dropped: Arc<AtomicU64>,
    delivered: Arc<AtomicU64>,
    paused: Arc<AtomicBool>,
    /// Optional post-capture crop rect.
    crop_rect: Option<crate::windows::frame_from_wgc::PhysicalRectU32>,
    /// BGRA scratch pool.
    frame_pool: FramePool,
}

/// Per-session flags passed into the handler.
struct WgcFlags {
    out: mpsc::Sender<Frame>,
    event_sink: Option<mpsc::UnboundedSender<CaptureEvent>>,
    start_epoch: Instant,
    dropped: Arc<AtomicU64>,
    delivered: Arc<AtomicU64>,
    paused: Arc<AtomicBool>,
    /// Optional crop rect.
    crop_rect: Option<crate::windows::frame_from_wgc::PhysicalRectU32>,
    /// Shared BGRA scratch pool.
    frame_pool: FramePool,
}

/// Handler error type required by the trait.
#[derive(Debug)]
pub struct WgcHandlerError(String);

impl std::fmt::Display for WgcHandlerError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "WgcHandlerError({})", self.0)
    }
}

impl std::error::Error for WgcHandlerError {}

impl GraphicsCaptureApiHandler for WgcHandler {
    type Flags = WgcFlags;
    type Error = WgcHandlerError;

    fn new(ctx: Context<Self::Flags>) -> Result<Self, Self::Error> {
        let WgcFlags {
            out,
            event_sink,
            start_epoch,
            dropped,
            delivered,
            paused,
            crop_rect,
            frame_pool,
        } = ctx.flags;
        Ok(Self {
            out,
            event_sink,
            start_epoch,
            dropped,
            delivered,
            paused,
            crop_rect,
            frame_pool,
        })
    }

    fn on_frame_arrived(
        &mut self,
        frame: &mut WgcFrame,
        capture_control: InternalCaptureControl,
    ) -> Result<(), Self::Error> {
        // Never block or await in the callback.
        if self.paused.load(Ordering::Relaxed) {
            return Ok(());
        }
        let f = match frame_from_wgc::to_frame(frame, self.start_epoch, &self.frame_pool) {
            Ok(f) => f,
            Err(e) => {
                tracing::warn!(error = %e, "frame_from_wgc failed; dropping frame");
                self.dropped.fetch_add(1, Ordering::Relaxed);
                return Ok(());
            }
        };
        // Apply crop after capture when a rect is set.
        let f = if let Some(rect) = self.crop_rect {
            use crate::frame::FrameData;
            let (src_bytes, src_stride) = match &f.data {
                FrameData::Owned(v, stride) => (v.as_slice(), *stride),
                FrameData::Pooled(b, stride) => (b.as_slice(), *stride),
                _ => {
                    // Defensive fallback if the frame variant changes.
                    self.dropped.fetch_add(1, Ordering::Relaxed);
                    return Ok(());
                }
            };
            match frame_from_wgc::cpu_crop_bgra(
                src_bytes,
                f.width_px,
                f.height_px,
                src_stride,
                rect,
            ) {
                Some(cropped) => {
                    let cropped_stride = (rect.w as usize) * 4;
                    Frame {
                        pts: f.pts,
                        width_px: rect.w,
                        height_px: rect.h,
                        format: f.format,
                        data: FrameData::Owned(cropped, cropped_stride),
                        sequence: f.sequence,
                    }
                }
                None => {
                    // Drop overflowed crops.
                    self.dropped.fetch_add(1, Ordering::Relaxed);
                    return Ok(());
                }
            }
        } else {
            f
        };
        match self.out.try_send(f) {
            Ok(()) => {
                self.delivered.fetch_add(1, Ordering::Relaxed);
            }
            Err(mpsc::error::TrySendError::Full(_)) => {
                self.dropped.fetch_add(1, Ordering::Relaxed);
            }
            Err(mpsc::error::TrySendError::Closed(_)) => {
                capture_control.stop();
            }
        }
        Ok(())
    }

    fn on_closed(&mut self) -> Result<(), Self::Error> {
        // Surface target closure as a backend failure.
        if let Some(tx) = &self.event_sink {
            let _ = tx.send(CaptureEvent::BackendFailed {
                reason: "capture target closed (on_closed)".into(),
            });
        }
        Ok(())
    }
}

impl WgcBackend {
    pub fn new() -> Result<Self, CaptureError> {
        // Set per-monitor DPI awareness before any monitor query.
        unsafe {
            use windows::Win32::UI::HiDpi::{
                SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
            };
            let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        }
        Ok(Self {
            state: Arc::new(Mutex::new(WgcState {
                started_at: None,
                stats: CaptureStats::default(),
                control: None,
                session: None,
            })),
            event_sink: Arc::new(Mutex::new(None)),
            dropped: Arc::new(AtomicU64::new(0)),
            delivered: Arc::new(AtomicU64::new(0)),
            paused: Arc::new(AtomicBool::new(false)),
            frame_pool: pool::new_pool(),
        })
    }

    /// Register a lifecycle-event sink before `start()`.
    pub fn set_event_sink(&self, tx: mpsc::UnboundedSender<CaptureEvent>) {
        *self.event_sink.lock() = Some(tx);
    }

    /// Frames dropped because the downstream channel was full.
    pub fn dropped_frames(&self) -> u64 {
        self.dropped.load(Ordering::Relaxed)
    }

    /// Frames successfully delivered.
    pub fn delivered_frames(&self) -> u64 {
        self.delivered.load(Ordering::Relaxed)
    }

    async fn start_control(
        &self,
        cfg: CaptureConfig,
        out: mpsc::Sender<Frame>,
    ) -> Result<WgcCaptureControl, CaptureError> {
        // Build the capture item from the target.
        let event_sink = self.event_sink.lock().clone();
        let start_epoch = Instant::now();

        // Resolve the crop rect for display-region targets.
        let crop_rect = match &cfg.target {
            CaptureTarget::DisplayRegion { display_id, rect } => Some(
                crate::windows::helpers::resolve_region_to_physical(display_id, rect)?,
            ),
            _ => None,
        };

        let flags = WgcFlags {
            out,
            event_sink,
            start_epoch,
            dropped: self.dropped.clone(),
            delivered: self.delivered.clone(),
            paused: self.paused.clone(),
            crop_rect,
            frame_pool: self.frame_pool.clone(),
        };

        // Cursor is a per-recording toggle.
        let cursor = if cfg.include_cursor {
            CursorCaptureSettings::WithCursor
        } else {
            CursorCaptureSettings::WithoutCursor
        };
        let border = DrawBorderSettings::Default;
        let secondary = SecondaryWindowSettings::Default;
        let min_interval = MinimumUpdateIntervalSettings::Default;
        let dirty = DirtyRegionSettings::Default;
        let color_format = ColorFormat::Bgra8;

        match cfg.target {
            CaptureTarget::Display { display_id } => {
                let monitor = crate::windows::helpers::resolve_monitor(&display_id)?;
                let settings = Settings::new(
                    monitor,
                    cursor,
                    border,
                    secondary,
                    min_interval,
                    dirty,
                    color_format,
                    flags,
                );
                WgcHandler::start_free_threaded(settings).map_err(map_start_err)
            }
            CaptureTarget::Window { window_id } => {
                let hwnd = window_id.0 as isize as *mut std::ffi::c_void;
                // D-05: reject a stale HWND before handing it to WGC,
                // which would otherwise hit undefined behaviour inside
                // GraphicsCaptureItem::FromWindow.
                let is_valid = unsafe {
                    windows::Win32::UI::WindowsAndMessaging::IsWindow(
                        windows::Win32::Foundation::HWND(hwnd),
                    )
                    .as_bool()
                };
                if !is_valid {
                    return Err(CaptureError::WindowGone {
                        hwnd: window_id.0,
                    });
                }
                let window = Window::from_raw_hwnd(hwnd);
                let settings = Settings::new(
                    window,
                    cursor,
                    border,
                    secondary,
                    min_interval,
                    dirty,
                    color_format,
                    flags,
                );
                let control = WgcHandler::start_free_threaded(settings).map_err(map_start_err)?;
                tracing::info!(
                    target: "storycapture::capture",
                    hwnd = window_id.0,
                    "WgcBackend: window-target stream started — capture is focus-independent (GraphicsCaptureItem::FromWindow)"
                );
                Ok(control)
            }
            CaptureTarget::WindowByPid {
                pid,
                ref title_hint,
            } => {
                let hwnd_opt =
                    crate::windows::window::find_window_by_pid(pid, title_hint.as_deref()).await?;
                let hwnd = hwnd_opt.ok_or(CaptureError::WindowNotFound(pid as u64))?;
                // D-05: resolved HWND may have closed between enumeration
                // and start; validate before WGC touches it.
                let raw = hwnd as *mut std::ffi::c_void;
                let is_valid = unsafe {
                    windows::Win32::UI::WindowsAndMessaging::IsWindow(
                        windows::Win32::Foundation::HWND(raw),
                    )
                    .as_bool()
                };
                if !is_valid {
                    return Err(CaptureError::WindowGone {
                        hwnd: hwnd as u64,
                    });
                }
                let window = Window::from_raw_hwnd(raw);
                let settings = Settings::new(
                    window,
                    cursor,
                    border,
                    secondary,
                    min_interval,
                    dirty,
                    color_format,
                    flags,
                );
                let control = WgcHandler::start_free_threaded(settings).map_err(map_start_err)?;
                tracing::info!(
                    target: "storycapture::capture",
                    hwnd = hwnd as u64,
                    pid,
                    "WgcBackend: window-target stream started — capture is focus-independent (GraphicsCaptureItem::FromWindow, pid-resolved)"
                );
                Ok(control)
            }
            CaptureTarget::DisplayRegion { display_id, .. } => {
                let monitor = crate::windows::helpers::resolve_monitor(&display_id)?;
                let settings = Settings::new(
                    monitor,
                    cursor,
                    border,
                    secondary,
                    min_interval,
                    dirty,
                    color_format,
                    flags,
                );
                WgcHandler::start_free_threaded(settings).map_err(map_start_err)
            }
        }
    }

    async fn stop_control(control: WgcCaptureControl) -> Result<(), CaptureError> {
        tokio::task::spawn_blocking(move || control.stop())
            .await
            .map_err(|e| CaptureError::Backend(format!("stop join: {e}")))?
            .map_err(|e| CaptureError::Native(format!("CaptureControl::stop: {e}")))
    }
}

#[async_trait]
impl CaptureBackend for WgcBackend {
    fn kind(&self) -> BackendKind {
        BackendKind::Native
    }

    async fn start(
        &mut self,
        cfg: CaptureConfig,
        out: mpsc::Sender<Frame>,
    ) -> Result<(), CaptureError> {
        self.dropped.store(0, Ordering::Relaxed);
        self.delivered.store(0, Ordering::Relaxed);
        let control = self.start_control(cfg.clone(), out.clone()).await?;

        let mut s = self.state.lock();
        s.started_at = Some(Instant::now());
        s.stats = CaptureStats::default();
        s.control = Some(control);
        s.session = Some(WgcSession { cfg, out });
        self.paused.store(false, Ordering::Release);
        Ok(())
    }

    async fn stop(&mut self) -> Result<CaptureStats, CaptureError> {
        // Take control out of state so we can stop it.
        let control_opt = {
            let mut s = self.state.lock();
            s.control.take()
        };
        if let Some(control) = control_opt {
            Self::stop_control(control).await?;
        }
        let mut s = self.state.lock();
        if let Some(t) = s.started_at.take() {
            s.stats.duration_ms = t.elapsed().as_millis() as u64;
        }
        s.stats.frames_delivered = self.delivered.load(Ordering::Acquire);
        s.stats.frames_dropped = self.dropped.load(Ordering::Acquire);
        s.session = None;
        self.paused.store(false, Ordering::Release);
        Ok(s.stats)
    }

    async fn pause(&mut self) -> Result<(), CaptureError> {
        if self.paused.swap(true, Ordering::AcqRel) {
            return Ok(());
        }
        let control = {
            let mut s = self.state.lock();
            s.control.take()
        };
        if let Some(control) = control {
            if let Err(err) = Self::stop_control(control).await {
                self.paused.store(false, Ordering::Release);
                return Err(err);
            }
        }
        Ok(())
    }

    async fn resume(&mut self) -> Result<(), CaptureError> {
        if !self.paused.swap(false, Ordering::AcqRel) {
            return Ok(());
        }
        let session = {
            self.state
                .lock()
                .session
                .clone()
                .ok_or_else(|| CaptureError::Backend("WGC session missing for resume".into()))?
        };
        match self.start_control(session.cfg, session.out).await {
            Ok(control) => {
                self.state.lock().control = Some(control);
                Ok(())
            }
            Err(err) => {
                self.paused.store(true, Ordering::Release);
                Err(err)
            }
        }
    }

    fn list_displays(&self) -> Result<Vec<DisplayInfo>, CaptureError> {
        enumerate()
    }
}

fn map_start_err(e: GraphicsCaptureApiError<WgcHandlerError>) -> CaptureError {
    CaptureError::Native(format!("WgcHandler::start_free_threaded: {e}"))
}

/// Enumerate displays through xcap.
pub fn enumerate() -> Result<Vec<DisplayInfo>, CaptureError> {
    crate::fallback::xcap_backend::enumerate()
}
