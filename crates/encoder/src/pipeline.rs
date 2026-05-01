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

#[derive(Debug, Clone, Copy)]
struct FrameSampleMetrics {
    sample_count: u64,
    luma_mean: f64,
    luma_stddev: f64,
    luma_min: u8,
    luma_max: u8,
    edge_mean: f64,
    dark_pct: f64,
    bright_pct: f64,
}

impl FrameSampleMetrics {
    fn from_bgra(bytes: &[u8], width_px: u32, height_px: u32, stride: usize) -> Option<Self> {
        let width = width_px as usize;
        let height = height_px as usize;
        if width == 0 || height == 0 || stride < width.saturating_mul(4) {
            return None;
        }

        let step_x = (width / 96).max(1);
        let step_y = (height / 54).max(1);
        let mut sample_count = 0_u64;
        let mut sum = 0_f64;
        let mut sum_sq = 0_f64;
        let mut min_luma = u8::MAX;
        let mut max_luma = u8::MIN;
        let mut dark = 0_u64;
        let mut bright = 0_u64;
        let mut edge_sum = 0_f64;
        let mut edge_count = 0_u64;

        for y in (0..height).step_by(step_y) {
            for x in (0..width).step_by(step_x) {
                let Some(luma) = bgra_luma_at(bytes, stride, width, height, x, y) else {
                    continue;
                };
                let luma_f = f64::from(luma);
                sample_count += 1;
                sum += luma_f;
                sum_sq += luma_f * luma_f;
                min_luma = min_luma.min(luma);
                max_luma = max_luma.max(luma);
                if luma < 32 {
                    dark += 1;
                }
                if luma > 224 {
                    bright += 1;
                }

                if x + step_x < width {
                    if let Some(right) = bgra_luma_at(bytes, stride, width, height, x + step_x, y) {
                        edge_sum += (i16::from(luma) - i16::from(right)).unsigned_abs() as f64;
                        edge_count += 1;
                    }
                }
                if y + step_y < height {
                    if let Some(down) = bgra_luma_at(bytes, stride, width, height, x, y + step_y) {
                        edge_sum += (i16::from(luma) - i16::from(down)).unsigned_abs() as f64;
                        edge_count += 1;
                    }
                }
            }
        }

        if sample_count == 0 {
            return None;
        }

        let mean = sum / sample_count as f64;
        let variance = (sum_sq / sample_count as f64 - mean * mean).max(0.0);
        Some(Self {
            sample_count,
            luma_mean: mean,
            luma_stddev: variance.sqrt(),
            luma_min: min_luma,
            luma_max: max_luma,
            edge_mean: if edge_count > 0 {
                edge_sum / edge_count as f64
            } else {
                0.0
            },
            dark_pct: dark as f64 * 100.0 / sample_count as f64,
            bright_pct: bright as f64 * 100.0 / sample_count as f64,
        })
    }
}

fn bgra_luma_at(
    bytes: &[u8],
    stride: usize,
    width: usize,
    height: usize,
    x: usize,
    y: usize,
) -> Option<u8> {
    if x >= width || y >= height {
        return None;
    }
    let offset = y.checked_mul(stride)?.checked_add(x.checked_mul(4)?)?;
    if offset + 2 >= bytes.len() {
        return None;
    }
    let b = u16::from(bytes[offset]);
    let g = u16::from(bytes[offset + 1]);
    let r = u16::from(bytes[offset + 2]);
    Some(((77 * r + 150 * g + 29 * b + 128) >> 8) as u8)
}

fn should_log_frame_sample(frame_index: u64) -> bool {
    frame_index == 1 || frame_index % 300 == 0
}

fn log_frame_sample_metrics(
    frame_index: u64,
    bytes: &[u8],
    width_px: u32,
    height_px: u32,
    stride: usize,
) {
    match FrameSampleMetrics::from_bgra(bytes, width_px, height_px, stride) {
        Some(metrics) => {
            tracing::info!(
                target: "storycapture::encoder",
                frame_index,
                width_px,
                height_px,
                stride,
                sample_count = metrics.sample_count,
                luma_mean = metrics.luma_mean,
                luma_stddev = metrics.luma_stddev,
                luma_min = metrics.luma_min,
                luma_max = metrics.luma_max,
                edge_mean = metrics.edge_mean,
                dark_pct = metrics.dark_pct,
                bright_pct = metrics.bright_pct,
                "encoder input frame sample metrics"
            );
        }
        None => {
            tracing::warn!(
                target: "storycapture::encoder",
                frame_index,
                width_px,
                height_px,
                stride,
                bytes_len = bytes.len(),
                "encoder input frame sample metrics unavailable"
            );
        }
    }
}

#[derive(Debug, Default, Clone, Copy)]
struct FfmpegSummaryMetrics {
    x264_avg_qp_i: Option<f64>,
    x264_avg_qp_p: Option<f64>,
    x264_avg_qp_b: Option<f64>,
    x264_kbps: Option<f64>,
    encode_speed: Option<f64>,
}

impl FfmpegSummaryMetrics {
    fn has_any(self) -> bool {
        self.x264_avg_qp_i.is_some()
            || self.x264_avg_qp_p.is_some()
            || self.x264_avg_qp_b.is_some()
            || self.x264_kbps.is_some()
            || self.encode_speed.is_some()
    }
}

fn parse_ffmpeg_summary_metrics(stderr_tail: &str) -> FfmpegSummaryMetrics {
    let mut metrics = FfmpegSummaryMetrics::default();
    for line in stderr_tail.lines() {
        if line.contains("frame I:") {
            metrics.x264_avg_qp_i = parse_number_after(line, "Avg QP:");
        } else if line.contains("frame P:") {
            metrics.x264_avg_qp_p = parse_number_after(line, "Avg QP:");
        } else if line.contains("frame B:") {
            metrics.x264_avg_qp_b = parse_number_after(line, "Avg QP:");
        }
        if line.contains("kb/s:") {
            metrics.x264_kbps = parse_number_after(line, "kb/s:");
        }
        if line.contains("speed=") {
            metrics.encode_speed = parse_number_after(line, "speed=");
        }
    }
    metrics
}

fn parse_number_after(line: &str, needle: &str) -> Option<f64> {
    let rest = line.get(line.find(needle)? + needle.len()..)?.trim_start();
    let number_len = rest
        .char_indices()
        .take_while(|(_, ch)| ch.is_ascii_digit() || matches!(ch, '.' | '-'))
        .map(|(idx, ch)| idx + ch.len_utf8())
        .last()?;
    rest.get(..number_len)?.parse().ok()
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FrameWriteOutcome {
    Written,
    BrokenPipe,
    DroppedBackpressure,
}

async fn write_frame_bytes_to_ffmpeg(
    stdin: &mut StdinGuard,
    bytes: &[u8],
    timeout: Option<Duration>,
) -> Result<FrameWriteOutcome> {
    let write_fut = stdin.as_mut().write_all(bytes);
    let write_outcome = match timeout {
        Some(t) => tokio::time::timeout(t, write_fut).await,
        None => Ok(write_fut.await),
    };
    match write_outcome {
        Ok(Ok(())) => Ok(FrameWriteOutcome::Written),
        Ok(Err(e)) if e.kind() == std::io::ErrorKind::BrokenPipe => {
            Ok(FrameWriteOutcome::BrokenPipe)
        }
        Ok(Err(e)) => Err(EncoderError::Io(format!("stdin write: {e}"))),
        Err(_elapsed) => Ok(FrameWriteOutcome::DroppedBackpressure),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct CfrTimingPlan {
    duplicate_previous: u64,
    write_current: bool,
}

fn cfr_timing_plan(
    first_pts_ns: i128,
    current_pts_ns: i128,
    frame_duration_ns: i128,
    frames_written: u64,
) -> CfrTimingPlan {
    let rel_ns = current_pts_ns.saturating_sub(first_pts_ns).max(0);
    let desired_before_current = (rel_ns / frame_duration_ns.max(1)) as u64;
    if frames_written > desired_before_current {
        return CfrTimingPlan {
            duplicate_previous: 0,
            write_current: false,
        };
    }
    CfrTimingPlan {
        duplicate_previous: desired_before_current.saturating_sub(frames_written),
        write_current: true,
    }
}

#[cfg(any(target_os = "macos", test))]
fn strict_vt_native_frames_required(cfg: &EncodeConfig) -> bool {
    let output_area = u64::from(cfg.output_width).saturating_mul(u64::from(cfg.output_height));
    let capture_area = u64::from(cfg.capture_width).saturating_mul(u64::from(cfg.capture_height));
    cfg.realtime_encoding
        && cfg.fps_advisory >= 50
        && output_area.max(capture_area) > 1920_u64 * 1080_u64
}

#[cfg(any(target_os = "macos", test))]
fn frame_data_kind(data: &FrameData) -> &'static str {
    match data {
        #[cfg(target_os = "macos")]
        FrameData::NativeMacOS(_) => "NativeMacOS",
        #[cfg(target_os = "windows")]
        FrameData::NativeWindows(_) => "NativeWindows",
        #[cfg(target_os = "windows")]
        FrameData::Pooled(_, _) => "Pooled",
        FrameData::Owned(_, _) => "Owned",
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
                    encoder_path = "ffmpeg_rawvideo",
                    force_ffmpeg_path = cfg.force_ffmpeg_path,
                    has_audio_input = cfg.audio_input.is_some(),
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
        let frames_dropped_mismatch: Arc<AtomicU64> = Arc::new(AtomicU64::new(0));
        let frames_dropped_mismatch_task = frames_dropped_mismatch.clone();
        let partial_path_for_task = partial_path.clone();
        let target_for_task = target_path.clone();
        let stdin_write_timeout = cfg.stdin_write_timeout_ms.map(Duration::from_millis);
        let expected_capture_dims = cfg.capture_dims;
        let frame_duration_ns = (1_000_000_000i128 / i128::from(cfg.fps_advisory.max(1))).max(1);
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
            let mut timing_duplicate_frames: u64 = 0;
            let mut timing_skipped_frames: u64 = 0;
            tracing::info!(target: "storycapture::encoder", "frame pump started");

            // Frame pump loop.
            let mut packed_buf: Vec<u8> = Vec::new();
            let mut last_frame_buf: Vec<u8> = Vec::new();
            let mut first_pts_ns: Option<i128> = None;
            let mut first_dims: Option<(u32, u32)> = None;
            while let Some(frame) = frames.recv().await {
                let pts_ns = frame.pts.ns;
                let width_px = frame.width_px;
                let height_px = frame.height_px;
                if let Some((exp_w, exp_h)) = expected_capture_dims {
                    if exp_w != width_px || exp_h != height_px {
                        let total = frames_dropped_mismatch_task.fetch_add(1, Ordering::AcqRel) + 1;
                        tracing::warn!(
                            target: "storycapture::encoder",
                            expected_w = exp_w, expected_h = exp_h,
                            got_w = width_px, got_h = height_px,
                            mismatch_dropped = total,
                            "capture-vs-output resolution lock: frame dims differ from configured capture_dims"
                        );
                    }
                }
                let (bytes, stride) = match bgra_bytes_of_frame(&frame) {
                    Ok(v) => v,
                    Err(e) => {
                        tracing::error!(target: "storycapture::encoder", error = %e, "bgra extract failed; dropping frame");
                        frames_dropped += 1;
                        continue;
                    }
                };
                let frame_index = frames_written + 1;
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
                if should_log_frame_sample(frame_index) {
                    log_frame_sample_metrics(
                        frame_index,
                        bytes.as_ref(),
                        width_px,
                        height_px,
                        stride,
                    );
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
                let current_frame_buf = bytes_ref.to_vec();
                let timing_plan = match first_pts_ns {
                    Some(first) => {
                        cfr_timing_plan(first, pts_ns, frame_duration_ns, frames_written)
                    }
                    None => {
                        first_pts_ns = Some(pts_ns);
                        CfrTimingPlan {
                            duplicate_previous: 0,
                            write_current: true,
                        }
                    }
                };
                let mut stop_frame_pump = false;

                for _ in 0..timing_plan.duplicate_previous {
                    if last_frame_buf.is_empty() {
                        break;
                    }
                    match write_frame_bytes_to_ffmpeg(
                        &mut stdin,
                        &last_frame_buf,
                        stdin_write_timeout,
                    )
                    .await?
                    {
                        FrameWriteOutcome::Written => {
                            frames_written += 1;
                            timing_duplicate_frames += 1;
                            if frames_written == 1 || frames_written % 30 == 0 {
                                tracing::info!(target: "storycapture::encoder", frames_written, frames_dropped, timing_duplicate_frames, timing_skipped_frames, "encoder frame pump progress");
                            }
                        }
                        FrameWriteOutcome::BrokenPipe => {
                            tracing::warn!(target: "storycapture::encoder", "ffmpeg stdin broken pipe; stopping frame pump");
                            stop_frame_pump = true;
                            break;
                        }
                        FrameWriteOutcome::DroppedBackpressure => {
                            let total = frames_dropped_bp.fetch_add(1, Ordering::AcqRel) + 1;
                            frames_dropped += 1;
                            if let Some(cb) = on_backpressure.as_ref() {
                                cb(total, 1);
                            }
                            tracing::warn!(
                                target: "storycapture::encoder",
                                frames_dropped_backpressure = total,
                                "ffmpeg stdin backpressure: dropped timing duplicate frame"
                            );
                        }
                    }
                }
                if stop_frame_pump {
                    break;
                }

                if !timing_plan.write_current {
                    timing_skipped_frames += 1;
                    last_frame_buf = current_frame_buf;
                    continue;
                }

                match write_frame_bytes_to_ffmpeg(
                    &mut stdin,
                    &current_frame_buf,
                    stdin_write_timeout,
                )
                .await?
                {
                    FrameWriteOutcome::Written => {
                        frames_written += 1;
                        last_frame_buf = current_frame_buf;
                        if frames_written == 1 || frames_written % 30 == 0 {
                            tracing::info!(target: "storycapture::encoder", frames_written, frames_dropped, timing_duplicate_frames, timing_skipped_frames, "encoder frame pump progress");
                        }
                    }
                    FrameWriteOutcome::BrokenPipe => {
                        tracing::warn!(target: "storycapture::encoder", "ffmpeg stdin broken pipe; stopping frame pump");
                        break;
                    }
                    FrameWriteOutcome::DroppedBackpressure => {
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

            tracing::info!(target: "storycapture::encoder", frames_written, frames_dropped, timing_duplicate_frames, timing_skipped_frames, "frame channel closed; signaling FFmpeg EOF");
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
            let ffmpeg_metrics = parse_ffmpeg_summary_metrics(&stderr_tail);
            if ffmpeg_metrics.has_any() {
                tracing::info!(
                    target: "storycapture::encoder",
                    x264_avg_qp_i = ?ffmpeg_metrics.x264_avg_qp_i,
                    x264_avg_qp_p = ?ffmpeg_metrics.x264_avg_qp_p,
                    x264_avg_qp_b = ?ffmpeg_metrics.x264_avg_qp_b,
                    x264_kbps = ?ffmpeg_metrics.x264_kbps,
                    encode_speed = ?ffmpeg_metrics.encode_speed,
                    "ffmpeg encode summary metrics"
                );
            }

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

            let mismatch_dropped = frames_dropped_mismatch_task.load(Ordering::Acquire);
            if mismatch_dropped > 0 {
                tracing::warn!(
                    target: "storycapture::encoder",
                    mismatch_dropped,
                    "capture-vs-output resolution lock: total frames with dims mismatching configured capture_dims"
                );
            }
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
                encoder_path = "vt_writer_zero_copy",
                capture_width_px = cfg.capture_width,
                capture_height_px = cfg.capture_height,
                output_width_px = cfg.capture_width,
                output_height_px = cfg.capture_height,
                configured_output_width_px = cfg.output_width,
                configured_output_height_px = cfg.output_height,
                fps_advisory = cfg.fps_advisory,
                pts_source = "capture_frame_pts",
                strict_native_frames = strict_vt_native_frames_required(cfg),
                "vt_writer fast path engaged: first frame is NativeMacOS CVPixelBuffer"
            );
        }
        _ => {
            // Non-native frame: fall back to the FFmpeg path.
            let first_frame_data = frame_data_kind(&first.data);
            if strict_vt_native_frames_required(cfg) {
                tracing::error!(
                    target: "storycapture::encoder",
                    encoder_path = "vt_writer_zero_copy",
                    first_frame_data,
                    capture_width_px = cfg.capture_width,
                    capture_height_px = cfg.capture_height,
                    configured_output_width_px = cfg.output_width,
                    configured_output_height_px = cfg.output_height,
                    fps_advisory = cfg.fps_advisory,
                    "vt_writer strict native-frame invariant failed on first frame"
                );
                return Err(EncoderError::InvalidConfig(format!(
                    "vt_writer_zero_copy strict native path expected NativeMacOS first frame during high-resolution realtime recording, got {first_frame_data}"
                )));
            }
            let new_rx = forward_with_prefix(first, std::mem::replace(frames, tokio_placeholder()));
            *frames = new_rx;
            tracing::info!(
                target: "storycapture::encoder",
                encoder_path = "ffmpeg_rawvideo",
                first_frame_data,
                "vt_writer fast path unavailable: first frame is not NativeMacOS"
            );
            return Ok(None);
        }
    }

    // Build the writer and spawn the append pump.
    let handle = VtWriter::start(cfg.clone(), progress_tx.clone())?;

    // Queue the first frame we already popped.
    let mut frames_submitted: u64 = 0;
    let first_pts_ns = first.pts.ns;
    if let FrameData::NativeMacOS(buf) = first.data {
        handle
            .append(buf, first_pts_ns)
            .map_err(|e| EncoderError::Io(format!("vt_writer append first frame: {e}")))?;
        frames_submitted += 1;
    }

    // Move the receiver into a detached task that drives the writer.
    let mut frames_owned = std::mem::replace(frames, tokio_placeholder());
    let strict_native_frames = strict_vt_native_frames_required(cfg);
    let cfg_for_task = cfg.clone();
    let join: JoinHandle<Result<EncodeResult>> = tokio::spawn(async move {
        let mut frames_submitted = frames_submitted;
        let mut frames_dropped: u64 = 0;
        while let Some(frame) = frames_owned.recv().await {
            let pts_ns = frame.pts.ns;
            match frame.data {
                FrameData::NativeMacOS(buf) => {
                    if handle.append(buf, pts_ns).is_err() {
                        tracing::warn!(target: "storycapture::encoder", "vt_writer worker closed early");
                        break;
                    }
                    frames_submitted += 1;
                }
                other => {
                    let frame_data = frame_data_kind(&other);
                    if strict_native_frames {
                        let reason = format!(
                            "vt_writer_zero_copy strict native path received {frame_data} frame during high-resolution realtime recording"
                        );
                        tracing::error!(
                            target: "storycapture::encoder",
                            encoder_path = "vt_writer_zero_copy",
                            frame_data,
                            sequence = frame.sequence,
                            width_px = frame.width_px,
                            height_px = frame.height_px,
                            fps_advisory = cfg_for_task.fps_advisory,
                            capture_width_px = cfg_for_task.capture_width,
                            capture_height_px = cfg_for_task.capture_height,
                            configured_output_width_px = cfg_for_task.output_width,
                            configured_output_height_px = cfg_for_task.output_height,
                            frames_submitted,
                            frames_dropped,
                            "vt_writer strict native-frame invariant failed"
                        );
                        let cancel_reason = reason.clone();
                        let cancel_result =
                            tokio::task::spawn_blocking(move || handle.cancel(cancel_reason))
                                .await
                                .map_err(|e| {
                                    EncoderError::Io(format!("vt_writer cancel join: {e}"))
                                })?;
                        return match cancel_result {
                            Err(e) => Err(e),
                            Ok(_) => Err(EncoderError::InvalidConfig(reason)),
                        };
                    }

                    // Backend switched mid-session in a non-strict run.
                    tracing::warn!(
                        target: "storycapture::encoder",
                        encoder_path = "vt_writer_zero_copy",
                        frame_data,
                        frames_submitted,
                        frames_dropped,
                        "vt_writer path encountered non-NativeMacOS frame; dropping"
                    );
                    frames_dropped += 1;
                }
            }
        }
        tracing::info!(
            target: "storycapture::encoder",
            encoder_path = "vt_writer_zero_copy",
            frames_submitted,
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
    use crate::probe::HardwareEncoder;
    use capture::{ClockSource, Frame, FrameData, PixelFormat, Pts};
    use std::path::PathBuf;

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

    #[test]
    fn strict_vt_native_frames_required_only_for_high_res_realtime_50fps_plus() {
        let mut cfg = EncodeConfig::new(
            PathBuf::from("/tmp/vt.mp4"),
            3840,
            2160,
            60,
            HardwareEncoder::VideoToolboxH264,
        )
        .with_realtime_encoding(true);
        assert!(strict_vt_native_frames_required(&cfg));

        cfg.fps_advisory = 30;
        assert!(!strict_vt_native_frames_required(&cfg));

        cfg.fps_advisory = 60;
        cfg.output_width = 1920;
        cfg.output_height = 1080;
        cfg.capture_width = 1920;
        cfg.capture_height = 1080;
        assert!(!strict_vt_native_frames_required(&cfg));

        cfg.output_width = 3840;
        cfg.output_height = 2160;
        cfg.capture_width = 3840;
        cfg.capture_height = 2160;
        cfg.realtime_encoding = false;
        assert!(!strict_vt_native_frames_required(&cfg));
    }

    #[test]
    fn frame_data_kind_reports_owned_for_strict_mismatch_errors() {
        let data = vec![0u8; 16];
        let frame_data = FrameData::Owned(data, 16);

        assert_eq!(frame_data_kind(&frame_data), "Owned");
    }

    #[test]
    fn cfr_timing_plan_duplicates_previous_frames_for_pts_gap() {
        let frame_duration_ns = 1_000_000_000i128 / 60;
        let plan = cfr_timing_plan(1_000, 1_000 + 1_000_000_000, frame_duration_ns, 1);

        assert_eq!(
            plan,
            CfrTimingPlan {
                duplicate_previous: 59,
                write_current: true,
            }
        );
    }

    #[test]
    fn cfr_timing_plan_skips_frames_that_arrive_inside_existing_tick() {
        let frame_duration_ns = 1_000_000_000i128 / 60;
        let plan = cfr_timing_plan(1_000, 1_000 + frame_duration_ns / 2, frame_duration_ns, 1);

        assert_eq!(
            plan,
            CfrTimingPlan {
                duplicate_previous: 0,
                write_current: false,
            }
        );
    }

    #[test]
    fn frame_sample_metrics_reports_luma_and_edges() {
        let width = 4;
        let height = 2;
        let stride = width * 4;
        let mut data = vec![0_u8; stride * height];
        for y in 0..height {
            for x in 0..width {
                let offset = y * stride + x * 4;
                let value = if x < 2 { 0 } else { 255 };
                data[offset] = value;
                data[offset + 1] = value;
                data[offset + 2] = value;
                data[offset + 3] = 255;
            }
        }

        let metrics =
            FrameSampleMetrics::from_bgra(&data, width as u32, height as u32, stride).unwrap();

        assert_eq!(metrics.sample_count, 8);
        assert_eq!(metrics.luma_min, 0);
        assert_eq!(metrics.luma_max, 255);
        assert!(metrics.dark_pct > 40.0);
        assert!(metrics.bright_pct > 40.0);
        assert!(metrics.edge_mean > 0.0);
    }

    #[test]
    fn parses_ffmpeg_x264_summary_metrics() {
        let stderr = "\
[libx264 @ 0x123] frame I:4     Avg QP: 3.65  size: 44248
[libx264 @ 0x123] frame P:214   Avg QP:14.47  size:  9474
[libx264 @ 0x123] frame B:635   Avg QP:19.58  size:   865
frame=  853 fps= 47 q=-1.0 Lsize=    3401KiB time=00:00:14.21 bitrate=1959.8kbits/s speed=0.779x
[libx264 @ 0x123] kb/s:1944.34";

        let metrics = parse_ffmpeg_summary_metrics(stderr);

        assert_eq!(metrics.x264_avg_qp_i, Some(3.65));
        assert_eq!(metrics.x264_avg_qp_p, Some(14.47));
        assert_eq!(metrics.x264_avg_qp_b, Some(19.58));
        assert_eq!(metrics.x264_kbps, Some(1944.34));
        assert_eq!(metrics.encode_speed, Some(0.779));
        assert!(metrics.has_any());
    }
}
