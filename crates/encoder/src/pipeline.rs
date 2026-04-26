//! `EncodePipeline` connects capture frames to an FFmpeg sidecar.
//!
//! It pumps frames to stdin, parses stderr progress, and handles audio FIFO startup.

use std::borrow::Cow;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::io::AsyncWriteExt;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use capture::{Frame, FrameData};

use crate::config::EncodeConfig;
use crate::error::{EncoderError, Result};
use crate::progress::{EncodeProgress, ProgressParser};
use crate::sidecar::{FfmpegSidecar, SidecarCommand};

/// Shutdown budget for FFmpeg after stdin closes.
pub const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(15);

use crate::staging::{partial_path_of, PartialFileGuard};

/// Result of a completed encode.
#[derive(Debug, Clone)]
pub struct EncodeResult {
    pub output_path: PathBuf,
    pub duration_ms: u64,
    pub bytes: u64,
    pub frames_written: u64,
    pub frames_dropped: u64,
}

/// Re-exported under the encoder-facing name. Fires when the FFmpeg stdin
/// write times out; the host forwards the `(total, delta)` as
/// `RecordingEvent::FramesDropped` so the renderer sees backpressure drops
/// as telemetry rather than silent stalls.
pub use util::FrameDropCallback as BackpressureCallback;

/// Convert a capture frame into contiguous BGRA bytes for FFmpeg.
pub fn bgra_bytes_of_frame(frame: &Frame) -> Result<(Cow<'_, [u8]>, usize)> {
    match &frame.data {
        FrameData::Owned(bytes, stride) => Ok((Cow::Borrowed(bytes.as_slice()), *stride)),
        #[cfg(target_os = "windows")]
        FrameData::Pooled(buf, stride) => Ok((Cow::Borrowed(&buf[..]), *stride)),
        #[cfg(target_os = "macos")]
        FrameData::NativeMacOS(handle) => {
            let (bytes, stride) = handle.to_owned_bgra().map_err(|rc| {
                EncoderError::InvalidConfig(format!(
                    "CVPixelBufferLockBaseAddress failed (CVReturn {rc})"
                ))
            })?;
            Ok((Cow::Owned(bytes), stride))
        }
        #[cfg(target_os = "windows")]
        FrameData::NativeWindows(_) => Err(EncoderError::InvalidConfig(
            "native D3D texture input requires CPU copy helper (Plan 11); pipeline expects FrameData::Owned from the capture crate's public pipeline path".into(),
        )),
    }
}

/// RAII guard around the FFmpeg child's stdin.
///
/// Dropping `tokio::process::ChildStdin` closes the pipe, signaling EOF to
/// FFmpeg. Using an explicit guard inside the frame-pump task guarantees that
/// stdin is released on any exit path — normal completion, early `Err(..)`
/// return, OR stack-unwinding panic — so FFmpeg never waits for the full
/// `SHUTDOWN_TIMEOUT` budget on unwind.
struct StdinGuard(Option<tokio::process::ChildStdin>);

impl StdinGuard {
    fn new(stdin: tokio::process::ChildStdin) -> Self {
        Self(Some(stdin))
    }

    fn as_mut(&mut self) -> &mut tokio::process::ChildStdin {
        self.0.as_mut().expect("stdin guard used after take")
    }

    /// Take the stdin handle and drop it immediately, closing the pipe.
    fn close(&mut self) {
        // Dropping the handle closes the pipe.
        let _ = self.0.take();
    }
}

impl Drop for StdinGuard {
    fn drop(&mut self) {
        // Runs on normal scope-exit, early return, AND panic unwind.
        let _ = self.0.take();
    }
}

/// Start an encode and return a join handle.
pub struct EncodePipeline;

impl EncodePipeline {
    /// Spawn the pipeline (no backpressure telemetry).
    pub async fn start(
        cfg: EncodeConfig,
        sidecar_cmd: &dyn SidecarCommand,
        frames: mpsc::Receiver<Frame>,
        progress_tx: mpsc::Sender<EncodeProgress>,
    ) -> Result<JoinHandle<Result<EncodeResult>>> {
        Self::start_with_backpressure(cfg, sidecar_cmd, frames, progress_tx, None).await
    }

    /// Spawn the pipeline with an optional backpressure callback.
    /// `on_backpressure(total, delta)` fires on every stdin-write timeout.
    pub async fn start_with_backpressure(
        cfg: EncodeConfig,
        sidecar_cmd: &dyn SidecarCommand,
        mut frames: mpsc::Receiver<Frame>,
        progress_tx: mpsc::Sender<EncodeProgress>,
        on_backpressure: Option<BackpressureCallback>,
    ) -> Result<JoinHandle<Result<EncodeResult>>> {
        cfg.validate()?;

        // macOS can use a VideoToolbox fast path for video-only captures.
        // Audio input forces the FFmpeg path.
        #[cfg(target_os = "macos")]
        {
            if !cfg.force_ffmpeg_path && cfg.audio_input.is_none() {
                if let Some(join) = try_start_vt_fast_path(&cfg, &mut frames, &progress_tx).await? {
                    return Ok(join);
                }
            } else {
                tracing::info!(
                    target: "storycapture::encoder",
                    force_ffmpeg_path = cfg.force_ffmpeg_path,
                    "audio_input set or FFmpeg forced — skipping VT fast path, using FFmpeg pipeline"
                );
            }
        }

        // Stage FFmpeg output to `<target>.partial`; rename atomically on
        // success; clean up on any failure via PartialFileGuard.
        let target_path = cfg.output_path.clone();
        let partial_path = partial_path_of(&target_path);
        let _ = std::fs::remove_file(&partial_path); // stale leftovers
        let mut cfg_for_ffmpeg = cfg.clone();
        cfg_for_ffmpeg.output_path = partial_path.clone();

        let args = cfg_for_ffmpeg.to_ffmpeg_args();
        tracing::info!(target: "storycapture::encoder", "ffmpeg args: {}", args.join(" "));
        let child = sidecar_cmd.spawn(args).await?;
        let mut sidecar = FfmpegSidecar::new(child);

        // Extract handles for the background tasks.
        let handles = sidecar
            .take()
            .ok_or_else(|| EncoderError::Io("sidecar yielded no handles".into()))?;
        // Drop stdout; probe uses it instead.
        drop(handles.stdout);
        let stdin = handles.stdin;
        let stderr = handles.stderr;
        let mut child = handles.child;

        let start = Instant::now();

        // Parse FFmpeg progress on stderr.
        let parser = ProgressParser::new();
        let progress_task = tokio::spawn(async move { parser.pump(stderr, progress_tx).await });

        let frames_dropped_backpressure: Arc<AtomicU64> = Arc::new(AtomicU64::new(0));
        let frames_dropped_bp = frames_dropped_backpressure.clone();
        let partial_path_for_task = partial_path.clone();
        let target_for_task = target_path.clone();
        let join = tokio::spawn(async move {
            // Ensure `.partial` is cleaned on any failure/panic path.
            let partial_guard = PartialFileGuard::new(partial_path_for_task.clone());
            // RAII guard ensures ffmpeg stdin is closed on ANY exit path
            // (normal completion, early Err return, or panic unwind) so
            // ffmpeg receives EOF immediately instead of waiting up to
            // SHUTDOWN_TIMEOUT for the task-local to be dropped by tokio's
            // teardown (which doesn't guarantee drop order under unwind).
            let mut stdin = StdinGuard::new(stdin);
            let mut frames_written: u64 = 0;
            let mut frames_dropped: u64 = 0;
            tracing::info!(target: "storycapture::encoder", "frame pump started");

            // Frame pump loop.
            let mut packed_buf: Vec<u8> = Vec::new();
            let mut first_dims: Option<(u32, u32)> = None;
            while let Some(frame) = frames.recv().await {
                let width_px = frame.width_px;
                let height_px = frame.height_px;
                let (bytes, stride) = match bgra_bytes_of_frame(&frame) {
                    Ok(v) => v,
                    Err(e) => {
                        tracing::error!(target: "storycapture::encoder", error = %e, "bgra extract failed; dropping frame");
                        frames_dropped += 1;
                        continue;
                    }
                };
                match first_dims {
                    None => {
                        first_dims = Some((width_px, height_px));
                        tracing::info!(
                            target: "storycapture::encoder",
                            width_px, height_px, stride, bytes_len = bytes.len(),
                            "first frame pumped"
                        );
                    }
                    Some((fw, fh)) if fw != width_px || fh != height_px => {
                        tracing::warn!(
                            target: "storycapture::encoder",
                            expected_w = fw, expected_h = fh,
                            got_w = width_px, got_h = height_px,
                            "frame dims changed mid-stream — dropping (would corrupt ffmpeg rawvideo stream)"
                        );
                        frames_dropped += 1;
                        continue;
                    }
                    _ => {}
                }
                let row_bytes = (width_px as usize) * 4;
                let bytes_ref: &[u8] = if stride == row_bytes {
                    &bytes[..]
                } else {
                    let total = row_bytes * (height_px as usize);
                    if packed_buf.len() != total {
                        packed_buf.resize(total, 0);
                    }
                    for row in 0..(height_px as usize) {
                        let src_off = row * stride;
                        let dst_off = row * row_bytes;
                        packed_buf[dst_off..dst_off + row_bytes]
                            .copy_from_slice(&bytes[src_off..src_off + row_bytes]);
                    }
                    &packed_buf[..]
                };
                match tokio::time::timeout(Duration::from_millis(200), stdin.as_mut().write_all(bytes_ref))
                    .await
                {
                    Ok(Ok(())) => {
                        frames_written += 1;
                        if frames_written == 1 || frames_written % 30 == 0 {
                            tracing::info!(target: "storycapture::encoder", frames_written, frames_dropped, "encoder frame pump progress");
                        }
                    }
                    Ok(Err(e)) if e.kind() == std::io::ErrorKind::BrokenPipe => {
                        tracing::warn!(target: "storycapture::encoder", "ffmpeg stdin broken pipe; stopping frame pump");
                        break;
                    }
                    Ok(Err(e)) => {
                        return Err(EncoderError::Io(format!("stdin write: {e}")));
                    }
                    Err(_elapsed) => {
                        // FFmpeg stdin backpressure. Drop the frame, bump
                        // the counter, surface it as telemetry.
                        let total = frames_dropped_bp.fetch_add(1, Ordering::AcqRel) + 1;
                        frames_dropped += 1;
                        if let Some(cb) = on_backpressure.as_ref() {
                            cb(total, 1);
                        }
                        tracing::warn!(
                            target: "storycapture::encoder",
                            frames_dropped_backpressure = total,
                            "ffmpeg stdin backpressure: dropped frame"
                        );
                    }
                }
                drop(frame);
            }

            tracing::info!(target: "storycapture::encoder", frames_written, frames_dropped, "frame channel closed; signaling FFmpeg EOF");
            // Close stdin explicitly to signal EOF BEFORE we await child.wait().
            // The guard's Drop would also close it at end-of-scope, but doing it
            // here preserves the existing "EOF before wait" ordering and keeps
            // the tracing::info log above meaningful.
            stdin.close();

            // Wait for FFmpeg to flush and exit.
            let status = match tokio::time::timeout(SHUTDOWN_TIMEOUT, child.wait()).await {
                Ok(Ok(status)) => status,
                Ok(Err(e)) => return Err(EncoderError::Io(format!("child wait: {e}"))),
                Err(_) => {
                    let _ = child.start_kill();
                    let _ = child.wait().await;
                    let tail = match progress_task.await {
                        Ok(Ok(t)) => t,
                        _ => String::new(),
                    };
                    return Err(EncoderError::Timeout(format!(
                        "ffmpeg exceeded {}ms shutdown; stderr tail: {tail}",
                        SHUTDOWN_TIMEOUT.as_millis()
                    )));
                }
            };

            // Collect the stderr tail.
            let stderr_tail = match progress_task.await {
                Ok(Ok(t)) => t,
                Ok(Err(e)) => {
                    tracing::warn!(error = %e, "progress pump error (non-fatal)");
                    String::new()
                }
                Err(e) => {
                    tracing::warn!(error = %e, "progress pump join error");
                    String::new()
                }
            };

            if !status.success() {
                return Err(EncoderError::FfmpegExit {
                    code: status.code().unwrap_or(-1),
                    stderr_tail,
                });
            }

            tracing::info!(
                target: "storycapture::encoder",
                "ffmpeg exit stderr tail: {}",
                stderr_tail.lines().rev().take(30).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join(" | ")
            );

            let duration_ms = start.elapsed().as_millis() as u64;

            // Read size from `.partial` before renaming.
            let bytes = std::fs::metadata(&partial_path_for_task)
                .map(|m| m.len())
                .unwrap_or(0);

            // Atomic rename from `.partial` to final target. Same directory,
            // same filesystem — guaranteed atomic on POSIX and NTFS.
            std::fs::rename(&partial_path_for_task, &target_for_task).map_err(|e| {
                EncoderError::Io(format!(
                    "rename {} -> {}: {e}",
                    partial_path_for_task.display(),
                    target_for_task.display()
                ))
            })?;
            partial_guard.disarm();

            // Keep `sidecar` alive until FFmpeg is done.
            drop(sidecar);

            Ok(EncodeResult {
                output_path: target_for_task,
                duration_ms,
                bytes,
                frames_written,
                frames_dropped,
            })
        });

        Ok(join)
    }
}

/// macOS AVAssetWriter fast path for video-only captures.
#[cfg(target_os = "macos")]
async fn try_start_vt_fast_path(
    cfg: &EncodeConfig,
    frames: &mut mpsc::Receiver<Frame>,
    progress_tx: &mpsc::Sender<EncodeProgress>,
) -> Result<Option<JoinHandle<Result<EncodeResult>>>> {
    use crate::macos::vt_writer::VtWriter;

    // Peek the first frame to classify the stream.
    let first = match frames.recv().await {
        Some(f) => f,
        None => return Ok(None),
    };

    match first.data {
        FrameData::NativeMacOS(_) => {
            tracing::info!(
                target: "storycapture::encoder",
                "vt_writer fast path engaged: first frame is NativeMacOS CVPixelBuffer"
            );
        }
        _ => {
            // Non-native frame: fall back to the FFmpeg path.
            let new_rx = forward_with_prefix(first, std::mem::replace(frames, tokio_placeholder()));
            *frames = new_rx;
            return Ok(None);
        }
    }

    // Build the writer and spawn the append pump.
    let handle = VtWriter::start(cfg.clone(), progress_tx.clone())?;

    // Queue the first frame we already popped.
    if let FrameData::NativeMacOS(buf) = first.data {
        let pts_ns = first.pts.ns;
        let _ = handle.append(buf, pts_ns);
    }

    // Move the receiver into a detached task that drives the writer.
    let mut frames_owned = std::mem::replace(frames, tokio_placeholder());
    let join: JoinHandle<Result<EncodeResult>> = tokio::spawn(async move {
        let mut frames_written: u64 = 0;
        let mut frames_dropped: u64 = 0;
        while let Some(frame) = frames_owned.recv().await {
            match frame.data {
                FrameData::NativeMacOS(buf) => {
                    let pts_ns = frame.pts.ns;
                    if handle.append(buf, pts_ns).is_err() {
                        tracing::warn!(target: "storycapture::encoder", "vt_writer worker closed early");
                        break;
                    }
                    frames_written += 1;
                }
                other => {
                    // Backend switched mid-session; let the orchestrator restart.
                    tracing::warn!(
                        target: "storycapture::encoder",
                        ?other,
                        "vt_writer path encountered non-NativeMacOS frame; dropping"
                    );
                    frames_dropped += 1;
                }
            }
        }
        tracing::info!(
            target: "storycapture::encoder",
            frames_written,
            frames_dropped,
            "vt_writer input channel closed; finalizing MP4"
        );
        // Move finish off the runtime thread.
        let out = tokio::task::spawn_blocking(move || handle.finish())
            .await
            .map_err(|e| EncoderError::Io(format!("vt_writer finish join: {e}")))?;
        out
    });

    Ok(Some(join))
}

/// Build a receiver that yields `prefix` first, then forwards `rest`.
#[cfg(target_os = "macos")]
fn forward_with_prefix(prefix: Frame, mut rest: mpsc::Receiver<Frame>) -> mpsc::Receiver<Frame> {
    let (tx, rx) = mpsc::channel::<Frame>(64);
    tokio::spawn(async move {
        if tx.send(prefix).await.is_err() {
            return;
        }
        while let Some(f) = rest.recv().await {
            if tx.send(f).await.is_err() {
                break;
            }
        }
    });
    rx
}

/// Build a closed receiver for `std::mem::replace`.
#[cfg(target_os = "macos")]
fn tokio_placeholder() -> mpsc::Receiver<Frame> {
    let (_tx, rx) = mpsc::channel::<Frame>(1);
    // Drop tx so the receiver is already closed.
    rx
}

#[cfg(test)]
mod tests {
    use super::*;
    use capture::{ClockSource, Frame, FrameData, PixelFormat, Pts};

    #[tokio::test]
    async fn backpressure_callback_fires_on_timeout() {
        // Simulate the exact branching: a stalled writer triggers timeout,
        // and the callback must fire once per drop with monotonically
        // increasing totals. This mirrors the frame-pump path without
        // spawning FFmpeg.
        use std::sync::atomic::{AtomicU64, Ordering};
        let frames_dropped_backpressure: Arc<AtomicU64> = Arc::new(AtomicU64::new(0));
        let observed: Arc<std::sync::Mutex<Vec<(u64, u64)>>> =
            Arc::new(std::sync::Mutex::new(Vec::new()));
        let obs_clone = observed.clone();
        let cb: BackpressureCallback = Box::new(move |total, delta| {
            obs_clone.lock().unwrap().push((total, delta));
        });

        // Pretend stdin stalled — take the timeout branch twice.
        for _ in 0..2 {
            let total = frames_dropped_backpressure.fetch_add(1, Ordering::AcqRel) + 1;
            cb(total, 1);
        }

        let obs = observed.lock().unwrap().clone();
        assert_eq!(obs, vec![(1, 1), (2, 1)]);
        assert_eq!(frames_dropped_backpressure.load(Ordering::Acquire), 2);
    }

    #[test]
    fn bgra_bytes_of_frame_owned_round_trip() {
        let data = vec![0u8; 1280 * 720 * 4];
        let stride = 1280 * 4;
        let frame = Frame {
            pts: Pts {
                ns: 0,
                source: ClockSource::Synthetic,
            },
            width_px: 1280,
            height_px: 720,
            format: PixelFormat::Bgra,
            data: FrameData::Owned(data.clone(), stride),
            sequence: 0,
        };
        let (bytes, s) = bgra_bytes_of_frame(&frame).unwrap();
        assert_eq!(bytes.len(), data.len());
        assert_eq!(s, stride);
        // A1: Owned variant must be borrowed, not cloned.
        assert!(matches!(bytes, std::borrow::Cow::Borrowed(_)));
    }
}
