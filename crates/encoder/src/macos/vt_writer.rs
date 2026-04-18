//! `VtWriter` — AVAssetWriter + AVAssetWriterInputPixelBufferAdaptor
//! wrapper that ingests `CVPixelBuffer` handles directly into an H.264 MP4,
//! leveraging VideoToolbox underneath. Zero-copy: the CVPixelBuffer is
//! handed straight to AVFoundation, which retains it internally until
//! encoding completes.
//!
//! ## Thread affinity
//!
//! AVAssetWriter itself is not Send-safe across arbitrary tokio worker
//! threads — the Objective-C runtime couples some internal state to the
//! thread that called `startWriting`. We therefore spawn a dedicated
//! `std::thread` that owns the writer, and drive it via an mpsc channel.
//! Public API (`VtWriterHandle`) is Send + Sync and can be used from tokio
//! tasks.
//!
//! ## Timebase
//!
//! Frames carry `Pts { ns: i128 }` (nanoseconds since host-time zero,
//! per `capture::frame::Pts`). We build `CMTime(value = pts_ns, timescale
//! = 1_000_000_000)` and let AVFoundation rescale to its preferred media
//! timescale internally. The first append's PTS is normalized to zero by
//! passing the first-frame pts as the source time to
//! `startSessionAtSourceTime:` — that way the MP4 timeline starts at
//! wall-clock zero regardless of when the capture session began.

#![cfg(target_os = "macos")]

use std::ffi::c_void;
use std::path::{Path, PathBuf};
use std::sync::mpsc as std_mpsc;
use std::thread;
use std::time::Instant;

use capture::macos::raii::CVPixelBufferHandle;

use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2_av_foundation::{
    AVAssetWriter, AVAssetWriterInput, AVAssetWriterInputPixelBufferAdaptor, AVAssetWriterStatus,
    AVFileTypeMPEG4, AVMediaTypeVideo, AVVideoAverageBitRateKey, AVVideoCodecKey,
    AVVideoCodecTypeH264, AVVideoCompressionPropertiesKey, AVVideoHeightKey, AVVideoWidthKey,
};
use objc2_core_media::CMTime;
use objc2_core_video::CVPixelBuffer;
use objc2_foundation::{NSDictionary, NSNumber, NSString, NSURL};

use crate::config::EncodeConfig;
use crate::error::{EncoderError, Result};
use crate::pipeline::EncodeResult;
use crate::progress::EncodeProgress;

/// Sent to the writer worker thread. We carry owned values across the
/// boundary so the worker thread becomes the sole owner of each pixel
/// buffer handle until append completes + AVFoundation has retained it.
enum Cmd {
    Append {
        buffer: CVPixelBufferHandle,
        pts_ns: i128,
    },
    Finish,
}

/// Public handle returned from `VtWriter::start`. Sends commands to the
/// dedicated writer thread; the writer thread performs all AVFoundation
/// calls.
pub struct VtWriterHandle {
    cmd_tx: std_mpsc::SyncSender<Cmd>,
    result_rx: std_mpsc::Receiver<Result<EncodeResult>>,
    thread: Option<thread::JoinHandle<()>>,
    /// Progress sender for fps/bytes snapshots. Producer-side of the
    /// caller's `mpsc::Sender<EncodeProgress>` — the worker forwards
    /// periodic snapshots.
    progress_tx: tokio::sync::mpsc::Sender<EncodeProgress>,
    output_path: PathBuf,
}

impl VtWriterHandle {
    /// Append one frame. Returns `Ok(true)` if queued, `Ok(false)` if
    /// worker thread is gone (the caller should treat as a terminal
    /// signal and stop sending).
    pub fn append(&self, buffer: CVPixelBufferHandle, pts_ns: i128) -> std::io::Result<()> {
        self.cmd_tx
            .send(Cmd::Append { buffer, pts_ns })
            .map_err(|_| std::io::Error::new(std::io::ErrorKind::BrokenPipe, "writer closed"))
    }

    /// Send a final EncodeProgress snapshot. Best-effort.
    pub async fn emit_progress(&self, p: EncodeProgress) {
        let _ = self.progress_tx.send(p).await;
    }

    /// Finalize: signals EOS, waits for the writer thread to flush and
    /// close the MP4 atom. Consumes the handle.
    pub fn finish(mut self) -> Result<EncodeResult> {
        let _ = self.cmd_tx.send(Cmd::Finish);
        drop(self.cmd_tx);
        let result = self
            .result_rx
            .recv()
            .map_err(|e| EncoderError::Io(format!("vt_writer result recv: {e}")))?;
        if let Some(handle) = self.thread.take() {
            let _ = handle.join();
        }
        result
    }

    pub fn output_path(&self) -> &Path {
        &self.output_path
    }
}

/// Type marker + factory namespace. The real state lives on the worker
/// thread; all public callers go through `VtWriterHandle`.
pub struct VtWriter;

impl VtWriter {
    /// Spawn the writer thread and return a handle.
    ///
    /// The output file is deleted up front if it exists — AVAssetWriter
    /// refuses to overwrite.
    pub fn start(
        cfg: EncodeConfig,
        progress_tx: tokio::sync::mpsc::Sender<EncodeProgress>,
    ) -> Result<VtWriterHandle> {
        cfg.validate()?;

        // AVAssetWriter won't overwrite; pre-delete.
        if cfg.output_path.exists() {
            std::fs::remove_file(&cfg.output_path).map_err(|e| {
                EncoderError::Io(format!(
                    "remove existing output {:?}: {e}",
                    cfg.output_path
                ))
            })?;
        }

        let (cmd_tx, cmd_rx) = std_mpsc::sync_channel::<Cmd>(128);
        let (result_tx, result_rx) = std_mpsc::channel::<Result<EncodeResult>>();

        let output_path = cfg.output_path.clone();
        let progress_tx_worker = progress_tx.clone();

        let thread = thread::Builder::new()
            .name("vt-writer".into())
            .spawn(move || {
                let res = run_worker(cfg, cmd_rx, progress_tx_worker);
                let _ = result_tx.send(res);
            })
            .map_err(|e| EncoderError::Io(format!("spawn vt-writer thread: {e}")))?;

        Ok(VtWriterHandle {
            cmd_tx,
            result_rx,
            thread: Some(thread),
            progress_tx,
            output_path,
        })
    }
}

/// Writer thread body. Owns all AVFoundation objects; none of these
/// `Retained<>` values may cross the thread boundary.
fn run_worker(
    cfg: EncodeConfig,
    cmd_rx: std_mpsc::Receiver<Cmd>,
    progress_tx: tokio::sync::mpsc::Sender<EncodeProgress>,
) -> Result<EncodeResult> {
    // Wrap in an autoreleasepool so the transient NSNumber/NSString
    // autoreleased instances don't accumulate for the lifetime of the
    // encode.
    objc2::rc::autoreleasepool(|_| -> Result<EncodeResult> {
        let output_path = cfg.output_path.clone();
        let start = Instant::now();

        // --- Build AVAssetWriter ---
        // AVAssetWriter refuses to create over an existing file (returns
        // NSFileWriteFileExistsError). Remove any prior artifact at the
        // exact output path — UUID session ids normally prevent collisions,
        // but retried sessions or leftover .mp4 files from crashes would
        // break the writer silently otherwise.
        let _ = std::fs::remove_file(&output_path);
        // `fileURLWithPath:` takes a POSIX path, NOT a file:// URL. Passing
        // a prefixed "file://…" string builds an invalid URL and
        // startWriting fails with "Cannot create file".
        let path_str = NSString::from_str(&output_path.display().to_string());
        let url: Retained<NSURL> = NSURL::fileURLWithPath(&path_str);

        let file_type = unsafe { AVFileTypeMPEG4 }
            .ok_or_else(|| EncoderError::Io("AVFileTypeMPEG4 symbol missing".into()))?;

        let writer = unsafe { AVAssetWriter::assetWriterWithURL_fileType_error(&url, file_type) }
            .map_err(|e| {
                EncoderError::Io(format!(
                    "AVAssetWriter init: {}",
                    e.localizedDescription()
                ))
            })?;

        // --- Build outputSettings dictionary for the video input ---
        //
        // {
        //   AVVideoCodecKey: AVVideoCodecTypeH264,
        //   AVVideoWidthKey: <width>,
        //   AVVideoHeightKey: <height>,
        //   AVVideoCompressionPropertiesKey: {
        //     AVVideoAverageBitRateKey: <bps>,
        //   },
        // }
        //
        // Bitrate is in bits-per-second on this key (note: config uses kbps).
        let bitrate_bps: i64 = (cfg.bitrate_kbps as i64) * 1000;
        let width_num = NSNumber::new_u32(cfg.width);
        let height_num = NSNumber::new_u32(cfg.height);
        let bitrate_num = NSNumber::new_i64(bitrate_bps);

        let codec_key = unsafe { AVVideoCodecKey }
            .ok_or_else(|| EncoderError::Io("AVVideoCodecKey symbol missing".into()))?;
        let width_key = unsafe { AVVideoWidthKey }
            .ok_or_else(|| EncoderError::Io("AVVideoWidthKey symbol missing".into()))?;
        let height_key = unsafe { AVVideoHeightKey }
            .ok_or_else(|| EncoderError::Io("AVVideoHeightKey symbol missing".into()))?;
        let compression_key = unsafe { AVVideoCompressionPropertiesKey }
            .ok_or_else(|| EncoderError::Io("AVVideoCompressionPropertiesKey symbol missing".into()))?;
        let bitrate_key = unsafe { AVVideoAverageBitRateKey }
            .ok_or_else(|| EncoderError::Io("AVVideoAverageBitRateKey symbol missing".into()))?;
        let codec_h264 = unsafe { AVVideoCodecTypeH264 }
            .ok_or_else(|| EncoderError::Io("AVVideoCodecTypeH264 symbol missing".into()))?;

        // Inner compression-properties dict: { AVVideoAverageBitRateKey: <bps> }
        let compression_dict: Retained<NSDictionary<NSString, AnyObject>> =
            NSDictionary::from_slices(
                &[bitrate_key],
                &[&*bitrate_num as &AnyObject],
            );

        // Top-level outputSettings dict.
        let settings: Retained<NSDictionary<NSString, AnyObject>> = NSDictionary::from_slices(
            &[codec_key, width_key, height_key, compression_key],
            &[
                &**codec_h264 as &AnyObject,
                &*width_num as &AnyObject,
                &*height_num as &AnyObject,
                &*compression_dict as &AnyObject,
            ],
        );

        // --- Input ---
        let media_type = unsafe { AVMediaTypeVideo }
            .ok_or_else(|| EncoderError::Io("AVMediaTypeVideo symbol missing".into()))?;
        let input = unsafe {
            AVAssetWriterInput::assetWriterInputWithMediaType_outputSettings(
                media_type,
                Some(&settings),
            )
        };
        unsafe { input.setExpectsMediaDataInRealTime(true) };

        if !unsafe { writer.canAddInput(&input) } {
            return Err(EncoderError::Io(
                "AVAssetWriter cannot add video input with requested settings".into(),
            ));
        }
        unsafe { writer.addInput(&input) };

        // --- PixelBuffer adaptor (no sourcePixelBufferAttributes — we
        // deliver BGRA CVPixelBuffers straight from SCK and let
        // AVFoundation convert to the encoder's native format) ---
        let adaptor = unsafe {
            AVAssetWriterInputPixelBufferAdaptor::assetWriterInputPixelBufferAdaptorWithAssetWriterInput_sourcePixelBufferAttributes(
                &input,
                None,
            )
        };

        // --- Start writing ---
        if !unsafe { writer.startWriting() } {
            let err = unsafe { writer.error() };
            let msg = err
                .map(|e| e.localizedDescription().to_string())
                .unwrap_or_else(|| "startWriting returned NO".into());
            return Err(EncoderError::Io(format!("AVAssetWriter startWriting: {msg}")));
        }

        // --- Frame loop ---
        let mut frames_written: u64 = 0;
        let mut frames_dropped: u64 = 0;
        let mut session_started = false;
        let mut first_pts_ns: i128 = 0;
        let mut last_progress_at = Instant::now();

        loop {
            let cmd = match cmd_rx.recv() {
                Ok(c) => c,
                Err(_) => break, // channel closed without Finish
            };
            match cmd {
                Cmd::Finish => break,
                Cmd::Append { buffer, pts_ns } => {
                    if !session_started {
                        first_pts_ns = pts_ns;
                        let t0 = unsafe { CMTime::new(0, 1_000_000_000) };
                        unsafe { writer.startSessionAtSourceTime(t0) };
                        session_started = true;
                    }

                    // Normalize PTS relative to first frame.
                    let rel_ns = (pts_ns - first_pts_ns).max(0) as i64;
                    let cm_pts = unsafe { CMTime::new(rel_ns, 1_000_000_000) };
                    if frames_written < 5 {
                        tracing::info!(
                            target: "storycapture::encoder",
                            n = frames_written,
                            pts_ns = pts_ns as i64,
                            first_pts_ns = first_pts_ns as i64,
                            rel_ns,
                            "vt_writer append"
                        );
                    }

                    // Backpressure: spin briefly while the input is not
                    // ready. If it's still not ready after a short window,
                    // drop the frame (counted).
                    let mut ready = unsafe { input.isReadyForMoreMediaData() };
                    if !ready {
                        for _ in 0..20 {
                            thread::sleep(std::time::Duration::from_millis(2));
                            ready = unsafe { input.isReadyForMoreMediaData() };
                            if ready {
                                break;
                            }
                        }
                    }
                    if !ready {
                        frames_dropped += 1;
                        drop(buffer);
                        continue;
                    }

                    // Cast raw CVPixelBufferRef pointer to objc2 type.
                    let raw: *mut c_void = buffer.as_ptr();
                    let pb: &CVPixelBuffer = unsafe { &*(raw as *const CVPixelBuffer) };
                    let ok = unsafe {
                        adaptor.appendPixelBuffer_withPresentationTime(pb, cm_pts)
                    };
                    drop(buffer); // release our retain; AVFoundation holds its own.

                    if ok {
                        frames_written += 1;
                    } else {
                        frames_dropped += 1;
                        let status = unsafe { writer.status() };
                        if status == AVAssetWriterStatus::Failed
                            || status == AVAssetWriterStatus::Cancelled
                        {
                            let err = unsafe { writer.error() };
                            let msg = err
                                .map(|e| e.localizedDescription().to_string())
                                .unwrap_or_else(|| "appendPixelBuffer failed".into());
                            return Err(EncoderError::Io(format!(
                                "AVAssetWriter failed: {msg}"
                            )));
                        }
                    }

                    // Emit a progress snapshot roughly every 500ms.
                    if last_progress_at.elapsed().as_millis() >= 500 {
                        last_progress_at = Instant::now();
                        let bytes = std::fs::metadata(&output_path)
                            .map(|m| m.len())
                            .unwrap_or(0);
                        let elapsed_s = start.elapsed().as_secs_f32().max(0.001);
                        let fps = (frames_written as f32) / elapsed_s;
                        let bitrate_kbps = if elapsed_s > 0.0 {
                            ((bytes as f32) * 8.0 / elapsed_s / 1000.0) as f32
                        } else {
                            0.0
                        };
                        let out_time_ms = (rel_ns / 1_000_000) as u64;
                        let snap = EncodeProgress {
                            frame: frames_written,
                            fps,
                            bitrate_kbps,
                            out_time_ms,
                            drop_frames: frames_dropped,
                            dup_frames: 0,
                            speed: 0.0,
                            finished: false,
                        };
                        let _ = progress_tx.blocking_send(snap);
                    }
                }
            }
        }

        // --- Finalize ---
        unsafe { input.markAsFinished() };

        // finishWriting is the synchronous variant (deprecated but it's
        // the only call we can make without hooking a completion block).
        // Per Apple, it must not be called from the main thread — we're
        // on a dedicated worker thread so that's fine.
        #[allow(deprecated)]
        let finished_ok = unsafe { writer.finishWriting() };
        if !finished_ok {
            let err = unsafe { writer.error() };
            let msg = err
                .map(|e| e.localizedDescription().to_string())
                .unwrap_or_else(|| "finishWriting returned NO".into());
            return Err(EncoderError::Io(format!(
                "AVAssetWriter finishWriting: {msg}"
            )));
        }

        let duration_ms = start.elapsed().as_millis() as u64;
        let bytes = std::fs::metadata(&output_path)
            .map(|m| m.len())
            .unwrap_or(0);

        // Final progress snapshot.
        let _ = progress_tx.blocking_send(EncodeProgress {
            frame: frames_written,
            fps: 0.0,
            bitrate_kbps: 0.0,
            out_time_ms: duration_ms,
            drop_frames: frames_dropped,
            dup_frames: 0,
            speed: 0.0,
            finished: true,
        });

        Ok(EncodeResult {
            output_path,
            duration_ms,
            bytes,
            frames_written,
            frames_dropped,
        })
    })
}
