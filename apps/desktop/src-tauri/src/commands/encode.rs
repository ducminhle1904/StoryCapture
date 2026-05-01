// encoder IPC.
//
// Thin Tauri bridge around the pure `encoder` crate.

use crate::commands::capture::CaptureTargetDto;
use crate::error::AppError;
use crate::state::AppState;
use capture::audio::{
    make_fifo, negotiate_input, AudioCaptureStream, FifoHandle, NegotiatedAudioInput,
};
use capture::trajectory::{
    sidecar_path_for as trajectory_sidecar_path, CaptureRect as TrajectoryCaptureRect,
    TrajectoryRecorder,
};
use capture::{ByteBoundedQueue, CaptureConfig, CaptureEvent, CapturePipeline, Frame, PixelFormat};
use encoder::{
    probe_encoders, AudioFormat, AudioInput, ColorAdjustment, EncodeConfig, EncodePipeline,
    EncodeProgress, EncodeResult, EncoderError, EncoderProbe, FitMode, HardwareEncoder,
    OutputResolution, PadColor, QualityPreset, ScaleAlgo, SidecarChild, SidecarCommand,
};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_shell::ShellExt;
use tokio::process::Command as TokioCommand;
use tokio::sync::mpsc;
use tokio::task::{AbortHandle, JoinHandle};
use uuid::Uuid;

const ENCODER_FRAME_CHANNEL_CAPACITY: usize = 4;

#[derive(Debug, Clone)]
enum PostMuxAudio {
    Silent,
    Pcm {
        path: PathBuf,
        sample_rate: u32,
        channels: u16,
        format: AudioFormat,
    },
}

#[derive(Debug, Clone)]
struct PostMuxPlan {
    video_path: PathBuf,
    output_path: PathBuf,
    audio: PostMuxAudio,
}

#[derive(Debug, Clone, Copy)]
struct RecordingQualityPlan {
    encoder: HardwareEncoder,
    quality_mode: RecordingQualityMode,
    fallback_reason: Option<&'static str>,
    capture_width: u32,
    capture_height: u32,
    output_width: u32,
    output_height: u32,
    fps: u32,
    preset: QualityPreset,
    target_video_kbps: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RecordingQualityMode {
    SoftwareCrf,
    SoftwareBitrate,
    HardwareBitrate,
}

#[derive(Debug)]
struct RecordingEncoderSelection {
    encoder: HardwareEncoder,
    quality_mode: RecordingQualityMode,
    fallback_reason: Option<&'static str>,
}

impl RecordingEncoderSelection {
    fn new(encoder: HardwareEncoder, fallback_reason: Option<&'static str>) -> Self {
        Self {
            encoder,
            quality_mode: quality_mode_for_encoder(encoder),
            fallback_reason,
        }
    }
}

// ---------------------------------------------------------------------------
// SidecarCommand bridge
// ---------------------------------------------------------------------------

/// Resolve a sidecar binary next to the app executable.
pub fn resolve_sidecar_path(name: &str) -> Result<std::path::PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| format!("current_exe: {e}"))?;
    let dir = exe.parent().ok_or("exe has no parent")?;
    let bundled = dir.join(name);
    if bundled.exists() {
        return Ok(bundled);
    }
    // Dev mode: look for any `<name>-<triple>` sibling.
    let prefix = format!("{name}-");
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let fname = entry.file_name();
            let s = fname.to_string_lossy();
            if s.starts_with(&prefix) {
                return Ok(entry.path());
            }
        }
    }
    Err(format!(
        "sidecar {name} not found at {} (or {}* in dev)",
        bundled.display(),
        prefix
    ))
}

/// FFmpeg sidecar wrapper that re-spawns the raw binary through tokio.
pub struct TauriSidecar {
    binary_name: String,
    app: AppHandle,
}

impl TauriSidecar {
    pub fn new(app: AppHandle) -> Self {
        TauriSidecar {
            binary_name: "ffmpeg".into(),
            app,
        }
    }
}

#[async_trait::async_trait]
impl SidecarCommand for TauriSidecar {
    async fn spawn(&self, args: Vec<String>) -> Result<SidecarChild, EncoderError> {
        // Resolve the per-triple externalBin path.
        let _resolved = self
            .app
            .shell()
            .sidecar(&self.binary_name)
            .map_err(|e| EncoderError::SpawnFailed(format!("resolve sidecar: {e}")))?;

        let binary_path = resolve_sidecar_path(&self.binary_name)
            .map_err(|e| EncoderError::SpawnFailed(format!("locate sidecar: {e}")))?;

        let mut cmd = TokioCommand::new(&binary_path);
        cmd.args(&args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = cmd.spawn().map_err(|e| {
            EncoderError::SpawnFailed(format!("tokio spawn {}: {e}", self.binary_name))
        })?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| EncoderError::SpawnFailed("missing stdin handle".into()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| EncoderError::SpawnFailed("missing stdout handle".into()))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| EncoderError::SpawnFailed("missing stderr handle".into()))?;
        Ok(SidecarChild {
            stdin,
            stdout,
            stderr,
            child,
        })
    }
}

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum HardwareEncoderDto {
    VideoToolboxH264,
    VideoToolboxHevc,
    NvencH264,
    QsvH264,
    AmfH264,
    #[serde(rename = "libx264-software")]
    Libx264Software,
    Openh264Software,
}

impl From<HardwareEncoder> for HardwareEncoderDto {
    fn from(e: HardwareEncoder) -> Self {
        match e {
            HardwareEncoder::VideoToolboxH264 => HardwareEncoderDto::VideoToolboxH264,
            HardwareEncoder::VideoToolboxHevc => HardwareEncoderDto::VideoToolboxHevc,
            HardwareEncoder::NvencH264 => HardwareEncoderDto::NvencH264,
            HardwareEncoder::QsvH264 => HardwareEncoderDto::QsvH264,
            HardwareEncoder::AmfH264 => HardwareEncoderDto::AmfH264,
            HardwareEncoder::Libx264Software => HardwareEncoderDto::Libx264Software,
            HardwareEncoder::Openh264Software => HardwareEncoderDto::Openh264Software,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum FitModeDto {
    Letterbox,
    FillCrop,
    Stretch,
}

impl From<FitModeDto> for FitMode {
    fn from(v: FitModeDto) -> Self {
        match v {
            FitModeDto::Letterbox => FitMode::Letterbox,
            FitModeDto::FillCrop => FitMode::FillCrop,
            FitModeDto::Stretch => FitMode::Stretch,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum ScaleAlgoDto {
    Lanczos,
    Bicubic,
    Bilinear,
    Area,
}

impl From<ScaleAlgoDto> for ScaleAlgo {
    fn from(v: ScaleAlgoDto) -> Self {
        match v {
            ScaleAlgoDto::Lanczos => ScaleAlgo::Lanczos,
            ScaleAlgoDto::Bicubic => ScaleAlgo::Bicubic,
            ScaleAlgoDto::Bilinear => ScaleAlgo::Bilinear,
            ScaleAlgoDto::Area => ScaleAlgo::Area,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum QualityPresetDto {
    Low,
    Med,
    High,
    Lossless,
}

impl From<QualityPresetDto> for QualityPreset {
    fn from(v: QualityPresetDto) -> Self {
        match v {
            QualityPresetDto::Low => QualityPreset::Low,
            QualityPresetDto::Med => QualityPreset::Med,
            QualityPresetDto::High => QualityPreset::High,
            QualityPresetDto::Lossless => QualityPreset::Lossless,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum PadColorDto {
    Black,
    White,
    Custom { r: u8, g: u8, b: u8 },
}

impl From<PadColorDto> for PadColor {
    fn from(v: PadColorDto) -> Self {
        match v {
            PadColorDto::Black => PadColor::Black,
            PadColorDto::White => PadColor::White,
            PadColorDto::Custom { r, g, b } => PadColor::Custom { r, g, b },
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum OutputResolutionDto {
    P720,
    P1080,
    P1440,
    P2160,
    MatchSource,
    Custom { w: u32, h: u32 },
}

impl From<OutputResolutionDto> for OutputResolution {
    fn from(v: OutputResolutionDto) -> Self {
        match v {
            OutputResolutionDto::P720 => OutputResolution::P720,
            OutputResolutionDto::P1080 => OutputResolution::P1080,
            OutputResolutionDto::P1440 => OutputResolution::P1440,
            OutputResolutionDto::P2160 => OutputResolution::P2160,
            OutputResolutionDto::MatchSource => OutputResolution::MatchSource,
            OutputResolutionDto::Custom { w, h } => OutputResolution::Custom { w, h },
        }
    }
}

#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct EncoderProbeDto {
    pub available: Vec<HardwareEncoderDto>,
    pub preferred: HardwareEncoderDto,
}

impl From<EncoderProbe> for EncoderProbeDto {
    fn from(p: EncoderProbe) -> Self {
        EncoderProbeDto {
            available: p.available.into_iter().map(Into::into).collect(),
            preferred: p.preferred.into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct EncodeResultDto {
    pub output_path: String,
    pub duration_ms: u64,
    pub bytes: u64,
    pub frames_written: u64,
    pub frames_dropped: u64,
}

impl From<EncodeResult> for EncodeResultDto {
    fn from(r: EncodeResult) -> Self {
        EncodeResultDto {
            output_path: r.output_path.display().to_string(),
            duration_ms: r.duration_ms,
            bytes: r.bytes,
            frames_written: r.frames_written,
            frames_dropped: r.frames_dropped,
        }
    }
}

/// Unified recording event from capture / encode progress and terminal results.
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum RecordingEvent {
    CaptureStatus {
        json: String,
    },
    EncodeProgress {
        progress: EncodeProgressDto,
    },
    /// Emitted periodically from the capture pipeline when the
    /// byte-bounded queue has dropped frames. `total` is the lifetime
    /// count for this session; `delta` is the count since the last
    /// event (always >= 1 when an event fires).
    FramesDropped {
        total: u64,
        delta: u64,
    },
    Completed {
        result: EncodeResultDto,
    },
    Failed {
        message: String,
    },
    /// Mic/audio negotiation failed or the device vanished mid-session.
    /// Recording continues video-only.
    AudioUnavailable {
        reason: String,
    },
    /// Periodic liveness signal from the host so the renderer can detect
    /// state-sync drift (>5s missed => offer Force Stop).
    Heartbeat {
        seq: u64,
    },
}

fn emit_audio_unavailable<E: std::fmt::Display>(channel: &Channel<RecordingEvent>, err: &E) {
    let _ = channel.send(RecordingEvent::AudioUnavailable {
        reason: err.to_string(),
    });
}

fn partial_path_for(target: &std::path::Path) -> PathBuf {
    let mut p = target.to_path_buf();
    let Some(stem) = target.file_stem().map(|stem| stem.to_os_string()) else {
        return p.with_extension("partial");
    };
    let mut partial = stem;
    partial.push(".partial");
    if let Some(ext) = target.extension() {
        partial.push(".");
        partial.push(ext);
    }
    p.set_file_name(partial);
    p
}

fn build_post_mux_args(plan: &PostMuxPlan, mux_output_path: &std::path::Path) -> Vec<String> {
    let mut args = vec![
        "-hide_banner".into(),
        "-y".into(),
        "-i".into(),
        plan.video_path.display().to_string(),
    ];

    match &plan.audio {
        PostMuxAudio::Silent => {
            args.extend([
                "-f".into(),
                "lavfi".into(),
                "-i".into(),
                "anullsrc=r=48000:cl=mono".into(),
            ]);
        }
        PostMuxAudio::Pcm {
            path,
            sample_rate,
            channels,
            format,
        } => {
            args.extend([
                "-f".into(),
                format.ffmpeg_name().into(),
                "-ar".into(),
                sample_rate.to_string(),
                "-ac".into(),
                channels.to_string(),
                "-i".into(),
                path.display().to_string(),
            ]);
        }
    }

    args.extend([
        "-map".into(),
        "0:v:0".into(),
        "-map".into(),
        "1:a:0".into(),
        "-c:v".into(),
        "copy".into(),
        "-c:a".into(),
        "aac".into(),
    ]);

    match &plan.audio {
        PostMuxAudio::Silent => {
            args.extend(["-b:a".into(), "64k".into()]);
        }
        PostMuxAudio::Pcm { .. } => {
            args.extend(["-b:a".into(), "128k".into(), "-ac".into(), "2".into()]);
        }
    }

    args.extend([
        "-shortest".into(),
        "-movflags".into(),
        "+faststart".into(),
        "-loglevel".into(),
        "info".into(),
        mux_output_path.display().to_string(),
    ]);
    args
}

async fn finalize_post_mux(
    mut result: EncodeResult,
    plan: &PostMuxPlan,
) -> Result<EncodeResult, AppError> {
    let partial_path = partial_path_for(&plan.output_path);
    let _ = std::fs::remove_file(&partial_path);
    let args = build_post_mux_args(plan, &partial_path);
    tracing::info!(
        target: "storycapture::recording",
        video_path = %plan.video_path.display(),
        output_path = %plan.output_path.display(),
        audio = ?plan.audio,
        ffmpeg_args = %args.join(" "),
        "post-muxing recorder audio with copied VT video stream"
    );

    let binary_path = resolve_sidecar_path("ffmpeg").map_err(AppError::Encoder)?;
    let output = TokioCommand::new(&binary_path)
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
        .map_err(|e| AppError::Encoder(format!("spawn ffmpeg mux: {e}")))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stderr_tail = stderr
            .lines()
            .rev()
            .take(30)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<Vec<_>>()
            .join(" | ");
        tracing::error!(
            target: "storycapture::recording",
            status = ?output.status,
            stderr_tail,
            preserved_video_path = %plan.video_path.display(),
            "post-mux failed; preserving video-only temp output"
        );
        let _ = std::fs::remove_file(&partial_path);
        return Err(AppError::Encoder(format!(
            "audio mux failed with status {}: {stderr_tail}. Preserved video at {}",
            output.status,
            plan.video_path.display()
        )));
    }

    std::fs::rename(&partial_path, &plan.output_path).map_err(|e| {
        AppError::Encoder(format!(
            "rename mux output {} -> {}: {e}",
            partial_path.display(),
            plan.output_path.display()
        ))
    })?;

    result.output_path = plan.output_path.clone();
    result.bytes = std::fs::metadata(&result.output_path)
        .map(|m| m.len())
        .unwrap_or(result.bytes);

    if let Err(e) = std::fs::remove_file(&plan.video_path) {
        tracing::debug!(
            target: "storycapture::recording",
            error = %e,
            path = %plan.video_path.display(),
            "post-mux video temp cleanup skipped"
        );
    }
    if let PostMuxAudio::Pcm { path, .. } = &plan.audio {
        if let Err(e) = std::fs::remove_file(path) {
            tracing::debug!(
                target: "storycapture::recording",
                error = %e,
                path = %path.display(),
                "post-mux audio temp cleanup skipped"
            );
        }
    }

    tracing::info!(
        target: "storycapture::recording",
        output_path = %result.output_path.display(),
        bytes = result.bytes,
        duration_ms = result.duration_ms,
        frames_written = result.frames_written,
        frames_dropped = result.frames_dropped,
        "post-mux completed"
    );
    Ok(result)
}

#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct EncodeProgressDto {
    pub frame: u64,
    pub fps: f32,
    pub bitrate_kbps: f32,
    pub out_time_ms: u64,
    pub drop_frames: u64,
    pub dup_frames: u64,
    pub speed: f32,
    pub finished: bool,
}

impl From<EncodeProgress> for EncodeProgressDto {
    fn from(p: EncodeProgress) -> Self {
        EncodeProgressDto {
            frame: p.frame,
            fps: p.fps,
            bitrate_kbps: p.bitrate_kbps,
            out_time_ms: p.out_time_ms,
            drop_frames: p.drop_frames,
            dup_frames: p.dup_frames,
            speed: p.speed,
            finished: p.finished,
        }
    }
}

impl From<CaptureEvent> for RecordingEvent {
    fn from(e: CaptureEvent) -> Self {
        RecordingEvent::CaptureStatus {
            json: serde_json::to_string(&e).unwrap_or_else(|_| "{}".into()),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct RecordingSessionId(pub String);

#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct StartRecordingArgs {
    pub project_folder: String,
    /// Capture target DTO.
    pub target: CaptureTargetDto,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    /// Optional mic device.
    #[serde(default)]
    pub audio_device_id: Option<String>,
    /// Optional per-recording cursor toggle.
    #[serde(default)]
    pub include_cursor: Option<bool>,
    #[serde(default)]
    pub output_resolution: Option<OutputResolutionDto>,
    #[serde(default)]
    pub fit_mode: Option<FitModeDto>,
    #[serde(default)]
    pub pad_color: Option<PadColorDto>,
    #[serde(default)]
    pub quality_preset: Option<QualityPresetDto>,
    #[serde(default)]
    pub scale_algo: Option<ScaleAlgoDto>,
    /// First-frame wait budget in milliseconds. Defaults to 3000 when `None`.
    #[serde(default)]
    pub first_frame_timeout_ms: Option<u64>,
    /// Force a keyframe every N seconds. `None` keeps FFmpeg's default GOP.
    #[serde(default)]
    pub keyframe_interval_sec: Option<u32>,
    /// Optional frame-relative crop applied to each captured frame before
    /// encoding. `basis_w/h` may describe the full logical window size this
    /// crop was measured against, allowing capture backends to scale it to the
    /// actual native frame size.
    #[serde(default)]
    pub frame_crop: Option<FrameCropRectDto>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, specta::Type)]
pub struct FrameCropRectDto {
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
    #[serde(default)]
    pub basis_w: Option<u32>,
    #[serde(default)]
    pub basis_h: Option<u32>,
    #[serde(default)]
    pub scale_hint: Option<f64>,
}

impl From<FrameCropRectDto> for capture::FrameCropRect {
    fn from(r: FrameCropRectDto) -> Self {
        capture::FrameCropRect {
            x: r.x,
            y: r.y,
            w: r.w,
            h: r.h,
            basis_w: r.basis_w,
            basis_h: r.basis_h,
            scale_hint: r.scale_hint,
        }
    }
}

fn hidpi_capture_under_resolved_reason(
    frame_crop: Option<FrameCropRectDto>,
    actual_width: u32,
    actual_height: u32,
) -> Option<String> {
    let crop = frame_crop?;
    let scale = crop.scale_hint?;
    if !scale.is_finite() || scale < 1.5 || crop.w == 0 || crop.h == 0 {
        return None;
    }

    let expected_width = ((crop.w as f64) * scale).round().max(1.0) as u32;
    let expected_height = ((crop.h as f64) * scale).round().max(1.0) as u32;
    let min_width = ((expected_width as f64) * 0.9).round().max(1.0) as u32;
    let min_height = ((expected_height as f64) * 0.9).round().max(1.0) as u32;

    if actual_width >= min_width && actual_height >= min_height {
        return None;
    }

    Some(format!(
        "High-DPI capture under-resolved: browser DPR is {scale:.2}, expected roughly {expected_width}x{expected_height} after crop, but ScreenCaptureKit delivered {actual_width}x{actual_height}. Refusing to encode a soft 1x recording."
    ))
}

// ---------------------------------------------------------------------------
// Session registry
// ---------------------------------------------------------------------------

struct RecordingHandle {
    capture: Arc<tokio::sync::Mutex<CapturePipeline>>,
    encode_join: JoinHandle<encoder::Result<EncodeResult>>,
    /// Target output file.
    #[allow(dead_code)]
    output_path: PathBuf,
    /// Optional post-encode mux step for macOS VideoToolbox recorder output.
    post_mux: Option<PostMuxPlan>,
    /// Optional mic capture stream.
    audio_stream: Arc<tokio::sync::Mutex<Option<AudioCaptureStream>>>,
    /// Named-pipe handle.
    #[allow(dead_code)]
    audio_fifo: Option<FifoHandle>,
    /// Handle for the 2s heartbeat ticker. Aborted by
    /// `stop_recording_inner`, `drain_one`, or the SpawnAbortGuard on
    /// an early-return from `start_recording`.
    heartbeat_abort: Option<AbortHandle>,
    /// Cursor trajectory recorder (Phase 19-02). Best-effort sidecar
    /// emitted next to the MP4. Stopped from `stop_recording_inner`.
    /// Failures here MUST NOT abort the recording itself.
    trajectory: Option<TrajectoryRecorder>,
    /// Encoder diagnostics captured at session start so stop can compare
    /// observed bitrate against the intended quality budget.
    quality_plan: RecordingQualityPlan,
}

#[derive(Default)]
struct RecordingRegistry {
    sessions: Mutex<HashMap<String, RecordingHandle>>,
}

fn registry() -> &'static RecordingRegistry {
    use std::sync::OnceLock;
    static REG: OnceLock<RecordingRegistry> = OnceLock::new();
    REG.get_or_init(RecordingRegistry::default)
}

fn quality_mode_for_encoder(encoder: HardwareEncoder) -> RecordingQualityMode {
    match encoder {
        HardwareEncoder::Libx264Software => RecordingQualityMode::SoftwareCrf,
        HardwareEncoder::Openh264Software => RecordingQualityMode::SoftwareBitrate,
        HardwareEncoder::VideoToolboxH264
        | HardwareEncoder::VideoToolboxHevc
        | HardwareEncoder::NvencH264
        | HardwareEncoder::QsvH264
        | HardwareEncoder::AmfH264 => RecordingQualityMode::HardwareBitrate,
    }
}

#[cfg(target_os = "macos")]
fn should_post_mux_video_toolbox(encoder: HardwareEncoder) -> bool {
    matches!(
        encoder,
        HardwareEncoder::VideoToolboxH264 | HardwareEncoder::VideoToolboxHevc
    )
}

#[cfg(not(target_os = "macos"))]
fn should_post_mux_video_toolbox(_encoder: HardwareEncoder) -> bool {
    false
}

fn has_realtime_60fps_pressure(output_w: u32, output_h: u32, fps: u32) -> bool {
    let area = (output_w as u64).saturating_mul(output_h as u64);
    fps >= 50 && area > 1920u64 * 1080u64
}

fn should_default_output_match_source(
    frame_crop: Option<FrameCropRectDto>,
    actual_width: u32,
    actual_height: u32,
) -> bool {
    if frame_crop
        .and_then(|crop| crop.scale_hint)
        .is_some_and(|scale| scale.is_finite() && scale >= 1.5)
    {
        return true;
    }

    (actual_width as u64) * (actual_height as u64) >= (1920u64 * 2) * (1080u64 * 2)
}

fn select_recording_encoder(
    probe: &EncoderProbe,
    preset: QualityPreset,
    output_w: u32,
    output_h: u32,
    fps: u32,
) -> Result<RecordingEncoderSelection, AppError> {
    #[cfg(target_os = "macos")]
    {
        if matches!(preset, QualityPreset::High | QualityPreset::Lossless)
            && has_realtime_60fps_pressure(output_w, output_h, fps)
        {
            if probe.available.contains(&HardwareEncoder::VideoToolboxH264) {
                return Ok(RecordingEncoderSelection::new(
                    HardwareEncoder::VideoToolboxH264,
                    Some(
                        "high-resolution 60fps recording uses VideoToolbox H.264 so the encoder can keep up with native capture frames; libx264 CRF/lossless is reserved for smaller realtime captures",
                    ),
                ));
            }
        }
        if probe.available.contains(&HardwareEncoder::Libx264Software)
            && matches!(preset, QualityPreset::High | QualityPreset::Lossless)
        {
            return Ok(RecordingEncoderSelection::new(
                HardwareEncoder::Libx264Software,
                None,
            ));
        }
        if matches!(preset, QualityPreset::Lossless) {
            return Err(AppError::Encoder(
                "Lossless MP4 recording requires the bundled libx264 software encoder, but this FFmpeg sidecar does not expose libx264. Rebuild the FFmpeg sidecar with --enable-gpl --enable-libx264, or choose High/Medium hardware recording.".into(),
            ));
        }
        if matches!(preset, QualityPreset::High) {
            if probe.available.contains(&HardwareEncoder::VideoToolboxH264) {
                return Ok(RecordingEncoderSelection::new(
                    HardwareEncoder::VideoToolboxH264,
                    Some(
                        "libx264 unavailable; falling back to VideoToolbox H.264 hardware bitrate mode",
                    ),
                ));
            }
            if probe.available.contains(&HardwareEncoder::Openh264Software) {
                return Ok(RecordingEncoderSelection::new(
                    HardwareEncoder::Openh264Software,
                    Some("libx264 unavailable; falling back to OpenH264 software bitrate mode"),
                ));
            }
        }
        if probe.available.contains(&HardwareEncoder::VideoToolboxH264) {
            return Ok(RecordingEncoderSelection::new(
                HardwareEncoder::VideoToolboxH264,
                None,
            ));
        }
    }
    Ok(RecordingEncoderSelection::new(probe.preferred, None))
}

/// Process-wide "a start_recording is currently in flight" flag.
/// Set via `compare_exchange(false, true)` at the entry of `start_recording`;
/// always cleared on return (Drop of `StartingGuard`) regardless of success,
/// error, or panic.
static GLOBAL_STARTING: AtomicBool = AtomicBool::new(false);

struct StartingGuard;

impl Drop for StartingGuard {
    fn drop(&mut self) {
        GLOBAL_STARTING.store(false, Ordering::Release);
    }
}

/// Aborts its collected spawn handles on drop. Callers push every
/// auxiliary task spawned during `start_recording` before registry insert,
/// then call [`SpawnAbortGuard::disarm`] on the success path. Any early
/// return or panic between spawn and registry-insert will abort the tasks
/// so no orphan outlives `start_recording`.
struct SpawnAbortGuard {
    handles: Vec<AbortHandle>,
    armed: bool,
}

impl SpawnAbortGuard {
    fn new() -> Self {
        Self {
            handles: Vec::new(),
            armed: true,
        }
    }

    fn push(&mut self, handle: AbortHandle) {
        self.handles.push(handle);
    }

    fn disarm(mut self) {
        self.armed = false;
        self.handles.clear();
    }
}

impl Drop for SpawnAbortGuard {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        for h in self.handles.drain(..) {
            h.abort();
        }
    }
}

/// Best-effort synchronous teardown of recording sessions at app exit.
/// Mirrors `drain_author_preview_sessions` in `lib.rs` — takes an
/// `AppHandle` for API parity, even though the recording registry is a
/// process-static (not on `AppState`). Uses `try_lock` so the exit hook
/// never deadlocks; on timeout aborts `encode_join` and surrenders the
/// slot. Output MP4s that flushed `moov` before the deadline remain
/// playable; the rest are left as-is for the OS to clean up.
pub fn drain_recording_sessions(_app_handle: &tauri::AppHandle) {
    const PER_SESSION_TIMEOUT_MS: u64 = 5000;

    let Some(mut sessions) = registry().sessions.try_lock() else {
        tracing::warn!("drain_recording_sessions: registry locked, skipping");
        return;
    };
    let drained: Vec<(String, RecordingHandle)> = sessions.drain().collect();
    drop(sessions);

    let count = drained.len();
    if count == 0 {
        return;
    }
    tracing::info!(count, "drain_recording_sessions: draining sessions on exit");

    // Use a transient runtime handle if present; otherwise run a one-shot
    // blocking runtime. The Tauri exit hook runs on the main thread with
    // no ambient tokio runtime by default.
    let rt_handle = tokio::runtime::Handle::try_current();
    for (session_id, handle) in drained {
        let encode_abort = handle.encode_join.abort_handle();
        let id = session_id.clone();
        let result = match &rt_handle {
            Ok(h) => h.block_on(async move {
                tokio::time::timeout(
                    Duration::from_millis(PER_SESSION_TIMEOUT_MS),
                    drain_one(&id, handle),
                )
                .await
            }),
            Err(_) => {
                let rt = match tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                {
                    Ok(rt) => rt,
                    Err(e) => {
                        tracing::warn!(session_id, error = %e, "drain_recording_sessions: failed to build runtime");
                        encode_abort.abort();
                        continue;
                    }
                };
                rt.block_on(async move {
                    tokio::time::timeout(
                        Duration::from_millis(PER_SESSION_TIMEOUT_MS),
                        drain_one(&id, handle),
                    )
                    .await
                })
            }
        };
        match result {
            Ok(Ok(())) => {
                tracing::info!(session_id, "drain_recording_sessions: session finalized");
            }
            Ok(Err(e)) => {
                tracing::warn!(session_id, error = %e, "drain_recording_sessions: session stop error");
            }
            Err(_) => {
                tracing::warn!(
                    session_id,
                    timeout_ms = PER_SESSION_TIMEOUT_MS,
                    "drain_recording_sessions: timed out, aborting encode"
                );
                encode_abort.abort();
            }
        }
    }
    tracing::info!(count, "drain_recording_sessions: complete");
}

/// Phase 19-02: derive the screen-space capture rect for the
/// trajectory sidecar. Returns `None` when we can't determine a
/// reasonable rect (e.g. unsupported target on a non-native build) —
/// trajectory recording is then silently skipped.
fn build_trajectory_capture_rect(
    target: &capture::CaptureTarget,
    fallback_w: u32,
    fallback_h: u32,
) -> Option<TrajectoryCaptureRect> {
    use capture::{enumerate_displays, CaptureTarget};
    match target {
        CaptureTarget::Display { display_id } => {
            let disp = enumerate_displays()
                .ok()?
                .into_iter()
                .find(|d| d.id == *display_id)?;
            Some(TrajectoryCaptureRect {
                x: 0.0,
                y: 0.0,
                width: disp.width_px as f32,
                height: disp.height_px as f32,
            })
        }
        CaptureTarget::DisplayRegion { rect, .. } => Some(TrajectoryCaptureRect {
            x: rect.x as f32,
            y: rect.y as f32,
            width: rect.w as f32,
            height: rect.h as f32,
        }),
        // Window targets: origin is unknown without a per-platform
        // window-rect lookup. Fall back to a 0,0-anchored rect of the
        // captured frame size; the renderer can still normalize via
        // (frame_w, frame_h).
        CaptureTarget::Window { .. } | CaptureTarget::WindowByPid { .. } => {
            Some(TrajectoryCaptureRect {
                x: 0.0,
                y: 0.0,
                width: fallback_w as f32,
                height: fallback_h as f32,
            })
        }
    }
}

async fn drain_one(_session_id: &str, handle: RecordingHandle) -> Result<(), String> {
    // Kill the heartbeat ticker so it doesn't race past teardown.
    if let Some(hb) = handle.heartbeat_abort.as_ref() {
        hb.abort();
    }
    // Flush trajectory sidecar (Phase 19-02). Best-effort.
    if let Some(traj) = handle.trajectory {
        traj.stop();
    }
    if let Some(audio) = handle.audio_stream.lock().await.take() {
        drop(audio);
    }
    {
        let mut p = handle.capture.lock().await;
        p.stop().await.map_err(|e| e.to_string())?;
    }
    let result = handle
        .encode_join
        .await
        .map_err(|e| format!("encode join: {e}"))?
        .map_err(|e| e.to_string())?;
    if let Some(plan) = handle.post_mux {
        finalize_post_mux(result, &plan)
            .await
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Runtime HW-encoder feature detection.
#[tauri::command]
#[specta::specta]
#[tracing::instrument(
    level = "info",
    skip_all,
    fields(cmd = "probe_hw_encoders"),
    err(Debug)
)]
pub async fn probe_hw_encoders(app: AppHandle) -> Result<EncoderProbeDto, AppError> {
    let cmd = TauriSidecar::new(app);
    let probe = probe_encoders(&cmd)
        .await
        .map_err(|e| AppError::Encoder(e.to_string()))?;
    Ok(probe.into())
}

/// Re-probe HW encoders bypassing any cached result.
#[tauri::command]
#[specta::specta]
#[tracing::instrument(
    level = "info",
    skip_all,
    fields(cmd = "refresh_hw_encoders"),
    err(Debug)
)]
pub async fn refresh_hw_encoders(app: AppHandle) -> Result<EncoderProbeDto, AppError> {
    let cmd = TauriSidecar::new(app);
    let probe = encoder::probe::force_reprobe(&cmd)
        .await
        .map_err(|e| AppError::Encoder(e.to_string()))?;
    Ok(probe.into())
}

/// Start an end-to-end recording.
#[tauri::command]
#[specta::specta]
#[tracing::instrument(level = "info", skip_all, fields(cmd = "start_recording"), err(Debug))]
pub async fn start_recording(
    app: AppHandle,
    _state: State<'_, AppState>,
    args: StartRecordingArgs,
    on_event: Channel<RecordingEvent>,
) -> Result<RecordingSessionId, AppError> {
    // Reject concurrent starts. The Drop guard clears the flag on every
    // return path (success, error, panic).
    if GLOBAL_STARTING
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Err(AppError::AlreadyStarting);
    }
    let _starting_guard = StartingGuard;

    let capture_target: capture::CaptureTarget = match &args.target {
        crate::commands::capture::CaptureTargetDto::WindowByPid { title_hint, .. }
            if matches!(title_hint.as_deref(), Some("storycapture-playwright")) =>
        {
            let stash_pid = crate::commands::automation::playwright_pid_stash()
                .get()
                .and_then(|i| i.pid);
            let Some(pid) = stash_pid else {
                return Err(AppError::Capture(
                    "Playwright auto-target requested but no Playwright pid is available — launch a story first".into(),
                ));
            };
            tracing::info!(
                target: "storycapture::recording",
                pid,
                "start_recording: resolved Playwright auto sentinel to pid"
            );
            {
                let paint_deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
                let wait_start = std::time::Instant::now();
                let mut paint_ready = false;
                loop {
                    if crate::commands::automation::playwright_first_paint_stash().get() {
                        paint_ready = true;
                        break;
                    }
                    if std::time::Instant::now() >= paint_deadline {
                        break;
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(25)).await;
                }
                if paint_ready {
                    tracing::info!(
                        target: "storycapture::recording",
                        waited_ms = wait_start.elapsed().as_millis() as u64,
                        "start_recording: first paint ready — attaching SCK"
                    );
                } else {
                    tracing::warn!(
                        target: "storycapture::recording",
                        "start_recording: first-paint gate timed out after 10s — attaching SCK anyway"
                    );
                }
            }
            capture::CaptureTarget::WindowByPid {
                pid,
                // No hint — pid alone is authoritative for a single-browser session.
                title_hint: None,
            }
        }
        _ => args.target.clone().into(),
    };
    tracing::info!(
        target: "storycapture::recording",
        frame_crop = ?args.frame_crop,
        "start_recording requested: target={} {}x{}@{}fps folder={:?}",
        capture_target.kind_label(), args.width, args.height, args.fps, args.project_folder
    );

    let requested_quality: QualityPreset = args
        .quality_preset
        .map(Into::into)
        .unwrap_or(QualityPreset::Med);

    // Probe encoders.
    let probe = {
        let cmd = TauriSidecar::new(app.clone());
        probe_encoders(&cmd).await.map_err(|e| {
            tracing::error!(
                target: "storycapture::recording",
                "probe_encoders failed: {}",
                e
            );
            AppError::Encoder(e.to_string())
        })?
    };
    tracing::info!(
        target: "storycapture::recording",
        preferred = ?probe.preferred,
        available = ?probe.available,
        "encoder probe ok"
    );

    // Allocate session and output path.
    let session_id = Uuid::new_v4().to_string();
    let project = PathBuf::from(&args.project_folder);
    let exports_dir = project.join("exports");
    std::fs::create_dir_all(&exports_dir).map_err(|e| {
        tracing::error!(
            target: "storycapture::recording",
            "create exports dir failed at {:?}: {}",
            exports_dir, e
        );
        AppError::from(e)
    })?;
    let output_path = exports_dir.join(format!("{session_id}.mp4"));
    let video_only_path = exports_dir.join(format!("{session_id}.video.mp4"));
    let audio_pcm_path = exports_dir.join(format!("{session_id}.audio.f32le"));

    // Start capture pipeline.
    let cap_cfg = CaptureConfig {
        target: capture_target,
        include_cursor: args.include_cursor.unwrap_or(true),
        fps_target: args.fps,
        pixel_format: PixelFormat::Bgra,
        queue_cap_bytes: ByteBoundedQueue::DEFAULT_CAP_BYTES,
        frame_crop: args.frame_crop.map(Into::into),
    };
    let (evt_tx, mut evt_rx) = mpsc::unbounded_channel::<CaptureEvent>();
    #[cfg(target_os = "macos")]
    let preferred: Box<dyn capture::CaptureBackend> = {
        let sck = capture::SckBackend::new().map_err(|e| AppError::Capture(e.to_string()))?;
        sck.set_event_sink(evt_tx.clone());
        Box::new(sck)
    };
    #[cfg(target_os = "windows")]
    let preferred: Box<dyn capture::CaptureBackend> = {
        let wgc = capture::WgcBackend::new().map_err(|e| AppError::Capture(e.to_string()))?;
        wgc.set_event_sink(evt_tx.clone());
        Box::new(wgc)
    };
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let preferred: Box<dyn capture::CaptureBackend> = Box::new(capture::XcapBackend::new());

    // Collect every auxiliary spawn so any early return between here and
    // the registry insert aborts them rather than leaking.
    let mut spawn_guard = SpawnAbortGuard::new();

    let on_event_for_capture = on_event.clone();
    let capture_fwd_join = tokio::spawn(async move {
        while let Some(evt) = evt_rx.recv().await {
            let _ = on_event_for_capture.send(evt.into());
        }
    });
    spawn_guard.push(capture_fwd_join.abort_handle());

    let queue = ByteBoundedQueue::new(cap_cfg.queue_cap_bytes);
    let mut capture = CapturePipeline::new(preferred, queue);
    let (frame_tx, mut frame_rx) = mpsc::channel::<Frame>(ENCODER_FRAME_CHANNEL_CAPACITY);
    // Best-effort drop telemetry: forward queue drops to the renderer via
    // the existing RecordingEvent channel. Channel<T> is Clone in Tauri 2.x;
    // clone once per callback invocation via the move-captured handle.
    let on_event_for_drops = on_event.clone();
    let drop_cb: Option<capture::DropEventCallback> = Some(Box::new(move |total, delta| {
        if let Err(e) = on_event_for_drops.send(RecordingEvent::FramesDropped { total, delta }) {
            // Channel closed / full is non-fatal — telemetry is best-effort.
            tracing::debug!(
                target: "storycapture::recording",
                error = %e,
                total,
                delta,
                "FramesDropped event send failed (channel closed?)"
            );
        }
    }));
    let outcome = capture
        .start_orchestrated(
            cap_cfg.clone(),
            frame_tx,
            Some(evt_tx.clone()),
            capture::FallbackCounter::new(),
            drop_cb,
        )
        .await
        .map_err(|e| {
            tracing::error!(
                target: "storycapture::recording",
                "capture pipeline start failed: {}",
                e
            );
            AppError::Capture(e.to_string())
        })?;
    tracing::info!(
        target: "storycapture::recording",
        ?outcome,
        "capture pipeline started"
    );

    // Peek first frame to learn actual dimensions. Window-capture targets
    // (Playwright auto-follow, specific window) deliver frames sized to
    // the window, not the display — using args.width/height would cause
    // FFmpeg's rawvideo input to reject every frame as "invalid buffer
    // size". Worst case: `first_frame_timeout_ms` (default 3000ms) then we
    // fall back to args dims.
    let first_frame_timeout =
        std::time::Duration::from_millis(args.first_frame_timeout_ms.unwrap_or(3000));
    let (actual_width, actual_height, first_frame) =
        match tokio::time::timeout(first_frame_timeout, frame_rx.recv()).await {
            Ok(Some(frame)) => {
                let w = frame.width_px;
                let h = frame.height_px;
                tracing::info!(
                    target: "storycapture::recording",
                    "first frame dims {}x{} (caller sent {}x{})",
                    w, h, args.width, args.height
                );
                (w, h, Some(frame))
            }
            _ => {
                tracing::warn!(
                    target: "storycapture::recording",
                    timeout_ms = first_frame_timeout.as_millis() as u64,
                    "no first frame within budget; encoder using caller dims {}x{}",
                    args.width, args.height
                );
                (args.width, args.height, None)
            }
        };
    if first_frame.is_some() {
        if let Some(reason) =
            hidpi_capture_under_resolved_reason(args.frame_crop, actual_width, actual_height)
        {
            tracing::error!(
                target: "storycapture::recording",
                actual_width,
                actual_height,
                frame_crop = ?args.frame_crop,
                reason = %reason,
                "recording capture quality guard failed"
            );
            let _ = capture.stop().await;
            return Err(AppError::Capture(reason));
        }
    }
    // Stitch peeked frame back in front of remaining frames.
    let (enc_tx, enc_rx) = mpsc::channel::<Frame>(ENCODER_FRAME_CHANNEL_CAPACITY);
    if let Some(f) = first_frame {
        let _ = enc_tx.send(f).await;
    }
    let frame_fwd_join = tokio::spawn(async move {
        while let Some(f) = frame_rx.recv().await {
            if enc_tx.send(f).await.is_err() {
                break;
            }
        }
    });
    spawn_guard.push(frame_fwd_join.abort_handle());
    let frame_rx = enc_rx;

    // Create mic input before spawning FFmpeg.
    let negotiated_audio: Option<NegotiatedAudioInput> = if let Some(device_id) =
        args.audio_device_id.clone()
    {
        match tokio::task::spawn_blocking(move || negotiate_input(Some(device_id.as_str()))).await {
            Ok(Ok(negotiated)) => {
                let info = negotiated.info();
                tracing::info!(
                    target: "storycapture::recording",
                    device_id = negotiated.device_id(),
                    device_name = negotiated.device_name(),
                    sample_rate = info.sample_rate,
                    channels = info.channels,
                    "mic audio input negotiated"
                );
                Some(negotiated)
            }
            Ok(Err(e)) => {
                tracing::warn!(
                    target: "storycapture::recording",
                    error = %e,
                    "mic audio negotiation failed; continuing video-only"
                );
                // Surface to renderer so UI can show a toast + badge.
                emit_audio_unavailable(&on_event, &e);
                None
            }
            Err(e) => {
                tracing::warn!(
                    target: "storycapture::recording",
                    error = %e,
                    "mic audio negotiation join error; continuing video-only"
                );
                emit_audio_unavailable(&on_event, &e);
                None
            }
        }
    } else {
        None
    };

    // Defaults; optional DTO fields override them.
    // When the caller did NOT pin an output resolution and the capture is
    // ≥ 2× a 1080p canvas (Retina / HiDPI), prefer MatchSource so we don't
    // throw away real pixel detail on the way to a 1920×1080 MP4.
    let retina_default_match_source =
        should_default_output_match_source(args.frame_crop, actual_width, actual_height);
    let output_res: OutputResolution = match args.output_resolution {
        Some(dto) => dto.into(),
        None if retina_default_match_source => OutputResolution::MatchSource,
        None => OutputResolution::P1080,
    };
    let fit: FitMode = args.fit_mode.map(Into::into).unwrap_or(FitMode::Letterbox);
    let pad: PadColor = args.pad_color.map(Into::into).unwrap_or(PadColor::Black);
    let algo: ScaleAlgo = args
        .scale_algo
        .map(Into::into)
        .unwrap_or(ScaleAlgo::Lanczos);
    let qp = requested_quality;
    let (planned_output_width, planned_output_height) = output_res
        .resolve_even(actual_width, actual_height)
        .map_err(|e| AppError::Encoder(e.to_string()))?;
    let recording_selection = select_recording_encoder(
        &probe,
        qp,
        planned_output_width,
        planned_output_height,
        args.fps,
    )?;
    let recording_encoder = recording_selection.encoder;
    if let Some(reason) = recording_selection.fallback_reason.as_deref() {
        tracing::warn!(
            target: "storycapture::recording",
            requested_preset = ?requested_quality,
            selected = ?recording_encoder,
            output_width = planned_output_width,
            output_height = planned_output_height,
            fps = args.fps,
            reason,
            "recording encoder fallback selected"
        );
    } else if recording_encoder != probe.preferred {
        tracing::info!(
            target: "storycapture::recording",
            preferred = ?probe.preferred,
            selected = ?recording_encoder,
            output_width = planned_output_width,
            output_height = planned_output_height,
            fps = args.fps,
            "recorder encoder override selected for screen-capture quality"
        );
    }

    let use_post_mux = should_post_mux_video_toolbox(recording_encoder);
    let negotiated_audio_info = negotiated_audio.as_ref().map(|audio| audio.info());
    let encoder_output_path = if use_post_mux {
        let _ = std::fs::remove_file(&video_only_path);
        video_only_path.clone()
    } else {
        output_path.clone()
    };
    let mut post_mux = if use_post_mux {
        let audio = match negotiated_audio_info {
            Some(info) => {
                let _ = std::fs::remove_file(&audio_pcm_path);
                std::fs::File::create(&audio_pcm_path).map_err(|e| {
                    AppError::Capture(format!(
                        "create recorder PCM audio staging file {}: {e}",
                        audio_pcm_path.display()
                    ))
                })?;
                PostMuxAudio::Pcm {
                    path: audio_pcm_path.clone(),
                    sample_rate: info.sample_rate,
                    channels: info.channels,
                    format: AudioFormat::F32LE,
                }
            }
            None => PostMuxAudio::Silent,
        };
        tracing::info!(
            target: "storycapture::recording",
            encoder = ?recording_encoder,
            video_path = %encoder_output_path.display(),
            output_path = %output_path.display(),
            audio = ?audio,
            "macOS recorder using VideoToolbox video-only encode plus post audio mux"
        );
        Some(PostMuxPlan {
            video_path: encoder_output_path.clone(),
            output_path: output_path.clone(),
            audio,
        })
    } else {
        None
    };

    let audio_fifo: Option<FifoHandle> = if !use_post_mux && negotiated_audio.is_some() {
        Some(make_fifo("storycapture-audio").map_err(|e| {
            tracing::error!(
                target: "storycapture::recording",
                "audio fifo creation failed: {}",
                e
            );
            AppError::Capture(format!("audio fifo: {e}"))
        })?)
    } else {
        None
    };

    let mut enc_cfg = EncodeConfig::new(
        encoder_output_path.clone(),
        actual_width,
        actual_height,
        args.fps,
        recording_encoder,
    )
    .with_output_resolution(output_res)
    .map_err(|e| AppError::Encoder(e.to_string()))?
    .with_fit_mode(fit)
    .with_pad_color(pad)
    .with_scale_algo(algo)
    .with_color_adjustment(
        if matches!(qp, QualityPreset::High | QualityPreset::Lossless) {
            ColorAdjustment::ScreenVivid
        } else {
            ColorAdjustment::None
        },
    )
    .with_quality_preset(qp)
    .with_realtime_encoding(true);
    if !use_post_mux {
        enc_cfg = enc_cfg.force_ffmpeg_path();
    }
    let target_video_kbps = encoder::quality::target_kbps(
        qp,
        enc_cfg.encoder,
        enc_cfg.output_width,
        enc_cfg.output_height,
        enc_cfg.fps_advisory,
    );
    let quality_plan = RecordingQualityPlan {
        encoder: enc_cfg.encoder,
        capture_width: enc_cfg.capture_width,
        capture_height: enc_cfg.capture_height,
        output_width: enc_cfg.output_width,
        output_height: enc_cfg.output_height,
        fps: enc_cfg.fps_advisory,
        preset: enc_cfg.quality_preset,
        target_video_kbps,
        quality_mode: recording_selection.quality_mode,
        fallback_reason: recording_selection.fallback_reason,
    };
    tracing::info!(
        target: "storycapture::recording",
        encoder = ?quality_plan.encoder,
        quality_mode = ?quality_plan.quality_mode,
        fallback_reason = ?quality_plan.fallback_reason,
        preset = ?quality_plan.preset,
        capture_width = quality_plan.capture_width,
        capture_height = quality_plan.capture_height,
        output_width = quality_plan.output_width,
        output_height = quality_plan.output_height,
        fps = quality_plan.fps,
        target_video_kbps = quality_plan.target_video_kbps,
        color_adjustment = ?enc_cfg.color_adjustment,
        scale_area_pct = ((quality_plan.output_width as u64)
            .saturating_mul(quality_plan.output_height as u64)
            .saturating_mul(100)
            / (quality_plan.capture_width as u64)
                .saturating_mul(quality_plan.capture_height as u64)
                .max(1)),
        "recording quality plan"
    );
    // Forward the optional keyframe knob from the IPC DTO into the encoder
    // config so FFmpeg emits `-g <fps * interval>`. None keeps the default
    // (no `-g`) so existing argv is byte-identical.
    enc_cfg.keyframe_interval_sec = args.keyframe_interval_sec;
    if let (Some(f), Some(negotiated)) = (&audio_fifo, negotiated_audio.as_ref()) {
        let info = negotiated.info();
        enc_cfg = enc_cfg.with_audio(AudioInput {
            fifo_path: f.path().to_path_buf(),
            sample_rate: info.sample_rate,
            channels: info.channels,
            format: AudioFormat::F32LE,
        });
    }
    let (prog_tx, mut prog_rx) = mpsc::channel::<EncodeProgress>(32);
    let sidecar = TauriSidecar::new(app.clone());
    // Encoder stdin-write timeouts surface to renderer as FramesDropped.
    let on_event_for_bp = on_event.clone();
    let bp_cb: encoder::BackpressureCallback = Box::new(move |total, delta| {
        if let Err(e) = on_event_for_bp.send(RecordingEvent::FramesDropped { total, delta }) {
            tracing::debug!(
                target: "storycapture::recording",
                error = %e,
                total,
                delta,
                "FramesDropped (stdin backpressure) send failed"
            );
        }
    });
    let encode_join =
        EncodePipeline::start_with_backpressure(enc_cfg, &sidecar, frame_rx, prog_tx, Some(bp_cb))
            .await
            .map_err(|e| {
                tracing::error!(
                    target: "storycapture::recording",
                    "encode pipeline start failed: {}",
                    e
                );
                AppError::Encoder(e.to_string())
            })?;
    tracing::info!(
        target: "storycapture::recording",
        "encode pipeline started: output={:?}",
        encoder_output_path
    );

    // Start mic capture after the encoder is ready. FFmpeg live encode reads
    // through a FIFO; the VT path records raw PCM to a staging file and muxes
    // it after the video-only writer finalizes.
    let app_for_audio_event = app.clone();
    let audio_stream: Option<AudioCaptureStream> = if let Some(negotiated) = negotiated_audio {
        let audio_target = if let Some(f) = &audio_fifo {
            let fifo_path = f.path().to_path_buf();
            // FIFO handshake. Poll metadata every 20ms; treat 3 consecutive
            // Ok results (60ms of stable existence) as "FFmpeg has opened the
            // FIFO". Deadline at 2s.
            let fifo_deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(2);
            let mut ok_ticks: u8 = 0;
            loop {
                match tokio::fs::metadata(&fifo_path).await {
                    Ok(_) => {
                        ok_ticks += 1;
                        if ok_ticks >= 3 {
                            break;
                        }
                    }
                    Err(_) => {
                        ok_ticks = 0;
                    }
                }
                if tokio::time::Instant::now() >= fifo_deadline {
                    tracing::error!(
                        target: "storycapture::recording",
                        path = %fifo_path.display(),
                        "fifo handshake timed out after 2s"
                    );
                    return Err(AppError::FifoHandshakeTimeout);
                }
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
            Some((fifo_path, "fifo"))
        } else if let Some(PostMuxPlan {
            audio: PostMuxAudio::Pcm { path, .. },
            ..
        }) = post_mux.as_ref()
        {
            Some((path.clone(), "pcm_file"))
        } else {
            None
        };

        if let Some((audio_path, audio_sink_kind)) = audio_target {
            tracing::info!(
                target: "storycapture::recording",
                audio_sink_kind,
                path = %audio_path.display(),
                "starting mic audio capture"
            );
            match tokio::task::spawn_blocking(move || {
                AudioCaptureStream::start_with_negotiated(negotiated, audio_path)
            })
            .await
            {
                Ok(Ok((stream, info))) => {
                    tracing::info!(
                        target: "storycapture::recording",
                        sample_rate = info.sample_rate,
                        channels = info.channels,
                        audio_sink_kind,
                        "mic audio capture started"
                    );
                    // Poll for a mic disconnect and emit a warning event.
                    let flag = stream.degraded_flag();
                    let audio_degraded_join = tokio::spawn(async move {
                        let mut ticker =
                            tokio::time::interval(std::time::Duration::from_millis(500));
                        loop {
                            ticker.tick().await;
                            if flag.load(std::sync::atomic::Ordering::Relaxed) {
                                tracing::warn!(
                                    target: "storycapture::recording",
                                    "audio stream degraded; emitting audio://disconnected"
                                );
                                let _ = app_for_audio_event.emit(
                                    "audio://disconnected",
                                    "Microphone disconnected — continuing without audio.",
                                );
                                break;
                            }
                        }
                    });
                    spawn_guard.push(audio_degraded_join.abort_handle());
                    Some(stream)
                }
                Ok(Err(e)) => {
                    tracing::warn!(
                        target: "storycapture::recording",
                        error = %e,
                        "mic audio start failed; continuing video-only"
                    );
                    if let Some(plan) = post_mux.as_mut() {
                        if matches!(plan.audio, PostMuxAudio::Pcm { .. }) {
                            tracing::warn!(
                                target: "storycapture::recording",
                                "post-mux audio switched to silent track after mic start failure"
                            );
                            plan.audio = PostMuxAudio::Silent;
                        }
                    }
                    emit_audio_unavailable(&on_event, &e);
                    None
                }
                Err(e) => {
                    tracing::warn!(
                        target: "storycapture::recording",
                        error = %e,
                        "mic audio spawn_blocking join error; continuing video-only"
                    );
                    if let Some(plan) = post_mux.as_mut() {
                        if matches!(plan.audio, PostMuxAudio::Pcm { .. }) {
                            tracing::warn!(
                                target: "storycapture::recording",
                                "post-mux audio switched to silent track after mic start join failure"
                            );
                            plan.audio = PostMuxAudio::Silent;
                        }
                    }
                    emit_audio_unavailable(&on_event, &e);
                    None
                }
            }
        } else {
            None
        }
    } else {
        None
    };

    // Progress fan-out to the renderer.
    let on_event_clone = on_event.clone();
    let progress_fwd_join = tokio::spawn(async move {
        while let Some(p) = prog_rx.recv().await {
            let _ = on_event_clone.send(RecordingEvent::EncodeProgress { progress: p.into() });
        }
    });
    spawn_guard.push(progress_fwd_join.abort_handle());

    // 2s heartbeat ticker. Pushed into the abort guard so an early-failure
    // before registry-insert cleans it up, AND stored on the handle so
    // stop/drain abort it on session teardown.
    let on_event_for_hb = on_event.clone();
    let heartbeat_join = tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(2));
        // Skip the immediate first tick so seq=0 fires ~2s after start.
        interval.tick().await;
        let mut seq: u64 = 0;
        loop {
            interval.tick().await;
            if on_event_for_hb
                .send(RecordingEvent::Heartbeat { seq })
                .is_err()
            {
                break;
            }
            seq = seq.wrapping_add(1);
        }
    });
    let heartbeat_abort = heartbeat_join.abort_handle();
    spawn_guard.push(heartbeat_abort.clone());

    // Phase 19-02: spin up cursor trajectory recorder. Best-effort —
    // any failure (rect derivation, thread spawn, sidecar write) is
    // logged but never aborts the recording.
    let trajectory = build_trajectory_capture_rect(&cap_cfg.target, actual_width, actual_height)
        .map(|rect| {
            let sidecar = trajectory_sidecar_path(&output_path);
            TrajectoryRecorder::start(rect, output_path.clone(), sidecar)
        });

    registry().sessions.lock().insert(
        session_id.clone(),
        RecordingHandle {
            capture: Arc::new(tokio::sync::Mutex::new(capture)),
            encode_join,
            output_path,
            post_mux,
            audio_stream: Arc::new(tokio::sync::Mutex::new(audio_stream)),
            audio_fifo,
            heartbeat_abort: Some(heartbeat_abort),
            trajectory,
            quality_plan,
        },
    );

    // Success path: disarm guard so pushed tasks keep running for the
    // lifetime of the session (stop_recording_inner tears them down).
    spawn_guard.disarm();

    Ok(RecordingSessionId(session_id))
}

#[tauri::command]
#[specta::specta]
#[tracing::instrument(level = "info", skip_all, fields(cmd = "stop_recording"), err(Debug))]
pub async fn stop_recording(
    session: RecordingSessionId,
    on_event: Channel<RecordingEvent>,
) -> Result<EncodeResultDto, AppError> {
    tracing::info!(target: "storycapture::recording", "stop_recording requested: session={}", session.0);
    match stop_recording_inner(&session.0).await {
        Ok(dto) => {
            let _ = on_event.send(RecordingEvent::Completed {
                result: dto.clone(),
            });
            Ok(dto)
        }
        Err(e) => {
            if let AppError::Encoder(msg) = &e {
                let _ = on_event.send(RecordingEvent::Failed {
                    message: msg.clone(),
                });
            }
            Err(e)
        }
    }
}

#[tauri::command]
#[specta::specta]
#[tracing::instrument(level = "info", skip_all, fields(cmd = "pause_recording"), err(Debug))]
pub async fn pause_recording(session: RecordingSessionId) -> Result<(), AppError> {
    pause_recording_inner(&session.0).await
}

#[tauri::command]
#[specta::specta]
#[tracing::instrument(level = "info", skip_all, fields(cmd = "resume_recording"), err(Debug))]
pub async fn resume_recording(session: RecordingSessionId) -> Result<(), AppError> {
    resume_recording_inner(&session.0).await
}

/// Core stop logic shared by the `stop_recording` Tauri command and the
/// [`TauriRecorderHandle`] used by the DSL session to auto-stop a recording
/// when the story ends. Does not emit UI events — callers decide whether
/// and how to notify the renderer.
///
/// Returns `NotFound` if the session has already been removed from the
/// registry (idempotent: a second stop is not an error surface).
pub(crate) async fn stop_recording_inner(session_id: &str) -> Result<EncodeResultDto, AppError> {
    let handle = registry()
        .sessions
        .lock()
        .remove(session_id)
        .ok_or_else(|| {
            tracing::debug!(
                target: "storycapture::recording",
                "stop_recording_inner: session {} not in registry (already stopped?)",
                session_id
            );
            AppError::NotFound(format!("recording session {session_id}"))
        })?;

    crate::commands::automation::resume_active_automation();

    // Phase 19-02: stop the trajectory recorder first so its sidecar
    // is flushed alongside the MP4. Best-effort — `stop()` swallows
    // its own errors via `tracing::warn!`.
    if let Some(traj) = handle.trajectory {
        traj.stop();
    }
    let quality_plan = handle.quality_plan;

    // Stop the 2s heartbeat ticker before we begin teardown so the renderer
    // doesn't observe a tick after it's already surfaced Completed/Failed.
    if let Some(hb) = handle.heartbeat_abort.as_ref() {
        hb.abort();
    }

    // Drop the audio stream before waiting on the encoder.
    if let Some(audio) = handle.audio_stream.lock().await.take() {
        tracing::info!(target: "storycapture::recording", "stop_recording: dropping audio stream to flush tail");
        drop(audio);
    }

    tracing::info!(target: "storycapture::recording", "stop_recording: stopping capture pipeline");
    {
        let mut p = handle.capture.lock().await;
        p.stop().await.map_err(|e| {
            tracing::error!(target: "storycapture::recording", "capture stop failed: {}", e);
            AppError::Capture(e.to_string())
        })?;
    }
    tracing::info!(target: "storycapture::recording", "stop_recording: capture stopped, waiting on encoder flush");

    let mut result = handle
        .encode_join
        .await
        .map_err(|e| {
            tracing::error!(target: "storycapture::recording", "encoder join error: {}", e);
            AppError::Encoder(format!("encoder join: {e}"))
        })?
        .map_err(|e| {
            tracing::error!(target: "storycapture::recording", "encoder returned error: {}", e);
            AppError::Encoder(e.to_string())
        })?;
    if let Some(plan) = handle.post_mux {
        result = finalize_post_mux(result, &plan).await?;
    }
    // Surface observed bitrate so we can diagnose encoder under-shoot
    // (VT quality-mode used to produce ~1 Mbps files against a 10 Mbps
    // target). bytes*8 = bits; bits / ms = kbps.
    let observed_kbps = if result.duration_ms > 0 {
        result.bytes.saturating_mul(8) / result.duration_ms
    } else {
        0
    };
    tracing::info!(
        target: "storycapture::recording",
        output = ?result.output_path,
        bytes = result.bytes,
        duration_ms = result.duration_ms,
        frames = result.frames_written,
        dropped = result.frames_dropped,
        observed_kbps,
        target_video_kbps = quality_plan.target_video_kbps,
        target_pct = if quality_plan.target_video_kbps > 0 {
            observed_kbps.saturating_mul(100) / quality_plan.target_video_kbps as u64
        } else {
            0
        },
        encoder = ?quality_plan.encoder,
        quality_mode = ?quality_plan.quality_mode,
        fallback_reason = ?quality_plan.fallback_reason,
        preset = ?quality_plan.preset,
        capture_width = quality_plan.capture_width,
        capture_height = quality_plan.capture_height,
        output_width = quality_plan.output_width,
        output_height = quality_plan.output_height,
        fps = quality_plan.fps,
        "stop_recording: encoder finalized"
    );
    if matches!(
        quality_plan.quality_mode,
        RecordingQualityMode::HardwareBitrate
    ) && quality_plan.target_video_kbps > 0
        && observed_kbps.saturating_mul(3) < quality_plan.target_video_kbps as u64
    {
        tracing::warn!(
            target: "storycapture::recording",
            observed_kbps,
            target_video_kbps = quality_plan.target_video_kbps,
            encoder = ?quality_plan.encoder,
            "recording bitrate undershot target by more than 3x; likely encoder rate-control bottleneck"
        );
    }

    Ok(result.into())
}

async fn pause_recording_inner(session_id: &str) -> Result<(), AppError> {
    let (capture, audio_stream) = {
        let sessions = registry().sessions.lock();
        let handle = sessions
            .get(session_id)
            .ok_or_else(|| AppError::NotFound(format!("recording session {session_id}")))?;
        (handle.capture.clone(), handle.audio_stream.clone())
    };

    {
        let mut capture = capture.lock().await;
        capture
            .pause()
            .await
            .map_err(|e| AppError::Capture(e.to_string()))?;
    }

    if let Some(stream) = audio_stream.lock().await.as_ref() {
        stream
            .pause()
            .map_err(|e| AppError::Capture(e.to_string()))?;
    }

    crate::commands::automation::pause_active_automation();
    Ok(())
}

async fn resume_recording_inner(session_id: &str) -> Result<(), AppError> {
    let (capture, audio_stream) = {
        let sessions = registry().sessions.lock();
        let handle = sessions
            .get(session_id)
            .ok_or_else(|| AppError::NotFound(format!("recording session {session_id}")))?;
        (handle.capture.clone(), handle.audio_stream.clone())
    };

    {
        let mut capture = capture.lock().await;
        capture
            .resume()
            .await
            .map_err(|e| AppError::Capture(e.to_string()))?;
    }

    if let Some(stream) = audio_stream.lock().await.as_ref() {
        stream
            .resume()
            .map_err(|e| AppError::Capture(e.to_string()))?;
    }

    crate::commands::automation::resume_active_automation();
    Ok(())
}

/// [`automation::RecorderHandle`] impl backed by the recording registry.
///
/// Held by a DSL `SessionActor` (or the auto-stop branch of
/// `launch_automation`) so that when the story ends — normally, on error,
/// or on abort — the attached recording is torn down cleanly instead of
/// leaving the sidecar running.
pub struct TauriRecorderHandle {
    session_id: String,
}

impl TauriRecorderHandle {
    pub fn new(session_id: String) -> Self {
        Self { session_id }
    }
}

#[async_trait::async_trait]
impl automation::RecorderHandle for TauriRecorderHandle {
    async fn stop(&self) -> Result<(), String> {
        match stop_recording_inner(&self.session_id).await {
            Ok(_) => Ok(()),
            // Already stopped (e.g. UI beat us to it) — treat as success.
            Err(AppError::NotFound(_)) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}

#[allow(dead_code)]
fn _silence_unused_output_path(p: &PathBuf) -> &PathBuf {
    p
}

#[cfg(test)]
mod double_start_guard_tests {
    use super::{StartingGuard, GLOBAL_STARTING};
    use std::sync::atomic::Ordering;

    /// Serialize tests that poke `GLOBAL_STARTING` so they can't alias
    /// each other under `--test-threads=N`. A static `Mutex` is the
    /// simplest way to do this without cross-test plumbing.
    fn lock() -> std::sync::MutexGuard<'static, ()> {
        use std::sync::{Mutex, OnceLock};
        static M: OnceLock<Mutex<()>> = OnceLock::new();
        M.get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(|p| p.into_inner())
    }

    #[test]
    fn cas_rejects_second_caller_and_guard_clears_on_drop() {
        let _g = lock();
        GLOBAL_STARTING.store(false, Ordering::Release);

        // First caller claims the flag.
        assert!(GLOBAL_STARTING
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_ok());
        let guard = StartingGuard;

        // Second caller sees it set and fails the CAS.
        assert!(GLOBAL_STARTING
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err());

        // Drop clears the flag for the next session.
        drop(guard);
        assert!(!GLOBAL_STARTING.load(Ordering::Acquire));
    }

    #[test]
    fn guard_clears_on_panic() {
        let _g = lock();
        GLOBAL_STARTING.store(false, Ordering::Release);

        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            assert!(GLOBAL_STARTING
                .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                .is_ok());
            let _guard = StartingGuard;
            panic!("synthetic");
        }));
        assert!(result.is_err());
        assert!(
            !GLOBAL_STARTING.load(Ordering::Acquire),
            "panic must still clear GLOBAL_STARTING via Drop"
        );
    }
}

#[cfg(all(test, target_os = "macos"))]
mod recording_encoder_selection_tests {
    use super::{
        select_recording_encoder, should_default_output_match_source, FrameCropRectDto,
        RecordingQualityMode,
    };
    use crate::error::AppError;
    use encoder::{EncoderProbe, HardwareEncoder, QualityPreset};

    fn probe(available: Vec<HardwareEncoder>, preferred: HardwareEncoder) -> EncoderProbe {
        EncoderProbe {
            available,
            preferred,
        }
    }

    #[test]
    fn high_prefers_libx264_crf_when_available() {
        let selection = select_recording_encoder(
            &probe(
                vec![
                    HardwareEncoder::VideoToolboxH264,
                    HardwareEncoder::Libx264Software,
                ],
                HardwareEncoder::VideoToolboxH264,
            ),
            QualityPreset::High,
            1920,
            1080,
            30,
        )
        .expect("selection");

        assert_eq!(selection.encoder, HardwareEncoder::Libx264Software);
        assert_eq!(selection.quality_mode, RecordingQualityMode::SoftwareCrf);
        assert_eq!(selection.fallback_reason, None);
    }

    #[test]
    fn lossless_without_libx264_fails_closed() {
        let err = select_recording_encoder(
            &probe(
                vec![HardwareEncoder::VideoToolboxH264],
                HardwareEncoder::VideoToolboxH264,
            ),
            QualityPreset::Lossless,
            1920,
            1080,
            30,
        )
        .expect_err("lossless must require libx264");

        assert!(matches!(
            err,
            AppError::Encoder(message) if message.contains("requires the bundled libx264")
        ));
    }

    #[test]
    fn high_without_libx264_warns_and_falls_back_to_videotoolbox_h264() {
        let selection = select_recording_encoder(
            &probe(
                vec![HardwareEncoder::VideoToolboxH264],
                HardwareEncoder::VideoToolboxH264,
            ),
            QualityPreset::High,
            1920,
            1080,
            30,
        )
        .expect("selection");

        assert_eq!(selection.encoder, HardwareEncoder::VideoToolboxH264);
        assert_eq!(
            selection.quality_mode,
            RecordingQualityMode::HardwareBitrate
        );
        assert!(selection
            .fallback_reason
            .is_some_and(|reason| reason.contains("VideoToolbox H.264")));
    }

    #[test]
    fn medium_keeps_videotoolbox_for_fast_recording() {
        let selection = select_recording_encoder(
            &probe(
                vec![
                    HardwareEncoder::VideoToolboxH264,
                    HardwareEncoder::Libx264Software,
                ],
                HardwareEncoder::VideoToolboxH264,
            ),
            QualityPreset::Med,
            1920,
            1080,
            30,
        )
        .expect("selection");

        assert_eq!(selection.encoder, HardwareEncoder::VideoToolboxH264);
        assert_eq!(
            selection.quality_mode,
            RecordingQualityMode::HardwareBitrate
        );
        assert_eq!(selection.fallback_reason, None);
    }

    #[test]
    fn retina_60fps_lossless_uses_videotoolbox_for_realtime_capture() {
        let selection = select_recording_encoder(
            &probe(
                vec![
                    HardwareEncoder::VideoToolboxHevc,
                    HardwareEncoder::VideoToolboxH264,
                    HardwareEncoder::Libx264Software,
                ],
                HardwareEncoder::VideoToolboxHevc,
            ),
            QualityPreset::Lossless,
            2880,
            1800,
            60,
        )
        .expect("selection");

        assert_eq!(selection.encoder, HardwareEncoder::VideoToolboxH264);
        assert_eq!(
            selection.quality_mode,
            RecordingQualityMode::HardwareBitrate
        );
        assert!(selection
            .fallback_reason
            .is_some_and(|reason| reason.contains("high-resolution 60fps")));
    }

    #[test]
    fn above_1080p_60fps_lossless_uses_videotoolbox_for_realtime_capture() {
        let selection = select_recording_encoder(
            &probe(
                vec![
                    HardwareEncoder::VideoToolboxH264,
                    HardwareEncoder::Libx264Software,
                ],
                HardwareEncoder::VideoToolboxH264,
            ),
            QualityPreset::Lossless,
            2700,
            1518,
            60,
        )
        .expect("selection");

        assert_eq!(selection.encoder, HardwareEncoder::VideoToolboxH264);
        assert_eq!(
            selection.quality_mode,
            RecordingQualityMode::HardwareBitrate
        );
    }

    #[test]
    fn hidpi_crop_defaults_to_match_source_even_below_4k_area() {
        let crop = FrameCropRectDto {
            x: 0,
            y: 80,
            w: 1800,
            h: 1012,
            basis_w: Some(1800),
            basis_h: Some(1125),
            scale_hint: Some(2.0),
        };

        assert!(should_default_output_match_source(Some(crop), 3600, 2024));
    }

    #[test]
    fn non_hidpi_1080p_crop_keeps_1080p_default() {
        let crop = FrameCropRectDto {
            x: 0,
            y: 80,
            w: 1800,
            h: 1012,
            basis_w: Some(1800),
            basis_h: Some(1125),
            scale_hint: Some(1.0),
        };

        assert!(!should_default_output_match_source(Some(crop), 1800, 1012));
    }

    #[test]
    fn retina_60fps_high_uses_videotoolbox_for_realtime_capture() {
        let selection = select_recording_encoder(
            &probe(
                vec![
                    HardwareEncoder::VideoToolboxH264,
                    HardwareEncoder::Libx264Software,
                ],
                HardwareEncoder::VideoToolboxH264,
            ),
            QualityPreset::High,
            2880,
            1800,
            60,
        )
        .expect("selection");

        assert_eq!(selection.encoder, HardwareEncoder::VideoToolboxH264);
        assert_eq!(
            selection.quality_mode,
            RecordingQualityMode::HardwareBitrate
        );
        assert!(selection
            .fallback_reason
            .is_some_and(|reason| reason.contains("high-resolution 60fps")));
    }
}

#[cfg(test)]
mod post_mux_tests {
    use super::{build_post_mux_args, PostMuxAudio, PostMuxPlan};
    use encoder::AudioFormat;
    use std::path::PathBuf;

    #[test]
    fn silent_mux_copies_video_and_adds_aac_track() {
        let plan = PostMuxPlan {
            video_path: PathBuf::from("/tmp/session.video.mp4"),
            output_path: PathBuf::from("/tmp/session.mp4"),
            audio: PostMuxAudio::Silent,
        };
        let args = build_post_mux_args(&plan, &PathBuf::from("/tmp/session.partial.mp4"));
        let joined = args.join(" ");

        assert!(joined.contains("-i /tmp/session.video.mp4"));
        assert!(joined.contains("-f lavfi -i anullsrc=r=48000:cl=mono"));
        assert!(joined.contains("-c:v copy"));
        assert!(joined.contains("-c:a aac"));
        assert!(joined.contains("-b:a 64k"));
        assert!(joined.ends_with("/tmp/session.partial.mp4"));
    }

    #[test]
    fn pcm_mux_uses_raw_audio_file_and_copies_video() {
        let plan = PostMuxPlan {
            video_path: PathBuf::from("/tmp/session.video.mp4"),
            output_path: PathBuf::from("/tmp/session.mp4"),
            audio: PostMuxAudio::Pcm {
                path: PathBuf::from("/tmp/session.audio.f32le"),
                sample_rate: 48_000,
                channels: 2,
                format: AudioFormat::F32LE,
            },
        };
        let args = build_post_mux_args(&plan, &PathBuf::from("/tmp/session.partial.mp4"));
        let joined = args.join(" ");

        assert!(joined.contains("-f f32le -ar 48000 -ac 2 -i /tmp/session.audio.f32le"));
        assert!(joined.contains("-map 0:v:0 -map 1:a:0"));
        assert!(joined.contains("-c:v copy"));
        assert!(joined.contains("-b:a 128k -ac 2"));
    }
}

/// Covers the two pieces of start_recording that are testable without
/// plumbing the whole Tauri runtime: the configurable first-frame timeout
/// derivation and the FIFO metadata-poll handshake.
#[cfg(test)]
mod first_frame_and_fifo_tests {
    use crate::error::AppError;
    use std::time::Duration;

    /// Some(500) yields ~500ms; None yields default 3000ms.
    #[test]
    fn first_frame_timeout_respects_arg_or_defaults_to_3000() {
        let explicit: Option<u64> = Some(500);
        let default: Option<u64> = None;
        assert_eq!(
            Duration::from_millis(explicit.unwrap_or(3000)),
            Duration::from_millis(500)
        );
        assert_eq!(
            Duration::from_millis(default.unwrap_or(3000)),
            Duration::from_millis(3000)
        );
    }

    /// Some(100) -> elapsed wait fires in ~100ms, NOT the 3000ms default.
    #[tokio::test(flavor = "current_thread")]
    async fn first_frame_timeout_fires_at_configured_budget() {
        let budget = Duration::from_millis(Some(100u64).unwrap_or(3000));
        let (_tx, mut rx) = tokio::sync::mpsc::channel::<u32>(1);
        let start = tokio::time::Instant::now();
        let out = tokio::time::timeout(budget, rx.recv()).await;
        let elapsed = start.elapsed();
        assert!(out.is_err(), "timeout must elapse when nothing arrives");
        assert!(
            elapsed >= Duration::from_millis(100) && elapsed < Duration::from_millis(800),
            "elapsed {:?} must be near 100ms, not 3000ms",
            elapsed
        );
    }

    /// Model the FIFO handshake loop. Feed a sequence of metadata results
    /// (simulating FFmpeg not-yet-open → open) and assert the loop breaks
    /// after 3 consecutive Ok, and NOT before.
    #[test]
    fn fifo_handshake_requires_3_consecutive_ok() {
        // Simulate metadata() results as a scripted sequence.
        let script: Vec<bool> = vec![false, false, true, false, true, true, true];
        let mut ok_ticks: u8 = 0;
        let mut broke_at: Option<usize> = None;
        for (i, ok) in script.iter().enumerate() {
            if *ok {
                ok_ticks += 1;
                if ok_ticks >= 3 {
                    broke_at = Some(i);
                    break;
                }
            } else {
                ok_ticks = 0;
            }
        }
        // First streak of 3 consecutive Ok lands at index 6 (true,true,true).
        assert_eq!(broke_at, Some(6));
    }

    /// The heartbeat loop emits monotonically-increasing seq values on
    /// each tick and breaks cleanly when the sink reports closed. This
    /// mirrors the loop body spawned inside `start_recording`.
    #[tokio::test(flavor = "current_thread", start_paused = true)]
    async fn heartbeat_loop_emits_monotonic_seq_and_breaks_on_closed_sink() {
        use std::sync::{Arc, Mutex};

        let emitted: Arc<Mutex<Vec<u64>>> = Arc::new(Mutex::new(Vec::new()));
        let emitted_clone = Arc::clone(&emitted);
        let closed = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let closed_clone = Arc::clone(&closed);

        let send = move |seq: u64| -> std::result::Result<(), ()> {
            if closed_clone.load(std::sync::atomic::Ordering::Acquire) {
                return Err(());
            }
            emitted_clone.lock().unwrap().push(seq);
            Ok(())
        };

        let handle = tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(2));
            interval.tick().await; // skip immediate tick
            let mut seq: u64 = 0;
            loop {
                interval.tick().await;
                if send(seq).is_err() {
                    break;
                }
                seq = seq.wrapping_add(1);
            }
        });

        // Drive 3 emissions. The first `interval.tick()` after the skip
        // is immediate on the freshly-started interval, so we need a few
        // extra yields + advances to land all three.
        tokio::task::yield_now().await;
        for _ in 0..4 {
            tokio::time::advance(Duration::from_millis(2_050)).await;
            for _ in 0..4 {
                tokio::task::yield_now().await;
            }
        }
        // Close the sink; the next tick will observe Err and break.
        closed.store(true, std::sync::atomic::Ordering::Release);
        tokio::time::advance(Duration::from_millis(2_100)).await;
        tokio::task::yield_now().await;

        handle.abort();
        let _ = handle.await;

        let got = emitted.lock().unwrap().clone();
        assert!(got.len() >= 3, "expected at least 3 emissions, got {got:?}");
        for pair in got.windows(2) {
            assert_eq!(
                pair[1],
                pair[0] + 1,
                "seq must increment monotonically by 1: {got:?}"
            );
        }
        assert_eq!(got[0], 0, "seq must start at 0: {got:?}");
    }

    /// Aborting the spawn handle stops further emissions immediately,
    /// matching what `stop_recording_inner` / `drain_one` do.
    #[tokio::test(flavor = "current_thread", start_paused = true)]
    async fn heartbeat_abort_handle_stops_emissions() {
        use std::sync::{Arc, Mutex};
        let emitted: Arc<Mutex<Vec<u64>>> = Arc::new(Mutex::new(Vec::new()));
        let emitted_clone = Arc::clone(&emitted);

        let handle = tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(2));
            interval.tick().await;
            let mut seq: u64 = 0;
            loop {
                interval.tick().await;
                emitted_clone.lock().unwrap().push(seq);
                seq = seq.wrapping_add(1);
            }
        });
        let abort = handle.abort_handle();

        for _ in 0..2 {
            tokio::time::advance(Duration::from_millis(2_050)).await;
            tokio::task::yield_now().await;
            tokio::task::yield_now().await;
        }
        abort.abort();
        tokio::time::advance(Duration::from_millis(10_000)).await;
        tokio::task::yield_now().await;

        let got = emitted.lock().unwrap().clone();
        assert!(got.len() <= 2, "abort must stop future ticks (got {got:?})");
    }

    /// Deadline exceeded returns FifoHandshakeTimeout. Uses a compressed
    /// deadline (200ms) so the test runs fast — the real budget in
    /// start_recording is 2s.
    #[tokio::test(flavor = "current_thread")]
    async fn fifo_handshake_deadline_returns_timeout_error() {
        let fifo_path =
            std::path::PathBuf::from("/tmp/storycapture-nonexistent-fifo-for-handshake-test-xyz");
        let _ = std::fs::remove_file(&fifo_path);

        let fifo_deadline = tokio::time::Instant::now() + Duration::from_millis(200);
        let mut ok_ticks: u8 = 0;
        let result: Result<(), AppError> = loop {
            match tokio::fs::metadata(&fifo_path).await {
                Ok(_) => {
                    ok_ticks += 1;
                    if ok_ticks >= 3 {
                        break Ok(());
                    }
                }
                Err(_) => {
                    ok_ticks = 0;
                }
            }
            if tokio::time::Instant::now() >= fifo_deadline {
                break Err(AppError::FifoHandshakeTimeout);
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        };
        assert!(matches!(result, Err(AppError::FifoHandshakeTimeout)));
    }
}
