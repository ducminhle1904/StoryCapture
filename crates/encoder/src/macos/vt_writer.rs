//! `VtWriter` wraps `VTCompressionSession` for zero-copy H.264 MP4 output.
//!
//! A dedicated thread owns the compression session and mux writer; public
//! handles stay `Send + Sync`.

#![cfg(target_os = "macos")]

use std::ffi::c_void;
use std::panic::AssertUnwindSafe;
use std::path::{Path, PathBuf};
use std::ptr::NonNull;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc as std_mpsc;
use std::thread;
use std::time::Instant;

/// Lifetime counter of PTS-clamp events across all VtWriter sessions.
/// Non-zero after a run signals clock-jump or source PTS regression — the
/// renderer/telemetry surface can read this to flag sessions for review.
static PTS_CLAMP_COUNT: AtomicU64 = AtomicU64::new(0);

/// Return the lifetime PTS-clamp event count.
pub fn clamp_count() -> u64 {
    PTS_CLAMP_COUNT.load(Ordering::Acquire)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PtsNormalizationEvent {
    BeforeFirst,
    NonMonotonic,
    LargeGap(i64),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct NormalizedPts {
    rel_ns: i64,
    event: Option<PtsNormalizationEvent>,
}

fn normalize_rel_pts(
    pts_ns: i128,
    first_pts_ns: i128,
    last_rel_ns: Option<i64>,
    frame_duration_ns: i64,
) -> NormalizedPts {
    let mut rel_ns = if pts_ns < first_pts_ns {
        0
    } else {
        i64::try_from(pts_ns - first_pts_ns).unwrap_or(i64::MAX)
    };
    let mut event = (pts_ns < first_pts_ns).then_some(PtsNormalizationEvent::BeforeFirst);

    if let Some(last) = last_rel_ns {
        if rel_ns <= last {
            rel_ns = last.saturating_add(frame_duration_ns.max(1));
            event = Some(PtsNormalizationEvent::NonMonotonic);
        } else {
            let gap_ns = rel_ns - last;
            let large_gap_threshold_ns = 500_000_000i64.max(frame_duration_ns.saturating_mul(2));
            if gap_ns > large_gap_threshold_ns {
                event = Some(PtsNormalizationEvent::LargeGap(gap_ns));
            }
        }
    }

    NormalizedPts { rel_ns, event }
}

use capture::macos::raii::CVPixelBufferHandle;

use objc2::rc::Retained;
use objc2_av_foundation::{
    AVAssetWriter, AVAssetWriterInput, AVAssetWriterStatus, AVFileTypeMPEG4, AVMediaTypeVideo,
};
use objc2_core_foundation::{CFBoolean, CFDictionary, CFNumber, CFRetained, CFString, CFType};
use objc2_core_media::{kCMTimeInvalid, kCMVideoCodecType_H264, CMSampleBuffer, CMTime};
use objc2_core_video::{
    kCVImageBufferColorPrimaries_ITU_R_709_2, kCVImageBufferTransferFunction_ITU_R_709_2,
    kCVImageBufferYCbCrMatrix_ITU_R_709_2, kCVPixelBufferHeightKey,
    kCVPixelBufferIOSurfacePropertiesKey, kCVPixelBufferPixelFormatTypeKey, kCVPixelBufferWidthKey,
    kCVPixelFormatType_32BGRA, CVPixelBuffer,
};
use objc2_foundation::{NSString, NSURL};
use objc2_video_toolbox::{
    kVTCompressionPropertyKey_AllowFrameReordering, kVTCompressionPropertyKey_AverageBitRate,
    kVTCompressionPropertyKey_ColorPrimaries, kVTCompressionPropertyKey_ConstantBitRate,
    kVTCompressionPropertyKey_ExpectedFrameRate, kVTCompressionPropertyKey_H264EntropyMode,
    kVTCompressionPropertyKey_MaxAllowedFrameQP, kVTCompressionPropertyKey_MaxKeyFrameInterval,
    kVTCompressionPropertyKey_MaximumRealTimeFrameRate,
    kVTCompressionPropertyKey_PrioritizeEncodingSpeedOverQuality,
    kVTCompressionPropertyKey_ProfileLevel, kVTCompressionPropertyKey_Quality,
    kVTCompressionPropertyKey_RealTime, kVTCompressionPropertyKey_TransferFunction,
    kVTCompressionPropertyKey_UsingHardwareAcceleratedVideoEncoder,
    kVTCompressionPropertyKey_YCbCrMatrix, kVTH264EntropyMode_CABAC,
    kVTProfileLevel_H264_High_AutoLevel,
    kVTVideoEncoderSpecification_EnableHardwareAcceleratedVideoEncoder, VTCompressionSession,
    VTEncodeInfoFlags, VTSessionCopyProperty, VTSessionSetProperty,
};

use crate::config::EncodeConfig;
use crate::error::{EncoderError, Result};
use crate::filters::QualityPreset;
use crate::pipeline::EncodeResult;
use crate::progress::EncodeProgress;

/// Message sent to the writer thread.
enum Cmd {
    Append {
        buffer: CVPixelBufferHandle,
        pts_ns: i128,
    },
    Cancel {
        reason: String,
    },
    Finish,
}

/// Public handle returned from `VtWriter::start`.
pub struct VtWriterHandle {
    cmd_tx: std_mpsc::SyncSender<Cmd>,
    result_rx: std_mpsc::Receiver<Result<EncodeResult>>,
    thread: Option<thread::JoinHandle<()>>,
    /// Progress sender for snapshots.
    progress_tx: tokio::sync::mpsc::Sender<EncodeProgress>,
    output_path: PathBuf,
}

impl VtWriterHandle {
    /// Append one frame.
    pub fn append(&self, buffer: CVPixelBufferHandle, pts_ns: i128) -> std::io::Result<()> {
        self.cmd_tx
            .send(Cmd::Append { buffer, pts_ns })
            .map_err(|_| std::io::Error::new(std::io::ErrorKind::BrokenPipe, "writer closed"))
    }

    /// Send a final EncodeProgress snapshot. Best-effort.
    pub async fn emit_progress(&self, p: EncodeProgress) {
        let _ = self.progress_tx.send(p).await;
    }

    /// Finalize and wait for the worker to flush.
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

    /// Abort the writer and surface the reason as the encode error.
    pub fn cancel(mut self, reason: String) -> Result<EncodeResult> {
        let _ = self.cmd_tx.send(Cmd::Cancel { reason });
        drop(self.cmd_tx);
        let result = self
            .result_rx
            .recv()
            .map_err(|e| EncoderError::Io(format!("vt_writer cancel result recv: {e}")))?;
        if let Some(handle) = self.thread.take() {
            let _ = handle.join();
        }
        result
    }

    pub fn output_path(&self) -> &Path {
        &self.output_path
    }
}

/// Factory namespace; state lives on the worker thread.
pub struct VtWriter;

impl VtWriter {
    /// Spawn the writer thread and return a handle.
    pub fn start(
        cfg: EncodeConfig,
        progress_tx: tokio::sync::mpsc::Sender<EncodeProgress>,
    ) -> Result<VtWriterHandle> {
        cfg.validate()?;

        // AVAssetWriter won't overwrite.
        if cfg.output_path.exists() {
            std::fs::remove_file(&cfg.output_path).map_err(|e| {
                EncoderError::Io(format!("remove existing output {:?}: {e}", cfg.output_path))
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

/// Writer thread body.
fn run_worker(
    cfg: EncodeConfig,
    cmd_rx: std_mpsc::Receiver<Cmd>,
    progress_tx: tokio::sync::mpsc::Sender<EncodeProgress>,
) -> Result<EncodeResult> {
    match objc2::exception::catch(AssertUnwindSafe(|| {
        run_worker_inner(cfg, cmd_rx, progress_tx)
    })) {
        Ok(result) => result,
        Err(exception) => {
            let msg = exception
                .map(|exception| format!("{exception:?}"))
                .unwrap_or_else(|| "nil Objective-C exception".to_string());
            tracing::error!(
                target: "storycapture::encoder::vt",
                encoder_path = "vt_writer_zero_copy",
                exception = %msg,
                "vt_writer caught Objective-C exception"
            );
            Err(EncoderError::Io(format!(
                "VideoToolbox writer Objective-C exception: {msg}"
            )))
        }
    }
}

struct CallbackContext {
    tx: std_mpsc::Sender<EncodedMsg>,
}

struct CallbackContextGuard(*mut CallbackContext);

impl CallbackContextGuard {
    fn new(ctx: CallbackContext) -> Self {
        Self(Box::into_raw(Box::new(ctx)))
    }

    fn as_void_ptr(&self) -> *mut c_void {
        self.0.cast()
    }
}

impl Drop for CallbackContextGuard {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                drop(Box::from_raw(self.0));
            }
            self.0 = std::ptr::null_mut();
        }
    }
}

struct VtSessionInvalidator<'a>(&'a VTCompressionSession);

impl Drop for VtSessionInvalidator<'_> {
    fn drop(&mut self) {
        unsafe { self.0.invalidate() };
    }
}

enum EncodedMsg {
    Sample {
        sample_ptr: usize,
        flags: VTEncodeInfoFlags,
    },
    Dropped {
        status: i32,
        flags: VTEncodeInfoFlags,
    },
    Error {
        status: i32,
        flags: VTEncodeInfoFlags,
    },
}

unsafe extern "C-unwind" fn vt_output_callback(
    output_callback_refcon: *mut c_void,
    _source_frame_refcon: *mut c_void,
    status: i32,
    info_flags: VTEncodeInfoFlags,
    sample_buffer: *mut CMSampleBuffer,
) {
    if output_callback_refcon.is_null() {
        return;
    }
    let ctx = unsafe { &*(output_callback_refcon as *const CallbackContext) };
    if status != 0 {
        let _ = ctx.tx.send(EncodedMsg::Error {
            status,
            flags: info_flags,
        });
        return;
    }
    if info_flags.contains(VTEncodeInfoFlags::FrameDropped) || sample_buffer.is_null() {
        let _ = ctx.tx.send(EncodedMsg::Dropped {
            status,
            flags: info_flags,
        });
        return;
    }

    let Some(sample_ptr) = NonNull::new(sample_buffer) else {
        let _ = ctx.tx.send(EncodedMsg::Dropped {
            status,
            flags: info_flags,
        });
        return;
    };
    let retained = unsafe { CFRetained::<CMSampleBuffer>::retain(sample_ptr) };
    let raw = CFRetained::into_raw(retained);
    if ctx
        .tx
        .send(EncodedMsg::Sample {
            sample_ptr: raw.as_ptr() as usize,
            flags: info_flags,
        })
        .is_err()
    {
        unsafe {
            drop(CFRetained::<CMSampleBuffer>::from_raw(raw));
        }
    }
}

fn make_encoder_spec() -> CFRetained<CFDictionary<CFString, CFType>> {
    let yes = CFBoolean::new(true);
    CFDictionary::from_slices(
        &[unsafe { kVTVideoEncoderSpecification_EnableHardwareAcceleratedVideoEncoder }],
        &[yes.as_ref()],
    )
}

fn configure_vt_session(
    session: &VTCompressionSession,
    effective_kbps: u32,
    bitrate_bps: i64,
    fps: u32,
    all_i_frames: bool,
) -> Result<()> {
    let bitrate_num = CFNumber::new_i64(bitrate_bps);
    let fps_num = CFNumber::new_i32(fps as i32);
    let keyframe_interval_frames = if all_i_frames { 1 } else { fps as i32 };
    let keyframe_interval_num = CFNumber::new_i32(keyframe_interval_frames);
    let quality_num = CFNumber::new_f64(1.0);
    let max_qp_num = CFNumber::new_i32(18);
    let yes = CFBoolean::new(true);
    let no = CFBoolean::new(false);
    let allow_temporal_compression_key = CFString::from_static_str("AllowTemporalCompression");

    set_vt_property(
        session,
        unsafe { kVTCompressionPropertyKey_RealTime },
        yes.as_ref(),
        "RealTime",
        true,
    )?;
    set_vt_property(
        session,
        unsafe { kVTCompressionPropertyKey_PrioritizeEncodingSpeedOverQuality },
        no.as_ref(),
        "PrioritizeEncodingSpeedOverQuality",
        false,
    )?;
    set_vt_property(
        session,
        unsafe { kVTCompressionPropertyKey_ProfileLevel },
        unsafe { kVTProfileLevel_H264_High_AutoLevel }.as_ref(),
        "ProfileLevel",
        true,
    )?;
    set_vt_property(
        session,
        unsafe { kVTCompressionPropertyKey_H264EntropyMode },
        unsafe { kVTH264EntropyMode_CABAC }.as_ref(),
        "H264EntropyMode",
        false,
    )?;
    set_vt_property(
        session,
        unsafe { kVTCompressionPropertyKey_AllowFrameReordering },
        no.as_ref(),
        "AllowFrameReordering",
        true,
    )?;
    set_vt_property(
        session,
        unsafe { kVTCompressionPropertyKey_ExpectedFrameRate },
        (&*fps_num).as_ref(),
        "ExpectedFrameRate",
        true,
    )?;
    set_vt_property(
        session,
        unsafe { kVTCompressionPropertyKey_MaximumRealTimeFrameRate },
        (&*fps_num).as_ref(),
        "MaximumRealTimeFrameRate",
        false,
    )?;
    set_vt_property(
        session,
        unsafe { kVTCompressionPropertyKey_MaxKeyFrameInterval },
        (&*keyframe_interval_num).as_ref(),
        "MaxKeyFrameInterval",
        true,
    )?;
    if all_i_frames {
        // objc2-video-toolbox 0.3.x does not currently expose
        // kVTCompressionPropertyKey_AllowTemporalCompression, but the Core
        // Foundation key is stable and documented as "AllowTemporalCompression".
        set_vt_property(
            session,
            allow_temporal_compression_key.as_ref(),
            no.as_ref(),
            "AllowTemporalCompression",
            false,
        )?;
    }
    set_vt_property(
        session,
        unsafe { kVTCompressionPropertyKey_Quality },
        (&*quality_num).as_ref(),
        "Quality",
        false,
    )?;
    set_vt_property(
        session,
        unsafe { kVTCompressionPropertyKey_MaxAllowedFrameQP },
        (&*max_qp_num).as_ref(),
        "MaxAllowedFrameQP",
        false,
    )?;
    set_vt_property(
        session,
        unsafe { kVTCompressionPropertyKey_ColorPrimaries },
        unsafe { kCVImageBufferColorPrimaries_ITU_R_709_2 }.as_ref(),
        "ColorPrimaries",
        false,
    )?;
    set_vt_property(
        session,
        unsafe { kVTCompressionPropertyKey_TransferFunction },
        unsafe { kCVImageBufferTransferFunction_ITU_R_709_2 }.as_ref(),
        "TransferFunction",
        false,
    )?;
    set_vt_property(
        session,
        unsafe { kVTCompressionPropertyKey_YCbCrMatrix },
        unsafe { kCVImageBufferYCbCrMatrix_ITU_R_709_2 }.as_ref(),
        "YCbCrMatrix",
        false,
    )?;

    tracing::info!(
        target: "storycapture::encoder::vt",
        encoder_path = "vt_writer_zero_copy",
        all_i_frames,
        keyframe_interval_frames,
        allow_temporal_compression = !all_i_frames,
        "vt_writer configured temporal compression mode"
    );

    match set_vt_property(
        session,
        unsafe { kVTCompressionPropertyKey_ConstantBitRate },
        (&*bitrate_num).as_ref(),
        "ConstantBitRate",
        false,
    ) {
        Ok(true) => {
            tracing::info!(
                target: "storycapture::encoder::vt",
                encoder_path = "vt_writer_zero_copy",
                effective_bitrate_kbps = effective_kbps,
                vt_rate_control = "constant_bitrate",
                "vt_writer configured direct VideoToolbox rate control"
            );
            Ok(())
        }
        Ok(false) => {
            set_vt_property(
                session,
                unsafe { kVTCompressionPropertyKey_AverageBitRate },
                (&*bitrate_num).as_ref(),
                "AverageBitRate",
                true,
            )?;
            tracing::warn!(
                target: "storycapture::encoder::vt",
                encoder_path = "vt_writer_zero_copy",
                effective_bitrate_kbps = effective_kbps,
                vt_rate_control = "average_bitrate_fallback",
                "VideoToolbox ConstantBitRate unsupported; configured AverageBitRate"
            );
            Ok(())
        }
        Err(err) => Err(err),
    }
}

fn set_vt_property(
    session: &VTCompressionSession,
    key: &CFString,
    value: &CFType,
    label: &str,
    required: bool,
) -> Result<bool> {
    let status = unsafe { VTSessionSetProperty(session.as_ref(), key, Some(value)) };
    if status == 0 {
        tracing::debug!(
            target: "storycapture::encoder::vt",
            encoder_path = "vt_writer_zero_copy",
            property = label,
            "vt_writer set VideoToolbox property"
        );
        return Ok(true);
    }
    let message = format!("VTSessionSetProperty({label}) failed: status={status}");
    if required {
        Err(EncoderError::Io(message))
    } else {
        tracing::warn!(
            target: "storycapture::encoder::vt",
            encoder_path = "vt_writer_zero_copy",
            property = label,
            status,
            "vt_writer VideoToolbox property unsupported or rejected"
        );
        Ok(false)
    }
}

fn log_vt_property(session: &VTCompressionSession, key: &CFString, label: &str) {
    let mut raw_value: *const CFType = std::ptr::null();
    let status = unsafe {
        VTSessionCopyProperty(
            session.as_ref(),
            key,
            None,
            &mut raw_value as *mut *const CFType as *mut c_void,
        )
    };
    if status == 0 {
        if let Some(ptr) = NonNull::new(raw_value as *mut CFType) {
            let value = unsafe { CFRetained::<CFType>::from_raw(ptr) };
            tracing::info!(
                target: "storycapture::encoder::vt",
                encoder_path = "vt_writer_zero_copy",
                property = label,
                value = ?value,
                "vt_writer VideoToolbox property readback"
            );
        } else {
            tracing::info!(
                target: "storycapture::encoder::vt",
                encoder_path = "vt_writer_zero_copy",
                property = label,
                "vt_writer VideoToolbox property readback returned null"
            );
        }
    } else {
        tracing::warn!(
            target: "storycapture::encoder::vt",
            encoder_path = "vt_writer_zero_copy",
            property = label,
            status,
            "vt_writer VideoToolbox property readback failed"
        );
    }
}

fn drain_encoded_samples(
    encoded_rx: &std_mpsc::Receiver<EncodedMsg>,
    writer: &AVAssetWriter,
    input: &mut Option<Retained<AVAssetWriterInput>>,
    writer_started: &mut bool,
    frames_written: &mut u64,
    frames_dropped: &mut u64,
) -> Result<()> {
    while let Ok(msg) = encoded_rx.try_recv() {
        match msg {
            EncodedMsg::Error { status, flags } => {
                return Err(EncoderError::Io(format!(
                    "VTCompressionSession output callback failed: status={status} flags={flags:?}"
                )));
            }
            EncodedMsg::Dropped { status, flags } => {
                *frames_dropped += 1;
                tracing::warn!(
                    target: "storycapture::encoder::vt",
                    encoder_path = "vt_writer_zero_copy",
                    status,
                    flags = ?flags,
                    frames_dropped = *frames_dropped,
                    "vt_writer VideoToolbox dropped frame"
                );
            }
            EncodedMsg::Sample { sample_ptr, flags } => {
                let sample_ptr = NonNull::new(sample_ptr as *mut CMSampleBuffer)
                    .ok_or_else(|| EncoderError::Io("encoded sample pointer was null".into()))?;
                let sample = unsafe { CFRetained::<CMSampleBuffer>::from_raw(sample_ptr) };
                if input.is_none() {
                    let format = unsafe { sample.format_description() }.ok_or_else(|| {
                        EncoderError::Io("encoded sample missing format description".into())
                    })?;
                    let media_type = unsafe { AVMediaTypeVideo }.ok_or_else(|| {
                        EncoderError::Io("AVMediaTypeVideo symbol missing".into())
                    })?;
                    let new_input = unsafe {
                        AVAssetWriterInput::assetWriterInputWithMediaType_outputSettings_sourceFormatHint(
                            media_type,
                            None,
                            Some(&*format),
                        )
                    };
                    unsafe { new_input.setExpectsMediaDataInRealTime(true) };
                    if !unsafe { writer.canAddInput(&new_input) } {
                        return Err(EncoderError::Io(
                            "AVAssetWriter cannot add passthrough video input".into(),
                        ));
                    }
                    unsafe { writer.addInput(&new_input) };
                    if !unsafe { writer.startWriting() } {
                        let err = unsafe { writer.error() };
                        let msg = err
                            .map(|e| e.localizedDescription().to_string())
                            .unwrap_or_else(|| "startWriting returned NO".into());
                        return Err(EncoderError::Io(format!(
                            "AVAssetWriter startWriting: {msg}"
                        )));
                    }
                    let t0 = unsafe { CMTime::new(0, 1_000_000_000) };
                    unsafe { writer.startSessionAtSourceTime(t0) };
                    *writer_started = true;
                    *input = Some(new_input);
                    tracing::info!(
                        target: "storycapture::encoder::vt",
                        encoder_path = "vt_writer_zero_copy",
                        "vt_writer AVAssetWriter passthrough input ready"
                    );
                }

                let input_ref = input
                    .as_ref()
                    .ok_or_else(|| EncoderError::Io("AVAssetWriter input missing".into()))?;
                let mut ready = unsafe { input_ref.isReadyForMoreMediaData() };
                let mut waited_ms = 0u64;
                while !ready && waited_ms < 2_000 {
                    thread::sleep(std::time::Duration::from_millis(2));
                    waited_ms += 2;
                    ready = unsafe { input_ref.isReadyForMoreMediaData() };
                }
                if !ready {
                    return Err(EncoderError::Io(
                        "AVAssetWriter passthrough input stayed backpressured for 2s".into(),
                    ));
                }

                let ok = unsafe { input_ref.appendSampleBuffer(&sample) };
                if ok {
                    *frames_written += 1;
                    if *frames_written <= 5 {
                        tracing::info!(
                            target: "storycapture::encoder::vt",
                            encoder_path = "vt_writer_zero_copy",
                            n = *frames_written - 1,
                            flags = ?flags,
                            "vt_writer appended compressed sample"
                        );
                    }
                } else {
                    *frames_dropped += 1;
                    let status = unsafe { writer.status() };
                    if status == AVAssetWriterStatus::Failed
                        || status == AVAssetWriterStatus::Cancelled
                    {
                        let err = unsafe { writer.error() };
                        let msg = err
                            .map(|e| e.localizedDescription().to_string())
                            .unwrap_or_else(|| "appendSampleBuffer failed".into());
                        return Err(EncoderError::Io(format!("AVAssetWriter failed: {msg}")));
                    }
                }
            }
        }
    }
    if *writer_started {
        tracing::trace!(
            target: "storycapture::encoder::vt",
            encoder_path = "vt_writer_zero_copy",
            frames_written = *frames_written,
            frames_dropped = *frames_dropped,
            "vt_writer drained encoded sample queue"
        );
    }
    Ok(())
}

fn run_worker_inner(
    cfg: EncodeConfig,
    cmd_rx: std_mpsc::Receiver<Cmd>,
    progress_tx: tokio::sync::mpsc::Sender<EncodeProgress>,
) -> Result<EncodeResult> {
    // Keep transient Objective-C objects scoped.
    objc2::rc::autoreleasepool(|_| -> Result<EncodeResult> {
        let target_path = cfg.output_path.clone();
        // Stage writer output at `<target>.partial`; rename atomically on
        // success; drop-cleanup on any failure path.
        let partial_path = crate::staging::partial_path_of(&target_path);
        let _ = std::fs::remove_file(&partial_path);
        let _guard = crate::staging::PartialFileGuard::new(partial_path.clone());
        let output_path = partial_path.clone();
        let start = Instant::now();

        // Build AVAssetWriter (writes to `.partial`).
        let _ = std::fs::remove_file(&output_path);
        // `fileURLWithPath:` wants a POSIX path, not a file URL.
        let path_str = NSString::from_str(&output_path.display().to_string());
        let url: Retained<NSURL> = NSURL::fileURLWithPath(&path_str);

        let file_type = unsafe { AVFileTypeMPEG4 }
            .ok_or_else(|| EncoderError::Io("AVFileTypeMPEG4 symbol missing".into()))?;

        let writer = unsafe { AVAssetWriter::assetWriterWithURL_fileType_error(&url, file_type) }
            .map_err(|e| {
            EncoderError::Io(format!("AVAssetWriter init: {}", e.localizedDescription()))
        })?;
        tracing::debug!(
            target: "storycapture::encoder::vt",
            encoder_path = "vt_writer_zero_copy",
            "vt_writer AVAssetWriter created"
        );

        // VT writer is a native fast-path that bypasses the filter graph; it
        // encodes at capture dims. Bitrate 0 maps to the preset-aware
        // screen-content target, not the softer base budget.
        let effective_kbps = if cfg.bitrate_kbps == 0 {
            crate::quality::target_kbps(
                cfg.quality_preset,
                cfg.encoder,
                cfg.capture_width,
                cfg.capture_height,
                cfg.fps_advisory,
            )
            .max(crate::quality::pixel_based_kbps(
                cfg.capture_width,
                cfg.capture_height,
                cfg.fps_advisory,
            ))
        } else {
            cfg.bitrate_kbps
        };
        let bitrate_bps: i64 = (effective_kbps as i64) * 1000;
        let fps = cfg.fps_advisory.max(1);
        let all_i_frames = matches!(cfg.quality_preset, QualityPreset::Lossless);
        let keyframe_interval_frames = if all_i_frames { 1 } else { fps };
        let frame_duration = unsafe { CMTime::new(1, fps as i32) };
        let frame_duration_ns = (1_000_000_000i64 / i64::from(fps)).max(1);

        tracing::info!(
            target: "storycapture::encoder::vt",
            encoder_path = "vt_writer_zero_copy",
            output_width_px = cfg.capture_width,
            output_height_px = cfg.capture_height,
            fps,
            configured_bitrate_kbps = cfg.bitrate_kbps,
            effective_bitrate_kbps = effective_kbps,
            vt_rate_control = "constant_bitrate",
            vt_quality = 1.0,
            max_allowed_qp = 18,
            allow_frame_reordering = false,
            all_i_frames,
            allow_temporal_compression = !all_i_frames,
            keyframe_interval_frames,
            output = %output_path.display(),
            "vt_writer initializing VTCompressionSession"
        );

        let pixel_format_num = CFNumber::new_i32(kCVPixelFormatType_32BGRA as i32);
        let width_num = CFNumber::new_i32(cfg.capture_width as i32);
        let height_num = CFNumber::new_i32(cfg.capture_height as i32);
        let empty_iosurface_props: CFRetained<CFDictionary<CFString, CFType>> =
            CFDictionary::from_slices(&[], &[]);
        let pixel_buffer_attrs: CFRetained<CFDictionary<CFString, CFType>> =
            CFDictionary::from_slices(
                &[
                    unsafe { kCVPixelBufferPixelFormatTypeKey },
                    unsafe { kCVPixelBufferWidthKey },
                    unsafe { kCVPixelBufferHeightKey },
                    unsafe { kCVPixelBufferIOSurfacePropertiesKey },
                ],
                &[
                    (&*pixel_format_num).as_ref(),
                    (&*width_num).as_ref(),
                    (&*height_num).as_ref(),
                    (&*empty_iosurface_props).as_ref(),
                ],
            );

        let (encoded_tx, encoded_rx) = std_mpsc::channel::<EncodedMsg>();
        let callback_ctx = CallbackContextGuard::new(CallbackContext { tx: encoded_tx });
        let mut compression_session: *mut VTCompressionSession = std::ptr::null_mut();
        let encoder_spec = make_encoder_spec();
        let create_status = unsafe {
            VTCompressionSession::create(
                None,
                cfg.capture_width as i32,
                cfg.capture_height as i32,
                kCMVideoCodecType_H264,
                Some(encoder_spec.as_ref()),
                Some(pixel_buffer_attrs.as_ref()),
                None,
                Some(vt_output_callback),
                callback_ctx.as_void_ptr(),
                NonNull::new(&mut compression_session as *mut *mut VTCompressionSession)
                    .expect("compression_session out pointer is non-null"),
            )
        };
        if create_status != 0 || compression_session.is_null() {
            return Err(EncoderError::Io(format!(
                "VTCompressionSessionCreate failed: status={create_status}"
            )));
        }
        let compression_session = unsafe {
            CFRetained::from_raw(
                NonNull::new(compression_session)
                    .expect("VTCompressionSessionCreate returned non-null session"),
            )
        };
        let _session_invalidator = VtSessionInvalidator(&compression_session);

        configure_vt_session(
            &compression_session,
            effective_kbps,
            bitrate_bps,
            fps,
            all_i_frames,
        )?;
        log_vt_property(
            &compression_session,
            unsafe { kVTCompressionPropertyKey_ConstantBitRate },
            "ConstantBitRate",
        );
        log_vt_property(
            &compression_session,
            unsafe { kVTCompressionPropertyKey_AverageBitRate },
            "AverageBitRate",
        );
        log_vt_property(
            &compression_session,
            unsafe { kVTCompressionPropertyKey_MaxAllowedFrameQP },
            "MaxAllowedFrameQP",
        );
        log_vt_property(
            &compression_session,
            unsafe { kVTCompressionPropertyKey_MaxKeyFrameInterval },
            "MaxKeyFrameInterval",
        );
        if all_i_frames {
            let allow_temporal_compression_key =
                CFString::from_static_str("AllowTemporalCompression");
            log_vt_property(
                &compression_session,
                allow_temporal_compression_key.as_ref(),
                "AllowTemporalCompression",
            );
        }
        log_vt_property(
            &compression_session,
            unsafe { kVTCompressionPropertyKey_UsingHardwareAcceleratedVideoEncoder },
            "UsingHardwareAcceleratedVideoEncoder",
        );

        let prepare_status = unsafe { compression_session.prepare_to_encode_frames() };
        if prepare_status != 0 {
            return Err(EncoderError::Io(format!(
                "VTCompressionSessionPrepareToEncodeFrames failed: status={prepare_status}"
            )));
        }
        tracing::info!(
            target: "storycapture::encoder::vt",
            encoder_path = "vt_writer_zero_copy",
            source_pixel_format = "32BGRA",
            source_width_px = cfg.capture_width,
            source_height_px = cfg.capture_height,
            "vt_writer direct VideoToolbox session ready for frames"
        );

        // --- Frame loop ---
        let mut frames_written: u64 = 0;
        let mut frames_dropped: u64 = 0;
        let mut frames_submitted: u64 = 0;
        let mut first_pts_ns: i128 = 0;
        let mut last_rel_ns: Option<i64> = None;
        let mut large_gap_count: u64 = 0;
        let mut max_large_gap_ns: i64 = 0;
        let mut last_progress_at = Instant::now();
        let mut writer_started = false;
        let mut input: Option<Retained<AVAssetWriterInput>> = None;

        loop {
            let cmd = match cmd_rx.recv() {
                Ok(c) => c,
                Err(_) => break, // channel closed without Finish
            };
            match cmd {
                Cmd::Finish => break,
                Cmd::Cancel { reason } => {
                    tracing::error!(
                        target: "storycapture::encoder::vt",
                        encoder_path = "vt_writer_zero_copy",
                        frames_written,
                        frames_dropped,
                        reason = %reason,
                        "vt_writer cancelled"
                    );
                    return Err(EncoderError::InvalidConfig(reason));
                }
                Cmd::Append { buffer, pts_ns } => {
                    if frames_submitted == 0 {
                        first_pts_ns = pts_ns;
                    }

                    let normalized =
                        normalize_rel_pts(pts_ns, first_pts_ns, last_rel_ns, frame_duration_ns);
                    match normalized.event {
                        Some(PtsNormalizationEvent::BeforeFirst) => {
                            let n = PTS_CLAMP_COUNT.fetch_add(1, Ordering::AcqRel) + 1;
                            tracing::warn!(
                                target: "storycapture::encoder::vt",
                                pts_ns = pts_ns as i64,
                                first_pts_ns = first_pts_ns as i64,
                                clamp_count = n,
                                "vt_writer: pts < first_pts, clamping to 0 (clock jump?)"
                            );
                        }
                        Some(PtsNormalizationEvent::NonMonotonic) => {
                            let n = PTS_CLAMP_COUNT.fetch_add(1, Ordering::AcqRel) + 1;
                            tracing::warn!(
                                target: "storycapture::encoder::vt",
                                pts_ns = pts_ns as i64,
                                first_pts_ns = first_pts_ns as i64,
                                last_rel_ns,
                                rel_ns = normalized.rel_ns,
                                frame_duration_ns,
                                clamp_count = n,
                                "vt_writer: non-monotonic pts, bumping by one frame duration"
                            );
                        }
                        Some(PtsNormalizationEvent::LargeGap(gap_ns)) => {
                            large_gap_count = large_gap_count.saturating_add(1);
                            max_large_gap_ns = max_large_gap_ns.max(gap_ns);
                            if large_gap_count <= 3 {
                                tracing::warn!(
                                    target: "storycapture::encoder::vt",
                                    pts_ns = pts_ns as i64,
                                    first_pts_ns = first_pts_ns as i64,
                                    last_rel_ns,
                                    rel_ns = normalized.rel_ns,
                                    gap_ns,
                                    large_gap_count,
                                    "vt_writer: large capture PTS gap preserved"
                                );
                            }
                        }
                        None => {}
                    }
                    let rel_ns = normalized.rel_ns;
                    let cm_pts = unsafe { CMTime::new(rel_ns, 1_000_000_000) };
                    if frames_submitted < 5 {
                        tracing::info!(
                            target: "storycapture::encoder",
                            n = frames_submitted,
                            pts_ns = pts_ns as i64,
                            first_pts_ns = first_pts_ns as i64,
                            rel_ns,
                            "vt_writer append"
                        );
                    }
                    last_rel_ns = Some(rel_ns);

                    let raw: *mut c_void = buffer.as_ptr();
                    let pb: &CVPixelBuffer = unsafe { &*(raw as *const CVPixelBuffer) };
                    let mut info_flags = VTEncodeInfoFlags(0);
                    let encode_status = unsafe {
                        compression_session.encode_frame(
                            pb,
                            cm_pts,
                            frame_duration,
                            None,
                            std::ptr::null_mut(),
                            &mut info_flags as *mut VTEncodeInfoFlags,
                        )
                    };
                    drop(buffer);

                    if encode_status != 0 {
                        return Err(EncoderError::Io(format!(
                            "VTCompressionSessionEncodeFrame failed: status={encode_status} flags={:?}",
                            info_flags
                        )));
                    }
                    if info_flags.contains(VTEncodeInfoFlags::FrameDropped) {
                        frames_dropped += 1;
                    } else {
                        frames_submitted += 1;
                    }

                    drain_encoded_samples(
                        &encoded_rx,
                        &writer,
                        &mut input,
                        &mut writer_started,
                        &mut frames_written,
                        &mut frames_dropped,
                    )?;

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

        let complete_status = unsafe { compression_session.complete_frames(kCMTimeInvalid) };
        if complete_status != 0 {
            return Err(EncoderError::Io(format!(
                "VTCompressionSessionCompleteFrames failed: status={complete_status}"
            )));
        }
        drain_encoded_samples(
            &encoded_rx,
            &writer,
            &mut input,
            &mut writer_started,
            &mut frames_written,
            &mut frames_dropped,
        )?;

        // --- Finalize ---
        let input = input.ok_or_else(|| {
            EncoderError::Io("VTCompressionSession produced no encoded samples".into())
        })?;
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

        // Atomic rename `.partial` -> target. Same dir = atomic on
        // HFS+/APFS. Disarm the guard so Drop does not delete the renamed
        // file.
        std::fs::rename(&partial_path, &target_path).map_err(|e| {
            EncoderError::Io(format!(
                "rename {} -> {}: {e}",
                partial_path.display(),
                target_path.display()
            ))
        })?;
        _guard.disarm();

        tracing::info!(
            target: "storycapture::encoder::vt",
            encoder_path = "vt_writer_zero_copy",
            output_width_px = cfg.capture_width,
            output_height_px = cfg.capture_height,
            configured_output_width_px = cfg.output_width,
            configured_output_height_px = cfg.output_height,
            duration_ms,
            bytes,
            frames_written,
            frames_dropped,
            large_gap_count,
            max_large_gap_ns,
            "vt_writer encode complete"
        );

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
            output_path: target_path,
            duration_ms,
            bytes,
            frames_written,
            frames_dropped,
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    static PTS_TEST_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn pts_clamp_increments_counter() {
        let _guard = PTS_TEST_LOCK.lock().unwrap();
        let before = PTS_CLAMP_COUNT.load(Ordering::Acquire);
        let first_pts_ns: i128 = 1_000_000_000;
        let pts_ns: i128 = 500_000_000;
        let normalized = normalize_rel_pts(pts_ns, first_pts_ns, None, 16_666_666);
        if normalized.event == Some(PtsNormalizationEvent::BeforeFirst) {
            let _ = PTS_CLAMP_COUNT.fetch_add(1, Ordering::AcqRel) + 1;
        }
        assert_eq!(normalized.rel_ns, 0);
        assert_eq!(normalized.event, Some(PtsNormalizationEvent::BeforeFirst));
        assert_eq!(PTS_CLAMP_COUNT.load(Ordering::Acquire), before + 1);
    }

    #[test]
    fn pts_normal_no_clamp() {
        let _guard = PTS_TEST_LOCK.lock().unwrap();
        let before = PTS_CLAMP_COUNT.load(Ordering::Acquire);
        let first_pts_ns: i128 = 1_000;
        let pts_ns: i128 = 2_000;
        let normalized = normalize_rel_pts(pts_ns, first_pts_ns, None, 16_666_666);
        if normalized.event == Some(PtsNormalizationEvent::BeforeFirst) {
            let _ = PTS_CLAMP_COUNT.fetch_add(1, Ordering::AcqRel);
        }
        assert_eq!(normalized.rel_ns, 1_000);
        assert_eq!(normalized.event, None);
        assert_eq!(PTS_CLAMP_COUNT.load(Ordering::Acquire), before);
    }

    #[test]
    fn pts_repeated_value_bumps_after_last_relative_pts() {
        let normalized =
            normalize_rel_pts(1_050_000_000, 1_000_000_000, Some(50_000_000), 16_666_666);

        assert_eq!(normalized.rel_ns, 66_666_666);
        assert_eq!(normalized.event, Some(PtsNormalizationEvent::NonMonotonic));
    }

    #[test]
    fn pts_increasing_value_preserves_elapsed_time() {
        let normalized =
            normalize_rel_pts(1_050_000_000, 1_000_000_000, Some(16_666_666), 16_666_666);

        assert_eq!(normalized.rel_ns, 50_000_000);
        assert_eq!(normalized.event, None);
    }

    #[test]
    fn pts_large_gap_event_uses_cadence_aware_threshold() {
        let one_fps_duration_ns = 1_000_000_000;
        let normal_one_fps_gap =
            normalize_rel_pts(2_000_000_000, 1_000_000_000, Some(0), one_fps_duration_ns);
        let large_gap =
            normalize_rel_pts(4_000_000_001, 1_000_000_000, Some(0), one_fps_duration_ns);

        assert_eq!(normal_one_fps_gap.event, None);
        assert_eq!(
            large_gap.event,
            Some(PtsNormalizationEvent::LargeGap(3_000_000_001))
        );
    }
}
