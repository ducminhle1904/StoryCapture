//! Windows.Graphics.Capture backend — `windows-capture = "=2.0.0"`.
//!
//! # Verified windows-capture 2.0.0 API surface (Plan 05-03 Task 0 spike)
//!
//! The following names were verified by reading the installed 2.0.0 source at
//! `~/.cargo/registry/src/.../windows-capture-2.0.0/src/`. Downstream code
//! relies on these:
//!
//!   `windows_capture::window::Window::enumerate() -> Result<Vec<Window>, Error>`
//!   `windows_capture::window::Window::from_raw_hwnd(*mut c_void) -> Window` (const)
//!   `windows_capture::window::Window::from_name(&str) -> Result<Window, Error>`
//!   `windows_capture::window::Window::foreground() -> Result<Window, Error>`
//!   `windows_capture::window::Window::title() -> Result<String, Error>`
//!   `windows_capture::window::Window::process_id() -> Result<u32, Error>` ← exists
//!   `windows_capture::window::Window::rect() -> Result<RECT, Error>`
//!   `windows_capture::window::Window::as_raw_hwnd() -> *mut c_void`
//!   `windows_capture::window::Window::is_valid() -> bool` (visible + not self-pid +
//!                                                         not tool/child window)
//!   `windows_capture::monitor::Monitor::primary() -> Result<Monitor, Error>`
//!   `windows_capture::monitor::Monitor::enumerate() -> Result<Vec<Monitor>, Error>`
//!   `windows_capture::monitor::Monitor::width() / .height() -> Result<u32, Error>`
//!
//!   `windows_capture::capture::GraphicsCaptureApiHandler` (trait) — 2.0's
//!     renamed trait (was `CaptureHandler` in 1.x):
//!       type Flags
//!       type Error: Send + Sync
//!       fn new(Context<Flags>) -> Result<Self, Error>
//!       fn on_frame_arrived(&mut self, frame: &mut Frame, InternalCaptureControl)
//!           -> Result<(), Error>
//!       fn on_closed(&mut self) -> Result<(), Error> (default = Ok(()))
//!     Plus `Self::start(settings)` (blocking) and `Self::start_free_threaded(settings)
//!          -> CaptureControl<Self, Error>` (non-blocking).
//!
//!   `windows_capture::settings::Settings::new(item, cursor, border, secondary,
//!                                              min_interval, dirty, color_format, flags)`
//!     — `item: T where T: TryInto<GraphicsCaptureItemType>`. Both `Window`
//!     and `Monitor` implement the trait (see `settings::TryIntoCaptureItemWithDetails`).
//!
//!   `windows_capture::frame::Frame::width() / .height() -> u32`
//!   `windows_capture::frame::Frame::color_format() -> ColorFormat`
//!   `windows_capture::frame::Frame::buffer() -> Result<FrameBuffer, Error>`
//!   `FrameBuffer::as_nopadding_buffer(&mut Vec<u8>) -> &[u8]`
//!
//!   `CaptureControl::stop() -> Result<(), CaptureControlError>` consumes self;
//!     posts WM_QUIT to the capture thread's message loop.
//!
//! # Drift vs RESEARCH.md
//!
//! - Trait renamed: `CaptureHandler` → `GraphicsCaptureApiHandler` (docstring,
//!   confirmed by reading `src/capture.rs`).
//! - `Settings::new` is no longer generic over a single "capture_item"; it takes
//!   a rich arg list with explicit settings structs (`CursorCaptureSettings`,
//!   `DrawBorderSettings`, etc.). We pass `::Default` for everything except the
//!   item + color format.
//! - `Window::process_id()` **does** exist (returns `Result<u32, _>`) — no
//!   fallback to `GetWindowThreadProcessId` needed for the primary path.
//!   (We still use that API for the Chromium child-walk in window.rs.)
//! - `Monitor::primary()` exists — simpler than filtering `Monitor::enumerate()`
//!   by `is_primary()` (which is not a method on this crate's Monitor).

#![cfg(target_os = "windows")]

use crate::backend::{BackendKind, CaptureBackend, CaptureConfig, CaptureStats};
use crate::display::DisplayInfo;
use crate::error::CaptureError;
use crate::events::CaptureEvent;
use crate::frame::Frame;
use crate::target::CaptureTarget;
use crate::windows::frame_from_wgc;
use async_trait::async_trait;
use parking_lot::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::mpsc;

use windows_capture::capture::{
    Context, GraphicsCaptureApiError, GraphicsCaptureApiHandler,
};
use windows_capture::frame::Frame as WgcFrame;
use windows_capture::graphics_capture_api::InternalCaptureControl;
use windows_capture::monitor::Monitor;
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
}

struct WgcState {
    started_at: Option<Instant>,
    stats: CaptureStats,
    /// Non-blocking `CaptureControl` returned by `start_free_threaded`. We
    /// `.stop()` it on backend stop to post WM_QUIT and join the capture
    /// thread. Wrapped in `Option` so we can take+consume it in `stop`.
    control: Option<
        windows_capture::capture::CaptureControl<WgcHandler, WgcHandlerError>,
    >,
}

/// User-defined handler passed to `GraphicsCaptureApiHandler::start_free_threaded`.
/// Owns the outbound frame channel + epoch + counters. Constructed on the
/// capture thread by the `new` impl — we ship dependencies through the
/// flags tuple.
struct WgcHandler {
    out: mpsc::Sender<Frame>,
    event_sink: Option<mpsc::UnboundedSender<CaptureEvent>>,
    start_epoch: Instant,
    dropped: Arc<AtomicU64>,
    delivered: Arc<AtomicU64>,
    /// Plan 06-02 — post-capture CPU crop rect (physical pixels). `None`
    /// = full-frame pass-through (existing Phase 5 behavior).
    /// `windows-capture = 2.0.0` has no native region/crop API (RESEARCH
    /// Pitfall 5 + amendment to D-07), so we crop in `on_frame_arrived`.
    crop_rect: Option<crate::windows::frame_from_wgc::PhysicalRectU32>,
}

/// Per-session flags passed through `Settings::new(flags = ...)` into
/// `GraphicsCaptureApiHandler::new(Context { flags, .. })`.
struct WgcFlags {
    out: mpsc::Sender<Frame>,
    event_sink: Option<mpsc::UnboundedSender<CaptureEvent>>,
    start_epoch: Instant,
    dropped: Arc<AtomicU64>,
    delivered: Arc<AtomicU64>,
    /// Plan 06-02 — optional crop rect (physical pixels).
    crop_rect: Option<crate::windows::frame_from_wgc::PhysicalRectU32>,
}

/// Handler-level error type. Only used to satisfy the trait bound; we never
/// return Err from `on_frame_arrived` (we do best-effort try_send and bump a
/// drop counter instead — Pitfall: never block or await in the handler).
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
            crop_rect,
        } = ctx.flags;
        Ok(Self {
            out,
            event_sink,
            start_epoch,
            dropped,
            delivered,
            crop_rect,
        })
    }

    fn on_frame_arrived(
        &mut self,
        frame: &mut WgcFrame,
        capture_control: InternalCaptureControl,
    ) -> Result<(), Self::Error> {
        // NEVER block or await inside on_frame_arrived — this is the
        // windows-capture delegate thread and backpressure becomes frame loss.
        let f = match frame_from_wgc::to_frame(frame, self.start_epoch) {
            Ok(f) => f,
            Err(e) => {
                tracing::warn!(error = %e, "frame_from_wgc failed; dropping frame");
                self.dropped.fetch_add(1, Ordering::Relaxed);
                return Ok(());
            }
        };
        // Plan 06-02 — apply post-capture CPU crop when a rect is set.
        // `to_frame` always produces FrameData::Owned with stride=width*4
        // (nopadding buffer), so the crop here is a tight row copy over
        // contiguous BGRA. Bench gate <5ms @ 1080p is tracked in
        // crates/capture/benches/windows_cpu_crop.rs.
        let f = if let Some(rect) = self.crop_rect {
            use crate::frame::FrameData;
            let (src_bytes, src_stride) = match &f.data {
                FrameData::Owned(v, stride) => (v.as_slice(), *stride),
                _ => {
                    // Native handle path would need a D3D11 readback;
                    // to_frame currently returns Owned so this branch is
                    // defensive. Drop the frame if the variant changes.
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
                    // Rect overflowed source — treat as drop, do not
                    // panic. (Validation at the IPC boundary should have
                    // rejected this; defence-in-depth.)
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
        // Target window/monitor disappeared — surface as BackendFailed so
        // the orchestrator finalizes the partial MP4 (parity with macOS
        // SCK on_stop → BackendFailed).
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
        // PITFALLS §7: per-monitor DPI awareness must be set BEFORE any
        // HMONITOR / monitor-size query so the OS reports physical pixels.
        // Failure is non-fatal (a host may have already set it).
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
            })),
            event_sink: Arc::new(Mutex::new(None)),
            dropped: Arc::new(AtomicU64::new(0)),
            delivered: Arc::new(AtomicU64::new(0)),
        })
    }

    /// Register a lifecycle-event sink before `start`. The sink receives
    /// `CaptureEvent::BackendFailed` when WGC fires `on_closed` (window
    /// disappeared, etc.). Wired by the orchestrator / Tauri host.
    pub fn set_event_sink(&self, tx: mpsc::UnboundedSender<CaptureEvent>) {
        *self.event_sink.lock() = Some(tx);
    }

    /// Number of frames dropped because the downstream channel was full.
    pub fn dropped_frames(&self) -> u64 {
        self.dropped.load(Ordering::Relaxed)
    }

    /// Number of frames successfully delivered.
    pub fn delivered_frames(&self) -> u64 {
        self.delivered.load(Ordering::Relaxed)
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
        // Build the capture item from the target. Both arms produce a
        // value implementing TryInto<GraphicsCaptureItemType>.
        let event_sink = self.event_sink.lock().clone();
        let start_epoch = Instant::now();

        // Plan 06-02 — resolve the crop rect (physical pixels) for
        // DisplayRegion targets. Logical-point rect × DPI scale =
        // physical pixels. We pull the scale from the primary monitor's
        // reported width via the shared xcap enumeration (same path
        // `WgcBackend::list_displays` uses), so the rect matches what
        // the user saw in the overlay.
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
            crop_rect,
        };

        // Plan 06-02 (D-19/D-20) — cursor is now a per-recording toggle
        // plumbed through `cfg.include_cursor` (Phase 5 D-06 default =
        // true). Color format BGRA8 so frame_from_wgc takes the fast
        // path (no channel swap). Everything else at Default.
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

        // Dispatch by target kind. `start_free_threaded` returns a
        // `CaptureControl` we can `.stop()` later from `backend.stop()`.
        let control = match cfg.target {
            CaptureTarget::Display { .. } => {
                let monitor = Monitor::primary()
                    .map_err(|e| CaptureError::Native(format!("Monitor::primary: {e}")))?;
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
                WgcHandler::start_free_threaded(settings).map_err(map_start_err)?
            }
            CaptureTarget::Window { window_id } => {
                // The isize HWND is packed into the u64 WindowId at the IPC
                // boundary; unpack and re-wrap via Window::from_raw_hwnd.
                let hwnd = window_id.0 as isize as *mut std::ffi::c_void;
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
                WgcHandler::start_free_threaded(settings).map_err(map_start_err)?
            }
            CaptureTarget::WindowByPid { pid, ref title_hint } => {
                let hwnd_opt = crate::windows::window::find_window_by_pid(
                    pid,
                    title_hint.as_deref(),
                )
                .await?;
                let hwnd = hwnd_opt
                    .ok_or(CaptureError::WindowNotFound(pid as u64))?;
                let window = Window::from_raw_hwnd(hwnd as *mut std::ffi::c_void);
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
                WgcHandler::start_free_threaded(settings).map_err(map_start_err)?
            }
            CaptureTarget::DisplayRegion { .. } => {
                // Plan 06-02 — windows-capture 2.0.0 has no native region
                // API (RESEARCH Pitfall 5). We capture the full primary
                // display and crop in `on_frame_arrived` via the
                // `crop_rect` threaded through `flags`. Falling back to
                // the primary monitor matches the Phase 5 CaptureTarget::Display
                // arm — a future plan can resolve the specific display
                // once xcap/windows-capture display id mapping lands.
                let monitor = Monitor::primary()
                    .map_err(|e| CaptureError::Native(format!("Monitor::primary: {e}")))?;
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
                WgcHandler::start_free_threaded(settings).map_err(map_start_err)?
            }
        };

        let mut s = self.state.lock();
        s.started_at = Some(Instant::now());
        s.control = Some(control);
        Ok(())
    }

    async fn stop(&mut self) -> Result<CaptureStats, CaptureError> {
        // Take the control out of state so we can consume it. Stop posts
        // WM_QUIT to the capture thread's message loop and joins.
        let control_opt = {
            let mut s = self.state.lock();
            s.control.take()
        };
        if let Some(control) = control_opt {
            // CaptureControl::stop consumes self and joins the thread. Run
            // on a blocking scope so we don't stall the async runtime.
            tokio::task::spawn_blocking(move || control.stop())
                .await
                .map_err(|e| CaptureError::Backend(format!("stop join: {e}")))?
                .map_err(|e| CaptureError::Native(format!("CaptureControl::stop: {e}")))?;
        }
        let mut s = self.state.lock();
        if let Some(t) = s.started_at.take() {
            s.stats.duration_ms = t.elapsed().as_millis() as u64;
        }
        s.stats.frames_delivered = self.delivered.load(Ordering::Acquire);
        s.stats.frames_dropped = self.dropped.load(Ordering::Acquire);
        Ok(s.stats)
    }

    fn list_displays(&self) -> Result<Vec<DisplayInfo>, CaptureError> {
        enumerate()
    }
}

fn map_start_err(e: GraphicsCaptureApiError<WgcHandlerError>) -> CaptureError {
    CaptureError::Native(format!("WgcHandler::start_free_threaded: {e}"))
}

/// Enumeration is shared with the xcap fallback backend: both go through
/// `xcap::Monitor::all()` so they agree on ordering and physical-pixel
/// dimensions. DPI awareness was set in `WgcBackend::new` before any
/// HMONITOR query.
pub fn enumerate() -> Result<Vec<DisplayInfo>, CaptureError> {
    crate::fallback::xcap_backend::enumerate()
}
