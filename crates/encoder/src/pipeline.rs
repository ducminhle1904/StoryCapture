//! `EncodePipeline` — glues a `capture::Frame` mpsc receiver to an FFmpeg
//! sidecar spawned via `SidecarCommand`.
//!
//! The pipeline runs two tokio tasks:
//!   1. **Frame pump** — reads `Frame` from the input `mpsc::Receiver`,
//!      extracts contiguous BGRA bytes (copying from native surfaces when
//!      necessary — see note below), and writes them to FFmpeg stdin.
//!      On receiver close, `stdin` is dropped, which sends EOF to FFmpeg.
//!   2. **Progress parser** — consumes FFmpeg stderr and forwards every
//!      `progress=` marker to a `mpsc::Sender<EncodeProgress>` provided
//!      by the caller.
//!
//! On `BrokenPipe` (FFmpeg exited early — disk full, invalid args), the
//! frame pump stops, the stderr tail is captured from the progress
//! parser, and the final result wraps them into `EncoderError::FfmpegExit`.
//!
//! ## Zero-copy note
//!
//! True zero-copy from a native `CVPixelBuffer` / `ID3D11Texture2D` into
//! FFmpeg is not possible across the subprocess boundary — FFmpeg stdin
//! is a pipe of bytes. Phase 1 accepts the CPU copy cost (documented in
//! the plan); Plan 11 or Phase 2 will optimize by linking against
//! VideoToolbox/NVENC directly. For now we copy via `bgra_bytes_of_frame`.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use tokio::io::AsyncWriteExt;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use capture::{Frame, FrameData};

use crate::config::EncodeConfig;
use crate::error::{EncoderError, Result};
use crate::progress::{EncodeProgress, ProgressParser};
use crate::sidecar::{FfmpegSidecar, SidecarCommand};

/// Shutdown budget for the FFmpeg child once `stdin` is closed. 15 s
/// is the "nice" window before SIGKILL (see `FfmpegSidecar::graceful_shutdown`).
pub const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(15);

/// Result of a completed encode.
#[derive(Debug, Clone)]
pub struct EncodeResult {
    pub output_path: PathBuf,
    pub duration_ms: u64,
    pub bytes: u64,
    pub frames_written: u64,
    pub frames_dropped: u64,
}

/// Convert a capture `Frame` into a contiguous BGRA byte slice suitable
/// for FFmpeg's stdin. For native surfaces the caller platform must
/// provide its own extraction path via `FrameData::Owned` — Phase 1's
/// real-capture backends already convert through `Owned(Vec<u8>, stride)`
/// when feeding the encoder (see `capture::CapturePipeline`).
///
/// Returns the raw bytes and the per-row stride (may be larger than
/// `width * 4` due to row padding on some backends).
pub fn bgra_bytes_of_frame(frame: &Frame) -> Result<(Vec<u8>, usize)> {
    match &frame.data {
        FrameData::Owned(bytes, stride) => Ok((bytes.clone(), *stride)),
        #[cfg(target_os = "macos")]
        FrameData::NativeMacOS(_) => Err(EncoderError::InvalidConfig(
            "native CVPixelBuffer input requires CPU copy helper (Plan 11); pipeline expects FrameData::Owned from the capture crate's public pipeline path".into(),
        )),
        #[cfg(target_os = "windows")]
        FrameData::NativeWindows(_) => Err(EncoderError::InvalidConfig(
            "native D3D texture input requires CPU copy helper (Plan 11); pipeline expects FrameData::Owned from the capture crate's public pipeline path".into(),
        )),
    }
}

/// Start an encode. Spawns two background tasks and returns a
/// `JoinHandle<Result<EncodeResult>>` that resolves when FFmpeg has
/// exited and the moov atom is written.
pub struct EncodePipeline;

impl EncodePipeline {
    /// Spawn the pipeline. The returned join handle resolves to the
    /// final `EncodeResult` when FFmpeg exits cleanly, or an
    /// `EncoderError` if anything goes wrong.
    pub async fn start(
        cfg: EncodeConfig,
        sidecar_cmd: &dyn SidecarCommand,
        mut frames: mpsc::Receiver<Frame>,
        progress_tx: mpsc::Sender<EncodeProgress>,
    ) -> Result<JoinHandle<Result<EncodeResult>>> {
        cfg.validate()?;

        let args = cfg.to_ffmpeg_args();
        let child = sidecar_cmd.spawn(args).await?;
        let mut sidecar = FfmpegSidecar::new(child);

        // Extract handles for the two background tasks.
        let handles = sidecar
            .take()
            .ok_or_else(|| EncoderError::Io("sidecar yielded no handles".into()))?;
        // Drop stdout — not used for encode (probe uses it instead).
        drop(handles.stdout);
        let mut stdin = handles.stdin;
        let stderr = handles.stderr;
        let mut child = handles.child;

        let output_path = cfg.output_path.clone();
        let start = Instant::now();

        // Progress parser task.
        let parser = ProgressParser::new();
        let progress_task = tokio::spawn(async move { parser.pump(stderr, progress_tx).await });

        let join = tokio::spawn(async move {
            let mut frames_written: u64 = 0;
            let mut frames_dropped: u64 = 0;
            tracing::info!(target: "storycapture::encoder", "frame pump started");

            // Frame pump loop.
            while let Some(frame) = frames.recv().await {
                let (bytes, _stride) = match bgra_bytes_of_frame(&frame) {
                    Ok(v) => v,
                    Err(e) => {
                        tracing::error!(target: "storycapture::encoder", error = %e, "bgra extract failed; dropping frame");
                        frames_dropped += 1;
                        continue;
                    }
                };
                match stdin.write_all(&bytes).await {
                    Ok(()) => {
                        frames_written += 1;
                        if frames_written == 1 || frames_written % 30 == 0 {
                            tracing::info!(target: "storycapture::encoder", frames_written, frames_dropped, "encoder frame pump progress");
                        }
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::BrokenPipe => {
                        tracing::warn!(target: "storycapture::encoder", "ffmpeg stdin broken pipe; stopping frame pump");
                        break;
                    }
                    Err(e) => {
                        return Err(EncoderError::Io(format!("stdin write: {e}")));
                    }
                }
                drop(frame);
            }

            tracing::info!(target: "storycapture::encoder", frames_written, frames_dropped, "frame channel closed; signaling FFmpeg EOF");
            drop(stdin);

            // Wait for FFmpeg to flush + exit.
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

            // Join the progress parser to collect the stderr tail.
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

            let duration_ms = start.elapsed().as_millis() as u64;
            let bytes = std::fs::metadata(&output_path)
                .map(|m| m.len())
                .unwrap_or(0);

            // Keep `sidecar` alive through the task so its Drop impl is
            // only invoked after FFmpeg has already exited (or been
            // killed above). We took the handles out of it earlier;
            // dropping it here is a no-op.
            drop(sidecar);

            Ok(EncodeResult {
                output_path,
                duration_ms,
                bytes,
                frames_written,
                frames_dropped,
            })
        });

        Ok(join)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use capture::{ClockSource, Frame, FrameData, PixelFormat, Pts};

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
    }
}
