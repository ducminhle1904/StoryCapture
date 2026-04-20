// encoder IPC.
//
// Thin Tauri bridge around the pure `encoder` crate.

use crate::commands::capture::CaptureTargetDto;
use crate::error::AppError;
use crate::state::AppState;
use capture::audio::{
    make_fifo, negotiate_input, AudioCaptureStream, FifoHandle, NegotiatedAudioInput,
};
use capture::{ByteBoundedQueue, CaptureConfig, CaptureEvent, CapturePipeline, Frame, PixelFormat};
use encoder::{
    probe_encoders, AudioFormat, AudioInput, EncodeConfig, EncodePipeline, EncodeProgress,
    EncodeResult, EncoderError, EncoderProbe, FitMode, HardwareEncoder, OutputResolution, PadColor,
    QualityPreset, ScaleAlgo, SidecarChild, SidecarCommand,
};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_shell::ShellExt;
use tokio::process::Command as TokioCommand;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use uuid::Uuid;

const ENCODER_FRAME_CHANNEL_CAPACITY: usize = 4;

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
    /// Optional mic capture stream.
    audio_stream: Arc<tokio::sync::Mutex<Option<AudioCaptureStream>>>,
    /// Named-pipe handle.
    #[allow(dead_code)]
    audio_fifo: Option<FifoHandle>,
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

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Runtime HW-encoder feature detection.
#[tauri::command]
#[specta::specta]
pub async fn probe_hw_encoders(app: AppHandle) -> Result<EncoderProbeDto, AppError> {
    let cmd = TauriSidecar::new(app);
    let probe = probe_encoders(&cmd)
        .await
        .map_err(|e| AppError::Encoder(e.to_string()))?;
    Ok(probe.into())
}

/// Start an end-to-end recording.
#[tauri::command]
#[specta::specta]
pub async fn start_recording(
    app: AppHandle,
    _state: State<'_, AppState>,
    args: StartRecordingArgs,
    on_event: Channel<RecordingEvent>,
) -> Result<RecordingSessionId, AppError> {
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
        "start_recording requested: target={} {}x{}@{}fps folder={:?}",
        capture_target.kind_label(), args.width, args.height, args.fps, args.project_folder
    );

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
        "encoder probe ok: preferred={:?}",
        probe.preferred
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

    // Start capture pipeline.
    let cap_cfg = CaptureConfig {
        target: capture_target,
        include_cursor: args.include_cursor.unwrap_or(true),
        fps_target: args.fps,
        pixel_format: PixelFormat::Bgra,
        queue_cap_bytes: ByteBoundedQueue::DEFAULT_CAP_BYTES,
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

    let on_event_for_capture = on_event.clone();
    tokio::spawn(async move {
        while let Some(evt) = evt_rx.recv().await {
            let _ = on_event_for_capture.send(evt.into());
        }
    });

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
    // size". Worst case: 3s timeout, then we fall back to args dims.
    let (actual_width, actual_height, first_frame) =
        match tokio::time::timeout(std::time::Duration::from_secs(3), frame_rx.recv()).await {
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
                    "no first frame within 3s; encoder using caller dims {}x{}",
                    args.width, args.height
                );
                (args.width, args.height, None)
            }
        };
    // Stitch peeked frame back in front of remaining frames.
    let (enc_tx, enc_rx) = mpsc::channel::<Frame>(ENCODER_FRAME_CHANNEL_CAPACITY);
    if let Some(f) = first_frame {
        let _ = enc_tx.send(f).await;
    }
    tokio::spawn(async move {
        while let Some(f) = frame_rx.recv().await {
            if enc_tx.send(f).await.is_err() {
                break;
            }
        }
    });
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
                None
            }
            Err(e) => {
                tracing::warn!(
                    target: "storycapture::recording",
                    error = %e,
                    "mic audio negotiation join error; continuing video-only"
                );
                None
            }
        }
    } else {
        None
    };

    let audio_fifo: Option<FifoHandle> = if negotiated_audio.is_some() {
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

    // Phase 12 defaults per D-12-10; optional DTO fields override them (Phase 13 UI).
    let output_res: OutputResolution = args
        .output_resolution
        .map(Into::into)
        .unwrap_or(OutputResolution::P1080);
    let fit: FitMode = args.fit_mode.map(Into::into).unwrap_or(FitMode::Letterbox);
    let pad: PadColor = args.pad_color.map(Into::into).unwrap_or(PadColor::Black);
    let algo: ScaleAlgo = args.scale_algo.map(Into::into).unwrap_or(ScaleAlgo::Lanczos);
    let qp: QualityPreset = args
        .quality_preset
        .map(Into::into)
        .unwrap_or(QualityPreset::Med);

    let mut enc_cfg = EncodeConfig::new(
        output_path.clone(),
        actual_width,
        actual_height,
        args.fps,
        probe.preferred,
    )
    .with_output_resolution(output_res)
    .map_err(|e| AppError::Encoder(e.to_string()))?
    .with_fit_mode(fit)
    .with_pad_color(pad)
    .with_scale_algo(algo)
    .with_quality_preset(qp)
    .force_ffmpeg_path();
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
    let encode_join = EncodePipeline::start(enc_cfg, &sidecar, frame_rx, prog_tx)
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
        output_path
    );

    // Let FFmpeg open the FIFO before starting capture.
    let app_for_audio_event = app.clone();
    let audio_stream: Option<AudioCaptureStream> = if let (Some(f), Some(negotiated)) =
        (&audio_fifo, negotiated_audio)
    {
        let fifo_path = f.path().to_path_buf();
        // Small delay so FFmpeg can open the FIFO first.
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        // cpal work runs on a blocking thread.
        match tokio::task::spawn_blocking(move || {
            AudioCaptureStream::start_with_negotiated(negotiated, fifo_path)
        })
        .await
        {
            Ok(Ok((stream, info))) => {
                tracing::info!(
                    target: "storycapture::recording",
                    sample_rate = info.sample_rate,
                    channels = info.channels,
                    "mic audio capture started"
                );
                // Poll for a mic disconnect and emit a warning event.
                let flag = stream.degraded_flag();
                tokio::spawn(async move {
                    let mut ticker = tokio::time::interval(std::time::Duration::from_millis(500));
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
                Some(stream)
            }
            Ok(Err(e)) => {
                // Fall through to video-only.
                tracing::warn!(
                    target: "storycapture::recording",
                    error = %e,
                    "mic audio start failed; continuing video-only"
                );
                None
            }
            Err(e) => {
                tracing::warn!(
                    target: "storycapture::recording",
                    error = %e,
                    "mic audio spawn_blocking join error; continuing video-only"
                );
                None
            }
        }
    } else {
        None
    };

    // Progress fan-out to the renderer.
    let on_event_clone = on_event.clone();
    tokio::spawn(async move {
        while let Some(p) = prog_rx.recv().await {
            let _ = on_event_clone.send(RecordingEvent::EncodeProgress { progress: p.into() });
        }
    });

    registry().sessions.lock().insert(
        session_id.clone(),
        RecordingHandle {
            capture: Arc::new(tokio::sync::Mutex::new(capture)),
            encode_join,
            output_path,
            audio_stream: Arc::new(tokio::sync::Mutex::new(audio_stream)),
            audio_fifo,
        },
    );

    Ok(RecordingSessionId(session_id))
}

#[tauri::command]
#[specta::specta]
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
pub async fn pause_recording(session: RecordingSessionId) -> Result<(), AppError> {
    pause_recording_inner(&session.0).await
}

#[tauri::command]
#[specta::specta]
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

    let result = handle
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
    tracing::info!(target: "storycapture::recording", "stop_recording: encoder finalized output={:?}", result.output_path);

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
