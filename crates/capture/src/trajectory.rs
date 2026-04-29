//! Cursor trajectory recording (Phase 19-02).
//!
//! Spawns a background thread that samples the OS cursor position at
//! ~60 Hz for the lifetime of a recording session, then writes a
//! sidecar JSON file at `<recording>.trajectory.json` on stop.
//!
//! Design invariants:
//! - Coordinates are stored in **screen space** (raw f32 px). The
//!   sidecar carries the `capture_rect` so the renderer can normalize
//!   to 0..1 against the recording.
//! - Sample rate is fixed at 60 Hz. Missed frames are dropped silently
//!   (we record the next sample we get, no retry).
//! - Click detection is best-effort. Platform hooks set a pending
//!   click timestamp; the next successful cursor sample consumes it.
//! - Failure mode: trajectory recording is best-effort. If the OS
//!   sampling API errors persistently or the write fails, we log a
//!   warning. The owning recording lifecycle is **never** aborted by
//!   trajectory failures.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// Capture rectangle in screen coordinates at recording-start time.
///
/// Stored alongside the trajectory so the renderer can map
/// (cursor_x, cursor_y) into the recorded frame's coordinate space.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct CaptureRect {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

/// One sample.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct TrajectoryFrame {
    /// Milliseconds since recording start.
    pub t_ms: u32,
    /// Screen-space x in px.
    pub x: f32,
    /// Screen-space y in px.
    pub y: f32,
    /// True when a platform click event was consumed for this sample.
    pub click: bool,
}

/// Sidecar payload. Serialized to `<recording>.trajectory.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrajectoryDto {
    /// Path to the .mp4 this trajectory belongs to.
    pub recording_path: String,
    /// Capture rectangle in screen coords at recording time.
    pub capture_rect: CaptureRect,
    pub fps: u32,
    pub frame_count: u32,
    pub frames: Vec<TrajectoryFrame>,
}

const SAMPLE_HZ: u32 = 60;
const SAMPLE_INTERVAL: Duration = Duration::from_micros(16_667); // ~1/60s
/// If we hit this many consecutive sample failures, give up — the OS
/// API is wedged. Failures up to this point are silently skipped.
const MAX_CONSECUTIVE_FAILURES: u32 = 60; // 1s at 60Hz

#[cfg(target_os = "macos")]
fn sample_cursor() -> Option<(f32, f32)> {
    crate::macos::cursor::sample_cursor()
}

#[cfg(target_os = "macos")]
type ClickObserver = crate::macos::cursor::ClickTap;

#[cfg(target_os = "macos")]
fn install_click_observer(latest_click_at: Arc<AtomicU64>) -> Result<ClickObserver, String> {
    crate::macos::cursor::install_click_tap(latest_click_at).map_err(|e| e.to_string())
}

#[cfg(target_os = "windows")]
fn sample_cursor() -> Option<(f32, f32)> {
    crate::windows::cursor::sample_cursor()
}

#[cfg(target_os = "windows")]
type ClickObserver = crate::windows::cursor::ClickHook;

#[cfg(target_os = "windows")]
fn install_click_observer(latest_click_at: Arc<AtomicU64>) -> Result<ClickObserver, String> {
    crate::windows::cursor::install_click_hook(latest_click_at).map_err(|e| e.to_string())
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn sample_cursor() -> Option<(f32, f32)> {
    None
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
struct ClickObserver;

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn install_click_observer(_latest_click_at: Arc<AtomicU64>) -> Result<ClickObserver, String> {
    Err("OS click capture is unsupported on this platform".into())
}

/// Background trajectory recorder. Created on capture start; finalized
/// on capture stop.
pub struct TrajectoryRecorder {
    stop_tx: mpsc::Sender<()>,
    join: Option<JoinHandle<()>>,
}

impl TrajectoryRecorder {
    /// Spawn the sampling thread. Sidecar is written to `output_path`
    /// when `stop()` is called.
    pub fn start(capture_rect: CaptureRect, recording_path: PathBuf, output_path: PathBuf) -> Self {
        let (stop_tx, stop_rx) = mpsc::channel::<()>();
        let join = thread::Builder::new()
            .name("trajectory-recorder".into())
            .spawn(move || {
                run_loop(capture_rect, recording_path, output_path, stop_rx);
            })
            .ok();
        Self { stop_tx, join }
    }

    /// Signal the thread to stop and wait for it to flush the sidecar.
    /// Errors are logged but never propagated to the caller — the
    /// owning recording must not be aborted by trajectory failures.
    pub fn stop(mut self) {
        let _ = self.stop_tx.send(());
        if let Some(handle) = self.join.take() {
            if let Err(e) = handle.join() {
                tracing::warn!(?e, "trajectory recorder thread panicked");
            }
        }
    }
}

fn run_loop(
    capture_rect: CaptureRect,
    recording_path: PathBuf,
    output_path: PathBuf,
    stop_rx: mpsc::Receiver<()>,
) {
    let start = Instant::now();
    let mut last_sample_wall_ms = wall_clock_millis();
    let latest_click_at = Arc::new(AtomicU64::new(0));
    let _click_observer = match install_click_observer(Arc::clone(&latest_click_at)) {
        Ok(observer) => Some(observer),
        Err(error) => {
            tracing::warn!(
                %error,
                "trajectory: OS click capture unavailable; continuing with click=false"
            );
            None
        }
    };
    let mut frames: Vec<TrajectoryFrame> = Vec::with_capacity(60 * 60); // ~1 min preallocated
    let mut consecutive_failures: u32 = 0;
    let mut next_tick = start;
    loop {
        // Stop signal? (non-blocking)
        match stop_rx.try_recv() {
            Ok(()) | Err(mpsc::TryRecvError::Disconnected) => break,
            Err(mpsc::TryRecvError::Empty) => {}
        }

        let now = Instant::now();
        if now < next_tick {
            // Sleep up to next tick; cap at 5ms so we wake to check stop.
            let remaining = next_tick - now;
            thread::sleep(remaining.min(Duration::from_millis(5)));
            continue;
        }

        match sample_cursor() {
            Some((x, y)) => {
                consecutive_failures = 0;
                let t_ms = (now - start).as_millis().min(u32::MAX as u128) as u32;
                let sample_wall_ms = wall_clock_millis();
                let click = consume_click_for_sample(
                    &latest_click_at,
                    last_sample_wall_ms,
                    sample_wall_ms,
                    x,
                    y,
                    &capture_rect,
                );
                last_sample_wall_ms = sample_wall_ms;
                frames.push(TrajectoryFrame { t_ms, x, y, click });
            }
            None => {
                consecutive_failures += 1;
                if consecutive_failures >= MAX_CONSECUTIVE_FAILURES {
                    tracing::warn!(
                        consecutive = consecutive_failures,
                        "trajectory: OS cursor API failing persistently — aborting sampler"
                    );
                    break;
                }
            }
        }

        next_tick += SAMPLE_INTERVAL;
        // If we fell behind by more than one full interval, resync to now
        // rather than burst-catch-up (which would oversample).
        if next_tick < now {
            next_tick = now + SAMPLE_INTERVAL;
        }
    }

    if let Err(e) = write_sidecar(&capture_rect, &recording_path, &output_path, &frames) {
        tracing::warn!(error = %e, path = %output_path.display(), "trajectory: sidecar write failed");
    } else {
        tracing::info!(
            frames = frames.len(),
            path = %output_path.display(),
            "trajectory: sidecar written"
        );
    }
}

fn write_sidecar(
    capture_rect: &CaptureRect,
    recording_path: &Path,
    output_path: &Path,
    frames: &[TrajectoryFrame],
) -> std::io::Result<()> {
    let dto = TrajectoryDto {
        recording_path: recording_path.to_string_lossy().into_owned(),
        capture_rect: *capture_rect,
        fps: SAMPLE_HZ,
        frame_count: frames.len() as u32,
        frames: frames.to_vec(),
    };
    let bytes = serde_json::to_vec(&dto)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    // Atomic write: tmp + rename. Same parent dir for atomicity.
    let parent = output_path.parent().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "trajectory output_path has no parent",
        )
    })?;
    let tmp = parent.join(format!(
        ".{}.tmp",
        output_path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("trajectory")
    ));
    std::fs::write(&tmp, &bytes)?;
    std::fs::rename(&tmp, output_path)?;
    Ok(())
}

/// Platform hook callbacks call this from hot paths. Keep it allocation-free
/// and non-panicking.
pub(crate) fn record_click_now(latest_click_at: &AtomicU64) {
    latest_click_at.store(wall_clock_millis(), Ordering::Release);
}

fn consume_click_for_sample(
    latest_click_at: &AtomicU64,
    previous_sample_wall_ms: u64,
    sample_wall_ms: u64,
    x: f32,
    y: f32,
    capture_rect: &CaptureRect,
) -> bool {
    let click_at = latest_click_at.load(Ordering::Acquire);
    if click_at == 0 || click_at <= previous_sample_wall_ms || click_at > sample_wall_ms {
        return false;
    }

    if latest_click_at
        .compare_exchange(click_at, 0, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return false;
    }

    capture_rect_contains(capture_rect, x, y)
}

fn capture_rect_contains(rect: &CaptureRect, x: f32, y: f32) -> bool {
    let left = rect.x.min(rect.x + rect.width);
    let right = rect.x.max(rect.x + rect.width);
    let top = rect.y.min(rect.y + rect.height);
    let bottom = rect.y.max(rect.y + rect.height);
    x >= left && x < right && y >= top && y < bottom
}

fn wall_clock_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

/// Derive the sidecar path from a recording's MP4 path.
/// `<basename>.mp4` → `<basename>.trajectory.json`.
pub fn sidecar_path_for(recording_path: &Path) -> PathBuf {
    recording_path.with_extension("trajectory.json")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sidecar_path_appends_trajectory_json() {
        let p = sidecar_path_for(Path::new("/tmp/foo.mp4"));
        assert_eq!(p, PathBuf::from("/tmp/foo.trajectory.json"));
    }

    #[test]
    fn dto_round_trips_json() {
        let dto = TrajectoryDto {
            recording_path: "/tmp/x.mp4".into(),
            capture_rect: CaptureRect {
                x: 0.0,
                y: 0.0,
                width: 1920.0,
                height: 1080.0,
            },
            fps: 60,
            frame_count: 1,
            frames: vec![TrajectoryFrame {
                t_ms: 16,
                x: 100.0,
                y: 200.0,
                click: false,
            }],
        };
        let s = serde_json::to_string(&dto).unwrap();
        let back: TrajectoryDto = serde_json::from_str(&s).unwrap();
        assert_eq!(back.frames.len(), 1);
        assert_eq!(back.frames[0].t_ms, 16);
        assert_eq!(back.fps, 60);
    }

    #[test]
    fn click_is_consumed_for_inside_sample_only() {
        let latest_click_at = AtomicU64::new(1_050);
        let rect = CaptureRect {
            x: 100.0,
            y: 200.0,
            width: 640.0,
            height: 480.0,
        };

        let clicked = consume_click_for_sample(&latest_click_at, 1_000, 1_100, 150.0, 250.0, &rect);

        assert!(clicked);
        assert_eq!(latest_click_at.load(Ordering::Acquire), 0);
    }

    #[test]
    fn click_outside_capture_rect_is_not_recorded() {
        let latest_click_at = AtomicU64::new(1_050);
        let rect = CaptureRect {
            x: 100.0,
            y: 200.0,
            width: 640.0,
            height: 480.0,
        };

        let clicked = consume_click_for_sample(&latest_click_at, 1_000, 1_100, 99.0, 250.0, &rect);

        assert!(!clicked);
        assert_eq!(latest_click_at.load(Ordering::Acquire), 0);
    }

    #[test]
    fn click_after_sample_tick_stays_pending() {
        let latest_click_at = AtomicU64::new(1_150);
        let rect = CaptureRect {
            x: 0.0,
            y: 0.0,
            width: 100.0,
            height: 100.0,
        };

        let clicked = consume_click_for_sample(&latest_click_at, 1_000, 1_100, 50.0, 50.0, &rect);

        assert!(!clicked);
        assert_eq!(latest_click_at.load(Ordering::Acquire), 1_150);
    }
}
