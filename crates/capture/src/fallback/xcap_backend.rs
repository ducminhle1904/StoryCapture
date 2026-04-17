//! xcap fallback backend — polled screenshot capture.
//!
//! NOT zero-copy: each tick allocates an owned BGRA buffer. Higher
//! memory pressure than SCK / WGC; documented (D-18, STACK.md) and used
//! only when the native backend is unavailable. The clock source is
//! synthetic (host wall-clock-derived) because xcap doesn't expose a
//! capture-API PTS.

use crate::backend::{BackendKind, CaptureBackend, CaptureConfig, CaptureStats};
use crate::display::{DisplayId, DisplayInfo};
use crate::error::CaptureError;
use crate::frame::{ClockSource, Frame, FrameData, PixelFormat, Pts};
use async_trait::async_trait;
use parking_lot::Mutex;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};
use tokio::sync::mpsc;

pub struct XcapBackend {
    running: Arc<AtomicBool>,
    sequence: Arc<AtomicU64>,
    started_at: Arc<Mutex<Option<Instant>>>,
    stats: Arc<Mutex<CaptureStats>>,
    // `xcap::Monitor` is NOT `Send` on Windows (it holds an HMONITOR
    // pointer which windows-rs marks !Send). Run the capture loop on a
    // std::thread instead of tokio::spawn; push frames into the tokio
    // channel via `blocking_send`.
    handle: Option<std::thread::JoinHandle<()>>,
}

impl XcapBackend {
    pub fn new() -> Self {
        Self {
            running: Arc::new(AtomicBool::new(false)),
            sequence: Arc::new(AtomicU64::new(0)),
            started_at: Arc::new(Mutex::new(None)),
            stats: Arc::new(Mutex::new(CaptureStats::default())),
            handle: None,
        }
    }
}

impl Default for XcapBackend {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl CaptureBackend for XcapBackend {
    fn kind(&self) -> BackendKind {
        BackendKind::Xcap
    }

    async fn start(
        &mut self,
        cfg: CaptureConfig,
        out: mpsc::Sender<Frame>,
    ) -> Result<(), CaptureError> {
        if self.running.swap(true, Ordering::AcqRel) {
            return Err(CaptureError::Backend("xcap backend already running".into()));
        }
        // xcap is display-only: no window-capture API exists in 0.9.x.
        // Reject Window / WindowByPid variants with a typed error so the
        // fallback orchestrator can decide whether to degrade to primary
        // display (D-07) or surface the failure.
        let display_id = match cfg.target {
            crate::target::CaptureTarget::Display { display_id } => display_id,
            crate::target::CaptureTarget::Window { .. } => {
                self.running.store(false, Ordering::Release);
                return Err(CaptureError::UnsupportedTarget("window"));
            }
            crate::target::CaptureTarget::WindowByPid { .. } => {
                self.running.store(false, Ordering::Release);
                return Err(CaptureError::UnsupportedTarget("window_by_pid"));
            }
        };
        *self.started_at.lock() = Some(Instant::now());

        // Resolve the requested monitor once at startup.
        //
        // `xcap::Monitor` on Windows holds an `HMONITOR` (raw pointer) which
        // `windows-rs` marks `!Send`. Our capture thread is dedicated —
        // the HMONITOR is only ever used from the spawned thread, never
        // shared. We wrap it in a `SendMonitor` newtype that asserts Send
        // across the ownership-transfer boundary. This is sound because
        // ownership moves exactly once into the thread.
        let monitor = SendMonitor(pick_monitor(display_id)?);
        let fps = cfg.fps_target.max(1);
        let interval_ms = (1000 / fps as u64).max(1);

        let running = self.running.clone();
        let sequence = self.sequence.clone();
        let stats = self.stats.clone();
        let start_epoch = Instant::now();

        let handle = std::thread::spawn(move || {
            // Force whole-struct capture of the SendMonitor wrapper (not
            // disjoint capture of the inner !Send Monitor field, RFC 2229).
            let monitor = monitor;
            let interval = Duration::from_millis(interval_ms);
            let mut next_tick = Instant::now();
            loop {
                if !running.load(Ordering::Acquire) {
                    break;
                }
                // Sleep-until style pacing — good enough for xcap's polling
                // backend. std::thread::sleep is fine here; we're on a
                // dedicated capture thread.
                let now = Instant::now();
                if now < next_tick {
                    std::thread::sleep(next_tick - now);
                }
                next_tick += interval;
                // Capture; on failure, log + continue (don't tear down on
                // a single bad frame).
                let img = match monitor.0.capture_image() {
                    Ok(img) => img,
                    Err(e) => {
                        tracing::warn!(error = %e, "xcap capture_image failed");
                        continue;
                    }
                };
                let width_px = img.width();
                let height_px = img.height();
                let stride = (width_px as usize) * 4;
                // xcap's RgbaImage is RGBA; downstream wants BGRA, so
                // swap channels in-place.
                let mut data = img.into_raw();
                for px in data.chunks_exact_mut(4) {
                    px.swap(0, 2);
                }
                let seq = sequence.fetch_add(1, Ordering::AcqRel);
                let pts = Pts {
                    ns: start_epoch.elapsed().as_nanos() as i128,
                    source: ClockSource::Synthetic,
                };
                let frame = Frame {
                    pts,
                    width_px,
                    height_px,
                    format: PixelFormat::Bgra,
                    data: FrameData::Owned(data, stride),
                    sequence: seq,
                };
                {
                    let mut s = stats.lock();
                    s.frames_delivered += 1;
                    let bytes = (width_px as usize) * (height_px as usize) * 4;
                    if bytes > s.bytes_peak {
                        s.bytes_peak = bytes;
                    }
                }
                if out.blocking_send(frame).is_err() {
                    break;
                }
            }
        });
        self.handle = Some(handle);
        Ok(())
    }

    async fn stop(&mut self) -> Result<CaptureStats, CaptureError> {
        self.running.store(false, Ordering::Release);
        if let Some(h) = self.handle.take() {
            // Join on a blocking task so we don't stall the async runtime
            // while the xcap capture thread drains its final tick.
            let _ = tokio::task::spawn_blocking(move || h.join()).await;
        }
        let mut stats = self.stats.lock();
        if let Some(t) = self.started_at.lock().take() {
            stats.duration_ms = t.elapsed().as_millis() as u64;
        }
        Ok(*stats)
    }

    fn list_displays(&self) -> Result<Vec<DisplayInfo>, CaptureError> {
        enumerate()
    }
}

/// `xcap::Monitor` wrapper asserting `Send` for one-shot cross-thread
/// ownership transfer. The wrapped monitor is only ever touched by the
/// dedicated capture thread after transfer; no shared access.
struct SendMonitor(xcap::Monitor);
// SAFETY: the capture thread takes exclusive ownership via `move`; we
// never share this value across threads or clone it. The underlying
// HMONITOR is a kernel handle that's safe to use from any thread, the
// `!Send` marker on windows-rs is precautionary, not a soundness claim.
unsafe impl Send for SendMonitor {}

fn pick_monitor(display_id: DisplayId) -> Result<xcap::Monitor, CaptureError> {
    let monitors = xcap::Monitor::all()
        .map_err(|e| CaptureError::Native(format!("xcap monitor list: {e}")))?;
    for m in monitors {
        let id = m
            .id()
            .map_err(|e| CaptureError::Native(format!("monitor id: {e}")))?;
        if id as u64 == display_id.0 {
            return Ok(m);
        }
    }
    Err(CaptureError::DisplayNotFound(display_id))
}

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
