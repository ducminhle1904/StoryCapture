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
use crate::frame::{self, ClockSource, Frame, FrameData, PixelFormat, Pts};
use async_trait::async_trait;
use parking_lot::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::mpsc;

pub struct XcapBackend {
    /// Single "capture loop is active" flag: set true by `start()` via
    /// compare_exchange (also guards double-start); cleared false by
    /// `stop()` or on thread exit. The loop breaks as soon as this flips.
    active: Arc<AtomicBool>,
    paused: Arc<AtomicBool>,
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
            active: Arc::new(AtomicBool::new(false)),
            paused: Arc::new(AtomicBool::new(false)),
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
        if self
            .active
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return Err(CaptureError::Backend("xcap backend already running".into()));
        }
        // xcap is display-only: no window-capture API exists in 0.9.x.
        // Reject Window / WindowByPid variants with a typed error so the
        // fallback orchestrator can decide whether to degrade to primary
        // display or surface the failure.
        let display_id = match cfg.target {
            crate::target::CaptureTarget::Display { display_id } => display_id,
            crate::target::CaptureTarget::Window { .. } => {
                self.active.store(false, Ordering::Release);
                return Err(CaptureError::UnsupportedTarget("window"));
            }
            crate::target::CaptureTarget::WindowByPid { .. } => {
                self.active.store(false, Ordering::Release);
                return Err(CaptureError::UnsupportedTarget("window_by_pid"));
            }
            // Region capture has no xcap fallback path. The orchestrator's
            // fallback heuristic only degrades window targets; a user-chosen
            // region requires the native backend (SCK source_rect or WGC
            // CPU crop). Surface an explicit error so callers see a
            // structured reason rather than a silent full-display capture.
            crate::target::CaptureTarget::DisplayRegion { .. } => {
                self.active.store(false, Ordering::Release);
                return Err(CaptureError::UnsupportedTarget("display_region"));
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

        let active = self.active.clone();
        let paused = self.paused.clone();
        let stats = self.stats.clone();
        let start_epoch = Instant::now();

        let handle = std::thread::spawn(move || {
            // Force whole-struct capture of the SendMonitor wrapper (not
            // disjoint capture of the inner !Send Monitor field, RFC 2229).
            let monitor = monitor;
            let interval = Duration::from_millis(interval_ms);
            let mut next_tick = Instant::now();
            loop {
                if !active.load(Ordering::Acquire) {
                    break;
                }
                if paused.load(Ordering::Acquire) {
                    std::thread::sleep(interval);
                    next_tick = Instant::now() + interval;
                    continue;
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
                let seq = frame::next_sequence();
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
        const STOP_TIMEOUT_MS: u64 = 2000;
        self.active.store(false, Ordering::Release);
        let mut timed_out = false;
        if let Some(h) = self.handle.take() {
            // D-03: bound the join. xcap's `capture_image()` can block
            // inside a display-server round-trip; without this the async
            // runtime would stall indefinitely on teardown.
            match tokio::time::timeout(
                Duration::from_millis(STOP_TIMEOUT_MS),
                tokio::task::spawn_blocking(move || h.join()),
            )
            .await
            {
                Ok(Ok(Ok(()))) => {}
                Ok(Ok(Err(e))) => {
                    tracing::warn!(?e, "xcap capture thread panicked during stop");
                }
                Ok(Err(e)) => {
                    tracing::warn!(error = %e, "xcap stop spawn_blocking join error");
                }
                Err(_) => {
                    tracing::warn!(
                        timeout_ms = STOP_TIMEOUT_MS,
                        "xcap stop timed out; abandoning capture thread"
                    );
                    timed_out = true;
                }
            }
        }
        let stats_snapshot = {
            let mut stats = self.stats.lock();
            if let Some(t) = self.started_at.lock().take() {
                stats.duration_ms = t.elapsed().as_millis() as u64;
            }
            *stats
        };
        self.paused.store(false, Ordering::Release);
        if timed_out {
            return Err(CaptureError::StopTimedOut {
                timeout_ms: STOP_TIMEOUT_MS,
            });
        }
        Ok(stats_snapshot)
    }

    async fn pause(&mut self) -> Result<(), CaptureError> {
        self.paused.store(true, Ordering::Release);
        Ok(())
    }

    async fn resume(&mut self) -> Result<(), CaptureError> {
        self.paused.store(false, Ordering::Release);
        Ok(())
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

#[cfg(test)]
impl XcapBackend {
    /// Test-only: install a pre-built capture-thread handle so `stop()`
    /// can be exercised in isolation (no real display needed).
    fn inject_handle(&mut self, handle: std::thread::JoinHandle<()>) {
        self.active.store(true, Ordering::Release);
        *self.started_at.lock() = Some(Instant::now());
        self.handle = Some(handle);
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    /// D-03: a capture thread that ignores cancellation must not wedge
    /// `stop()` indefinitely. The bounded timeout should fire and return
    /// `StopTimedOut` within ~2.1s.
    #[tokio::test]
    async fn stop_times_out_when_capture_thread_hangs() {
        let mut backend = XcapBackend::new();
        let thread = std::thread::spawn(|| {
            // Simulate a blocking capture_image() call that outlives the
            // stop deadline. Tests must not stall CI; 3s is enough to
            // exceed the 2s bound with margin.
            std::thread::sleep(Duration::from_secs(3));
        });
        backend.inject_handle(thread);

        let start = Instant::now();
        let err = backend
            .stop()
            .await
            .expect_err("stop should return StopTimedOut when thread ignores cancel");
        let elapsed = start.elapsed();

        assert!(
            matches!(err, CaptureError::StopTimedOut { timeout_ms: 2000 }),
            "expected StopTimedOut, got {err:?}"
        );
        assert!(
            elapsed >= Duration::from_millis(1900) && elapsed <= Duration::from_millis(2500),
            "stop returned in {elapsed:?}, expected ~2s bound"
        );
    }

    /// Normal path: a capture thread that exits promptly lets `stop()`
    /// join cleanly and return Ok.
    #[tokio::test]
    async fn stop_returns_ok_when_thread_exits_promptly() {
        let mut backend = XcapBackend::new();
        let thread = std::thread::spawn(|| {
            // Exits immediately — simulates a well-behaved loop that saw
            // the active flag flip to false on its next tick.
        });
        backend.inject_handle(thread);

        let stats = backend.stop().await.expect("stop should succeed");
        assert_eq!(stats.frames_delivered, 0);
    }
}
