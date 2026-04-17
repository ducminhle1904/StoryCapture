// capture IPC.
//
// Thin Tauri-side wrapper around the pure `capture` crate. Exposes:
//   - list_displays                        — multi-display enumeration (CAP-06)
//   - check_screen_capture_permission      — TCC preflight (CAP-04, mac only)
//   - open_screen_capture_prefs            — deep-link to System Settings
//   - relaunch_app                         — Sequoia post-grant relaunch
//   - start_capture / stop_capture         — backend lifecycle
//
// Frame pixel data stays in-process (the encoder, Plan 01-08, consumes
// the raw `mpsc::Receiver<Frame>` directly from the pipeline actor). The
// `on_frame` channel here carries metadata only (sequence + pts + bytes)
// so the renderer can drive HUD counters without copying pixels across
// the IPC boundary.

use crate::error::AppError;
use capture::{
    enumerate_displays, pick_default_backend, BackendKind, ByteBoundedQueue, CaptureConfig,
    CaptureEvent, CaptureStats, CapturePipeline, ClockSource, DisplayId, DisplayInfo, Frame,
    PixelFormat,
};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use uuid::Uuid;

/// macOS-only permission state mirroring `capture::macos::tcc::PermissionState`.
/// On non-macOS this command always returns `Granted`.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum PermissionState {
    Granted,
    Denied,
    Undetermined,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct DisplayInfoDto {
    pub id: u64,
    pub name: String,
    pub width_px: u32,
    pub height_px: u32,
    pub scale_factor: f32,
    pub is_primary: bool,
}

impl From<DisplayInfo> for DisplayInfoDto {
    fn from(d: DisplayInfo) -> Self {
        DisplayInfoDto {
            id: d.id.0,
            name: d.name,
            width_px: d.width_px,
            height_px: d.height_px,
            scale_factor: d.scale_factor,
            is_primary: d.is_primary,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum PixelFormatDto {
    Bgra,
    Nv12,
}

impl From<PixelFormatDto> for PixelFormat {
    fn from(p: PixelFormatDto) -> Self {
        match p {
            PixelFormatDto::Bgra => PixelFormat::Bgra,
            PixelFormatDto::Nv12 => PixelFormat::Nv12,
        }
    }
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct CaptureConfigDto {
    pub display_id: u64,
    pub include_cursor: bool,
    pub fps_target: u32,
    pub pixel_format: PixelFormatDto,
    /// Defaults to 256 MiB if `None`.
    pub queue_cap_bytes: Option<u64>,
}

impl From<CaptureConfigDto> for CaptureConfig {
    fn from(c: CaptureConfigDto) -> Self {
        CaptureConfig {
            display_id: DisplayId(c.display_id),
            include_cursor: c.include_cursor,
            fps_target: c.fps_target,
            pixel_format: c.pixel_format.into(),
            queue_cap_bytes: c
                .queue_cap_bytes
                .map(|v| v as usize)
                .unwrap_or(ByteBoundedQueue::DEFAULT_CAP_BYTES),
        }
    }
}

#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct CaptureStatsDto {
    pub frames_delivered: u64,
    pub frames_dropped: u64,
    pub bytes_peak: u64,
    pub duration_ms: u64,
}

impl From<CaptureStats> for CaptureStatsDto {
    fn from(s: CaptureStats) -> Self {
        CaptureStatsDto {
            frames_delivered: s.frames_delivered,
            frames_dropped: s.frames_dropped,
            bytes_peak: s.bytes_peak as u64,
            duration_ms: s.duration_ms,
        }
    }
}

/// Wrapper around `capture::CaptureEvent` for the typed `Channel<T>` —
/// same pattern as `AutomationEvent` in `commands/automation.rs`. Keeps
/// the `capture` crate free of `specta`.
#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct CaptureEventDto {
    pub json: String,
}

impl From<CaptureEvent> for CaptureEventDto {
    fn from(e: CaptureEvent) -> Self {
        CaptureEventDto {
            json: serde_json::to_string(&e).unwrap_or_else(|_| "{}".into()),
        }
    }
}

#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct FrameMetaDto {
    pub sequence: u64,
    /// PTS in nanoseconds (i128 doesn't cross IPC cleanly; values fit
    /// comfortably in i64 over any realistic capture duration).
    pub pts_ns: i64,
    pub clock_source: ClockSourceDto,
    pub bytes: u64,
    pub width_px: u32,
    pub height_px: u32,
}

#[derive(Debug, Clone, Copy, Serialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum ClockSourceDto {
    HostTime,
    Qpc,
    Synthetic,
}

impl From<ClockSource> for ClockSourceDto {
    fn from(c: ClockSource) -> Self {
        match c {
            ClockSource::HostTime => ClockSourceDto::HostTime,
            ClockSource::Qpc => ClockSourceDto::Qpc,
            ClockSource::Synthetic => ClockSourceDto::Synthetic,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct SessionId(pub String);

/// Process-global session registry. Each `start_capture` allocates a
/// `SessionId` and stores the pipeline's stop handle here so a later
/// `stop_capture(session)` can drain the right pipeline.
#[derive(Default)]
struct CaptureRegistry {
    sessions: Mutex<HashMap<String, SessionHandle>>,
}

struct SessionHandle {
    pipeline: Arc<tokio::sync::Mutex<CapturePipeline>>,
    forward_task: JoinHandle<()>,
}

fn registry() -> &'static CaptureRegistry {
    use std::sync::OnceLock;
    static REGISTRY: OnceLock<CaptureRegistry> = OnceLock::new();
    REGISTRY.get_or_init(CaptureRegistry::default)
}

#[tauri::command]
#[specta::specta]
pub fn list_displays() -> Result<Vec<DisplayInfoDto>, AppError> {
    enumerate_displays()
        .map(|v| v.into_iter().map(Into::into).collect())
        .map_err(|e| AppError::Capture(e.to_string()))
}

#[tauri::command]
#[specta::specta]
pub fn check_screen_capture_permission() -> Result<PermissionState, AppError> {
    #[cfg(target_os = "macos")]
    {
        use capture::macos::tcc::{preflight_screen_capture_access, PermissionState as P};
        Ok(match preflight_screen_capture_access() {
            P::Granted => PermissionState::Granted,
            P::Denied => PermissionState::Denied,
            P::Undetermined => PermissionState::Undetermined,
        })
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(PermissionState::Granted)
    }
}

#[tauri::command]
#[specta::specta]
pub async fn open_screen_capture_prefs(app: AppHandle) -> Result<(), AppError> {
    #[cfg(target_os = "macos")]
    {
        let url = capture::macos::tcc::TCC_PREFS_URL;
        app.opener()
            .open_url(url, None::<&str>)
            .map_err(|e| AppError::Capture(format!("open prefs URL: {e}")))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Ok(())
    }
}

/// Calls `CGRequestScreenCaptureAccess()` on macOS. This triggers the
/// native system permission prompt (first launch) AND registers the app
/// in System Settings → Privacy & Security → Screen Recording so the
/// user can toggle it on. Without this call, the app never appears in
/// the Settings list.
///
/// Returns the state AFTER the request. On macOS Sequoia the OS may
/// still require an app relaunch before the new grant attaches to the
/// running process.
#[tauri::command]
#[specta::specta]
pub fn request_screen_capture_access() -> Result<PermissionState, AppError> {
    #[cfg(target_os = "macos")]
    {
        use capture::macos::tcc::{
            preflight_screen_capture_access, request_access, PermissionState as P,
        };
        // Fire the request — this registers the app in TCC so it appears in
        // System Settings → Privacy → Screen Recording.
        let _ = request_access();
        // Re-check; note macOS may cache the pre-grant state for the current process.
        Ok(match preflight_screen_capture_access() {
            P::Granted => PermissionState::Granted,
            P::Denied => PermissionState::Denied,
            P::Undetermined => PermissionState::Undetermined,
        })
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(PermissionState::Granted)
    }
}

#[tauri::command]
#[specta::specta]
pub async fn relaunch_app(app: AppHandle) -> Result<(), AppError> {
    // tauri-plugin-process exposes restart at the app handle level.
    // `restart` is `-> !` on success (process is replaced), so this
    // function returns `Ok(())` only on the unreachable arm; the call
    // itself terminates the current process.
    app.restart();
}

#[tauri::command]
#[specta::specta]
pub async fn start_capture(
    cfg: CaptureConfigDto,
    on_event: Channel<CaptureEventDto>,
    on_frame: Channel<FrameMetaDto>,
) -> Result<SessionId, AppError> {
    let cap_cfg: CaptureConfig = cfg.into();
    let backend = pick_default_backend(&cap_cfg);
    let kind = backend.kind();
    let queue = ByteBoundedQueue::new(cap_cfg.queue_cap_bytes);
    let mut pipeline = CapturePipeline::new(backend, queue);
    let (tx, mut rx) = mpsc::channel::<Frame>(64);

    pipeline
        .start(cap_cfg.clone(), tx)
        .await
        .map_err(|e| AppError::Capture(e.to_string()))?;

    // Resolve the display info for the Started event. Best-effort: if
    // enumeration fails here we skip the Started payload but keep the
    // session running.
    if let Ok(displays) = enumerate_displays() {
        if let Some(d) = displays.into_iter().find(|d| d.id == cap_cfg.display_id) {
            let _ = on_event.send(CaptureEvent::Started { display: d }.into());
        }
    }
    let _ = kind; // already encoded into the Started event via backend choice

    // Forwarder task: pump frames from the consumer side, emit per-frame
    // metadata to the renderer, drop the frame body to free its memory.
    let on_frame_clone = on_frame.clone();
    let forward_task = tokio::spawn(async move {
        while let Some(frame) = rx.recv().await {
            let meta = FrameMetaDto {
                sequence: frame.sequence,
                pts_ns: i64::try_from(frame.pts.ns).unwrap_or(i64::MAX),
                clock_source: frame.pts.source.into(),
                bytes: frame.byte_size() as u64,
                width_px: frame.width_px,
                height_px: frame.height_px,
            };
            // Best-effort send; renderer may have detached.
            let _ = on_frame_clone.send(meta);
            // Frame Drop fires here, releasing CFRetain / COM Release.
            drop(frame);
        }
    });
    let _ = on_frame; // keep the original handle alive via clone above

    let session_id = Uuid::new_v4().to_string();
    let handle = SessionHandle {
        pipeline: Arc::new(tokio::sync::Mutex::new(pipeline)),
        forward_task,
    };
    registry()
        .sessions
        .lock()
        .insert(session_id.clone(), handle);

    Ok(SessionId(session_id))
}

#[tauri::command]
#[specta::specta]
pub async fn stop_capture(session: SessionId) -> Result<CaptureStatsDto, AppError> {
    let handle = registry()
        .sessions
        .lock()
        .remove(&session.0)
        .ok_or_else(|| AppError::NotFound(format!("capture session {}", session.0)))?;
    let stats = {
        let mut p = handle.pipeline.lock().await;
        p.stop()
            .await
            .map_err(|e| AppError::Capture(e.to_string()))?
    };
    // Forwarder exits when the consumer rx hits EOF (pipeline closes its
    // queue on backend stop). Wait for it so any final metadata events
    // make it to the renderer before we report stats.
    let _ = handle.forward_task.await;
    Ok(stats.into())
}

// Suppress unused-import warnings on Windows / non-mac builds where the
// Manager re-export is only needed by the macOS branch above.
#[allow(unused_imports)]
fn _silence_unused() {
    use Manager as _;
    use BackendKind as _;
}
