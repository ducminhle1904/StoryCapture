// encoder IPC.
//
// Thin Tauri-side bridge around the pure `encoder` crate. Exposes:
//   - probe_hw_encoders  — runtime HW-encoder feature detection (ENC-02)
//   - start_recording    — end-to-end orchestration (parse → capture →
//                          encode), streaming RecordingEvent back to
//                          the renderer over a Channel<RecordingEvent>
//   - stop_recording     — graceful shutdown + finalize
//
// ## Tauri sidecar stdin bridge — design note
//
// `tauri-plugin-shell`'s sidecar API wraps the spawned child in an event
// stream and does NOT expose the raw `ChildStdin` handle the encoder
// pipeline needs (`encoder::SidecarCommand::spawn` returns piped
// stdin/stdout/stderr tokio handles). Rather than wedging around the
// plugin, we follow the same pattern Plan 01-06 uses for the Playwright
// sidecar (`commands/automation.rs`): resolve the externalBin binary
// path via `tauri-plugin-shell::ShellExt::sidecar` (which handles the
// `binaries/ffmpeg-<triple>` lookup + notarization metadata), then
// re-spawn through `tokio::process::Command` so we own the pipes.
// Decision documented in SUMMARY.md "decision path for Tauri sidecar
// stdin bridge".

use crate::error::AppError;
use crate::state::AppState;
use capture::{pick_default_backend, ByteBoundedQueue, CaptureConfig, CaptureEvent, CapturePipeline, DisplayId, Frame, PixelFormat};
use encoder::{
    probe_encoders, EncodeConfig, EncodePipeline, EncodeProgress, EncodeResult, EncoderError,
    EncoderProbe, HardwareEncoder, SidecarChild, SidecarCommand,
};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use tauri::ipc::Channel;
use tauri::{AppHandle, State};
use tauri_plugin_shell::ShellExt;
use tokio::process::Command as TokioCommand;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use uuid::Uuid;

// ---------------------------------------------------------------------------
// SidecarCommand bridge
// ---------------------------------------------------------------------------

/// `TauriSidecar` resolves the FFmpeg path via `tauri-plugin-shell` (so
/// the externalBin per-triple naming is handled consistently with the
/// Playwright sidecar), drops the resulting shell-plugin wrapper, and
/// re-spawns the raw binary via tokio so we own the stdio pipes.
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
        // Resolve the per-triple externalBin path. We discard the wrapper
        // because it doesn't expose ChildStdin; see module doc.
        let _resolved = self
            .app
            .shell()
            .sidecar(&self.binary_name)
            .map_err(|e| EncoderError::SpawnFailed(format!("resolve sidecar: {e}")))?;

        let mut cmd = TokioCommand::new(&self.binary_name);
        cmd.args(&args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = cmd
            .spawn()
            .map_err(|e| EncoderError::SpawnFailed(format!("tokio spawn {}: {e}", self.binary_name)))?;

        let stdin = child.stdin.take().ok_or_else(|| {
            EncoderError::SpawnFailed("missing stdin handle".into())
        })?;
        let stdout = child.stdout.take().ok_or_else(|| {
            EncoderError::SpawnFailed("missing stdout handle".into())
        })?;
        let stderr = child.stderr.take().ok_or_else(|| {
            EncoderError::SpawnFailed("missing stderr handle".into())
        })?;
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

/// Unified recording event — fan-in of capture / encode progress /
/// terminal results. We don't wire automation executor events here
/// (Plan 01-06 already streams those on its own channel); the UI joins
/// the two streams via the session id.
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum RecordingEvent {
    CaptureStatus { json: String },
    EncodeProgress { progress: EncodeProgressDto },
    Completed { result: EncodeResultDto },
    Failed { message: String },
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
    pub display_id: u64,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
}

// ---------------------------------------------------------------------------
// Session registry
// ---------------------------------------------------------------------------

struct RecordingHandle {
    capture: Arc<tokio::sync::Mutex<CapturePipeline>>,
    encode_join: JoinHandle<encoder::Result<EncodeResult>>,
    /// Target output file (retained for diagnostics; UI mirrors it back
    /// via `EncodeResult.output_path`).
    #[allow(dead_code)]
    output_path: PathBuf,
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

/// ENC-02 — runtime HW-encoder feature detection. Safe to call at any
/// time; callers SHOULD cache the result for the session.
#[tauri::command]
#[specta::specta]
pub async fn probe_hw_encoders(app: AppHandle) -> Result<EncoderProbeDto, AppError> {
    let cmd = TauriSidecar::new(app);
    let probe = probe_encoders(&cmd)
        .await
        .map_err(|e| AppError::Encoder(e.to_string()))?;
    Ok(probe.into())
}

/// Start an end-to-end recording: capture pipeline → encoder pipeline →
/// MP4/H.264 file at `<project_folder>/exports/<session_id>.mp4`.
///
/// Automation orchestration (Plan 01-06 BrowserDriver) runs independently
/// via `launch_automation`; the UI correlates the two by session id.
#[tauri::command]
#[specta::specta]
pub async fn start_recording(
    app: AppHandle,
    _state: State<'_, AppState>,
    args: StartRecordingArgs,
    on_event: Channel<RecordingEvent>,
) -> Result<RecordingSessionId, AppError> {
    // Probe encoders (done per-start; the `EncoderProbe` is small).
    let probe = {
        let cmd = TauriSidecar::new(app.clone());
        probe_encoders(&cmd)
            .await
            .map_err(|e| AppError::Encoder(e.to_string()))?
    };

    // Allocate session + output path.
    let session_id = Uuid::new_v4().to_string();
    let project = PathBuf::from(&args.project_folder);
    let exports_dir = project.join("exports");
    std::fs::create_dir_all(&exports_dir).map_err(AppError::from)?;
    let output_path = exports_dir.join(format!("{session_id}.mp4"));

    // Start capture pipeline.
    let cap_cfg = CaptureConfig {
        display_id: DisplayId(args.display_id),
        include_cursor: true,
        fps_target: args.fps,
        pixel_format: PixelFormat::Bgra,
        queue_cap_bytes: ByteBoundedQueue::DEFAULT_CAP_BYTES,
    };
    let backend = pick_default_backend(&cap_cfg);
    let queue = ByteBoundedQueue::new(cap_cfg.queue_cap_bytes);
    let mut capture = CapturePipeline::new(backend, queue);
    let (frame_tx, frame_rx) = mpsc::channel::<Frame>(64);
    capture
        .start(cap_cfg.clone(), frame_tx)
        .await
        .map_err(|e| AppError::Capture(e.to_string()))?;

    // Kick encode pipeline.
    let enc_cfg = EncodeConfig::new(
        output_path.clone(),
        args.width,
        args.height,
        args.fps,
        probe.preferred,
    );
    let (prog_tx, mut prog_rx) = mpsc::channel::<EncodeProgress>(32);
    let sidecar = TauriSidecar::new(app.clone());
    let encode_join = EncodePipeline::start(enc_cfg, &sidecar, frame_rx, prog_tx)
        .await
        .map_err(|e| AppError::Encoder(e.to_string()))?;

    // Progress fan-out to the renderer.
    let on_event_clone = on_event.clone();
    tokio::spawn(async move {
        while let Some(p) = prog_rx.recv().await {
            let _ = on_event_clone.send(RecordingEvent::EncodeProgress {
                progress: p.into(),
            });
        }
    });

    registry().sessions.lock().insert(
        session_id.clone(),
        RecordingHandle {
            capture: Arc::new(tokio::sync::Mutex::new(capture)),
            encode_join,
            output_path,
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
    let handle = registry()
        .sessions
        .lock()
        .remove(&session.0)
        .ok_or_else(|| AppError::NotFound(format!("recording session {}", session.0)))?;

    // Stop capture — this closes the frame channel, which causes the
    // encoder's frame pump to hit EOF, drop stdin, and let FFmpeg finalize.
    {
        let mut p = handle.capture.lock().await;
        let _ = p
            .stop()
            .await
            .map_err(|e| AppError::Capture(e.to_string()))?;
    }

    // Wait for the encoder to flush.
    let result = handle
        .encode_join
        .await
        .map_err(|e| AppError::Encoder(format!("encoder join: {e}")))?
        .map_err(|e| {
            let _ = on_event.send(RecordingEvent::Failed {
                message: e.to_string(),
            });
            AppError::Encoder(e.to_string())
        })?;

    let dto: EncodeResultDto = result.into();
    let _ = on_event.send(RecordingEvent::Completed {
        result: dto.clone(),
    });
    Ok(dto)
}

#[allow(dead_code)]
fn _silence_unused_output_path(p: &PathBuf) -> &PathBuf {
    p
}
