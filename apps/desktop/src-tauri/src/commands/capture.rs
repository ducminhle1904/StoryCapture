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
    enumerate_displays, pick_default_backend, ByteBoundedQueue, CaptureBackend, CaptureConfig,
    CaptureEvent, CaptureStats, ClockSource, DisplayId, DisplayInfo, Frame,
    PixelFormat,
};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tauri::ipc::Channel;
use tauri::AppHandle;
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
            target: capture::CaptureTarget::Display {
                display_id: DisplayId(c.display_id),
            },
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
    backend: tokio::sync::Mutex<Box<dyn CaptureBackend + Send>>,
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
    let mut backend = pick_default_backend(&cap_cfg);
    let kind = backend.kind();
    let (tx, mut rx) = mpsc::channel::<Frame>(64);

    backend
        .start(cap_cfg.clone(), tx)
        .await
        .map_err(|e| AppError::Capture(e.to_string()))?;

    // Resolve the display info for the Started event. Best-effort: if
    // enumeration fails here we skip the Started payload but keep the
    // session running. Only applies to Display targets.
    if let Some(display_id) = cap_cfg.display_id() {
        if let Ok(displays) = enumerate_displays() {
            if let Some(d) = displays.into_iter().find(|d| d.id == display_id) {
                let _ = on_event.send(CaptureEvent::Started { display: d }.into());
            }
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
        backend: tokio::sync::Mutex::new(backend),
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
        let mut b = handle.backend.lock().await;
        b.stop()
            .await
            .map_err(|e| AppError::Capture(e.to_string()))?
    };
    // Forwarder exits when its rx hits EOF (backend drops its tx on stop).
    // Await so any final metadata events make it to the renderer before
    // stats are reported.
    let _ = handle.forward_task.await;
    Ok(stats.into())
}

// ──────────────────────────────────────────────────────────────────────
// Plan 05-01: Window target support (list_windows, list_capture_targets,
// start_capture_target, capture-target persistence).
// ──────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct WindowInfoDto {
    pub window_id: u64,
    pub title: Option<String>,
    pub app_name: String,
    pub pid: i32,
    pub bundle_id: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub is_on_screen: bool,
}

/// Tagged CaptureTarget DTO. Mirrors `capture::CaptureTarget` with the
/// same `kind` discriminator so the JSON wire format is identical.
///
/// Plan 06-02 adds `DisplayRegion { display_id, rect }` — a logical-point
/// sub-rect of a display. The `rect` is validated against display bounds
/// at the IPC boundary (T-06-08 mitigation) before it reaches SCK/WGC.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CaptureTargetDto {
    Display { display_id: u64 },
    Window { window_id: u64 },
    WindowByPid { pid: i32, title_hint: Option<String> },
    DisplayRegion { display_id: u64, rect: RegionRectDto },
}

/// Logical-point rect over a display. Serializes to/from `capture::RegionRect`
/// with identical field order.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, specta::Type)]
pub struct RegionRectDto {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl From<RegionRectDto> for capture::RegionRect {
    fn from(r: RegionRectDto) -> Self {
        capture::RegionRect { x: r.x, y: r.y, w: r.w, h: r.h }
    }
}

impl From<capture::RegionRect> for RegionRectDto {
    fn from(r: capture::RegionRect) -> Self {
        RegionRectDto { x: r.x, y: r.y, w: r.w, h: r.h }
    }
}

impl From<CaptureTargetDto> for capture::CaptureTarget {
    fn from(dto: CaptureTargetDto) -> Self {
        match dto {
            CaptureTargetDto::Display { display_id } => {
                capture::CaptureTarget::Display { display_id: DisplayId(display_id) }
            }
            CaptureTargetDto::Window { window_id } => {
                capture::CaptureTarget::Window { window_id: capture::WindowId(window_id) }
            }
            CaptureTargetDto::WindowByPid { pid, title_hint } => {
                capture::CaptureTarget::WindowByPid { pid, title_hint }
            }
            CaptureTargetDto::DisplayRegion { display_id, rect } => {
                capture::CaptureTarget::DisplayRegion {
                    display_id: DisplayId(display_id),
                    rect: rect.into(),
                }
            }
        }
    }
}

impl From<capture::CaptureTarget> for CaptureTargetDto {
    fn from(t: capture::CaptureTarget) -> Self {
        match t {
            capture::CaptureTarget::Display { display_id } => {
                CaptureTargetDto::Display { display_id: display_id.0 }
            }
            capture::CaptureTarget::Window { window_id } => {
                CaptureTargetDto::Window { window_id: window_id.0 }
            }
            capture::CaptureTarget::WindowByPid { pid, title_hint } => {
                CaptureTargetDto::WindowByPid { pid, title_hint }
            }
            capture::CaptureTarget::DisplayRegion { display_id, rect } => {
                CaptureTargetDto::DisplayRegion {
                    display_id: display_id.0,
                    rect: rect.into(),
                }
            }
        }
    }
}

#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct CaptureTargetsDto {
    pub displays: Vec<DisplayInfoDto>,
    pub windows: Vec<WindowInfoDto>,
    pub playwright_auto_available: bool,
}

/// Allow-list of window ids returned by the most recent `list_windows`
/// call. Used by `start_capture_target` to refuse unknown ids
/// (T-05-01-01: WindowId injection).
#[derive(Default)]
struct WindowAllowList {
    ids: Mutex<std::collections::HashSet<u64>>,
}

fn window_allow_list() -> &'static WindowAllowList {
    use std::sync::OnceLock;
    static LIST: OnceLock<WindowAllowList> = OnceLock::new();
    LIST.get_or_init(WindowAllowList::default)
}

#[tauri::command]
#[specta::specta]
pub async fn list_windows() -> Result<Vec<WindowInfoDto>, AppError> {
    // Enumeration is synchronous on both platforms (SCShareableContent / EnumChildWindows),
    // so both paths run in spawn_blocking (Pitfall 7).
    #[cfg(target_os = "macos")]
    let infos = tokio::task::spawn_blocking(capture::macos::window::list_windows)
        .await
        .map_err(|e| AppError::Capture(format!("join: {e}")))?
        .map_err(|e| AppError::Capture(e.to_string()))?;
    #[cfg(target_os = "windows")]
    let infos = tokio::task::spawn_blocking(capture::windows::window::list_windows)
        .await
        .map_err(|e| AppError::Capture(format!("join: {e}")))?
        .map_err(|e| AppError::Capture(e.to_string()))?;
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let infos: Vec<capture::WindowInfo> = Vec::new();

    {
        let mut ids = window_allow_list().ids.lock();
        ids.clear();
        for w in &infos {
            ids.insert(w.window_id);
        }
    }
    Ok(infos
        .into_iter()
        .map(|w| WindowInfoDto {
            window_id: w.window_id,
            title: w.title,
            app_name: w.app_name,
            pid: w.pid,
            bundle_id: w.bundle_id,
            x: w.x,
            y: w.y,
            width: w.width,
            height: w.height,
            is_on_screen: w.is_on_screen,
        })
        .collect())
}

#[tauri::command]
#[specta::specta]
pub async fn list_capture_targets() -> Result<CaptureTargetsDto, AppError> {
    let displays = enumerate_displays()
        .map(|v| v.into_iter().map(DisplayInfoDto::from).collect::<Vec<_>>())
        .map_err(|e| AppError::Capture(e.to_string()))?;
    let windows = list_windows().await?;
    // Plan 05-02: Playwright availability = the pid stash currently holds
    // a concrete pid (not None, not remote-browser).
    let playwright_auto_available = crate::commands::automation::playwright_pid_stash()
        .get()
        .and_then(|i| i.pid)
        .is_some();
    Ok(CaptureTargetsDto {
        displays,
        windows,
        playwright_auto_available,
    })
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct StartCaptureTargetArgs {
    pub target: CaptureTargetDto,
    pub include_cursor: bool,
    pub fps_target: u32,
    pub pixel_format: PixelFormatDto,
    pub queue_cap_bytes: Option<u64>,
}

/// Extended `start_capture` that accepts a `CaptureTarget` and runs it
/// through the fallback orchestrator. The existing `start_capture` is
/// kept for backwards compat with the encoder path.
#[tauri::command]
#[specta::specta]
pub async fn start_capture_target(
    app: AppHandle,
    args: StartCaptureTargetArgs,
    on_event: Channel<CaptureEventDto>,
    on_frame: Channel<FrameMetaDto>,
) -> Result<SessionId, AppError> {
    // Validate WindowId against the most recent allow-list (T-05-01-01).
    if let CaptureTargetDto::Window { window_id } = &args.target {
        let ids = window_allow_list().ids.lock();
        if !ids.is_empty() && !ids.contains(window_id) {
            return Err(AppError::Capture(format!(
                "unknown window_id {window_id} — re-enumerate windows first"
            )));
        }
    }
    // Plan 05-02 (T-05-02-01, T-05-02-02): for `WindowByPid`, override any
    // renderer-supplied pid with the host-side Playwright pid stash, and
    // validate the title_hint.
    let target = if let CaptureTargetDto::WindowByPid { title_hint, .. } = &args.target {
        if let Some(h) = title_hint.as_deref() {
            if h.len() > 256 {
                return Err(AppError::Capture(
                    "title_hint exceeds 256 chars".into(),
                ));
            }
            if h.chars().any(|c| c.is_ascii_control()) {
                return Err(AppError::Capture(
                    "title_hint contains ASCII control chars".into(),
                ));
            }
        }
        // Only rewrite pid when the stored hint matches the Playwright
        // sentinel ("storycapture-playwright" OR "Chromium"). Generic
        // renderer-supplied WindowByPid targets are left alone — a future
        // plan may enable non-Playwright auto-follow workflows.
        let is_playwright_sentinel = matches!(
            title_hint.as_deref(),
            Some("storycapture-playwright") | Some("Chromium")
        );
        if is_playwright_sentinel {
            let stash_pid = crate::commands::automation::playwright_pid_stash()
                .get()
                .and_then(|i| i.pid);
            let Some(pid) = stash_pid else {
                return Err(AppError::Capture(
                    "Playwright auto-target requested but no Playwright pid is available — launch a story first".into(),
                ));
            };
            // Plan 06-03 — preset-driven title hint. Read the persisted
            // browser_executable and resolve the chromium-family window
            // title Chromium uses for its top-level frames (Edge, Brave,
            // Chrome channels). When the preset is unknown or unset,
            // `title_hint=None` lets find_window_by_pid fall back to
            // "any window owned by the pid" (D-15 preserved).
            let settings = crate::commands::app_settings::load(&app);
            let resolved_hint =
                crate::title_hints::title_hint_for(settings.browser_executable.as_deref());
            // T-06-15 — truncate the hint for log emission only. The
            // value we pass on through to SCK stays full-length.
            let redacted = crate::title_hints::redact_title_hint(resolved_hint.as_deref());
            tracing::info!(
                pid,
                title_hint = %redacted,
                "Plan 06-03: Playwright auto-target title hint resolved"
            );
            CaptureTargetDto::WindowByPid {
                pid,
                title_hint: resolved_hint,
            }
        } else {
            args.target.clone()
        }
    } else {
        args.target.clone()
    };
    // Overwrite the incoming target with the sanitized / pid-rewritten one.
    let args = StartCaptureTargetArgs { target, ..args };

    // Plan 06-02 — validate region rect against display bounds at IPC
    // boundary (T-06-08). Rejects NaN/Inf/negative/zero-area/out-of-bounds
    // rects with a structured error — never reaches SCK/WGC.
    if let CaptureTargetDto::DisplayRegion { display_id, rect } = &args.target {
        let displays = enumerate_displays()
            .map_err(|e| AppError::Capture(format!("enumerate displays for region validation: {e}")))?;
        let disp = displays
            .into_iter()
            .find(|d| d.id.0 == *display_id)
            .ok_or_else(|| {
                AppError::Capture(format!(
                    "region target references unknown display_id={display_id}"
                ))
            })?;
        // `DisplayInfo.{width_px,height_px}` are physical pixels already
        // scaled by `scale_factor`. The RegionRect is logical — divide to
        // recover logical extents.
        let logical_w = (disp.width_px as f64) / (disp.scale_factor as f64).max(1.0);
        let logical_h = (disp.height_px as f64) / (disp.scale_factor as f64).max(1.0);
        let rr: capture::RegionRect = (*rect).into();
        rr.validate(logical_w, logical_h)
            .map_err(AppError::Capture)?;
    }

    // Persist the target for stickiness (D-01).
    {
        let target: capture::CaptureTarget = args.target.clone().into();
        let mut settings = crate::commands::app_settings::load(&app);
        settings.capture_target = Some(target);
        if let Err(e) = crate::commands::app_settings::save(&app, &settings) {
            tracing::warn!(error = %e, "failed to persist capture_target; continuing");
        }
    }

    let target: capture::CaptureTarget = args.target.into();
    let cap_cfg = CaptureConfig {
        target: target.clone(),
        include_cursor: args.include_cursor,
        fps_target: args.fps_target,
        pixel_format: args.pixel_format.into(),
        queue_cap_bytes: args
            .queue_cap_bytes
            .map(|v| v as usize)
            .unwrap_or(ByteBoundedQueue::DEFAULT_CAP_BYTES),
    };

    let (tx, mut rx) = mpsc::channel::<Frame>(64);

    // Native-first per platform; orchestrator falls back to xcap silently
    // for window targets (D-07 / Plan 05-01 orchestrator).
    //
    // Plan 05-03: on Windows, wire the WgcBackend with its event sink so
    // `on_closed` (target window disappears) surfaces as BackendFailed and
    // the partial MP4 finalizes cleanly (parity with macOS SCK delegate).
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
    let on_event_for_pump = on_event.clone();
    tokio::spawn(async move {
        while let Some(evt) = evt_rx.recv().await {
            let _ = on_event_for_pump.send(evt.into());
        }
    });

    let counter = capture::FallbackCounter::new();
    let (backend, outcome) = capture::orchestrate_start(
        preferred,
        cap_cfg.clone(),
        tx,
        Some(evt_tx.clone()),
        counter,
    )
    .await
    .map_err(|e| AppError::Capture(e.to_string()))?;

    // Emit a synthetic Started event (display name where applicable).
    if let capture::CaptureTarget::Display { display_id } = &target {
        if let Ok(displays) = enumerate_displays() {
            if let Some(d) = displays.into_iter().find(|d| d.id == *display_id) {
                let _ = on_event.send(CaptureEvent::Started { display: d }.into());
            }
        }
    }
    // Log fallback outcome so the UI can mirror it (the
    // WindowCaptureFellBack event has already been emitted by the
    // orchestrator for window targets).
    tracing::info!(?outcome, "capture started");

    // Forwarder task: pump frames to renderer, dropping the body.
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
            let _ = on_frame_clone.send(meta);
            drop(frame);
        }
    });
    let _ = on_frame;

    let _ = outcome;
    let session_id = Uuid::new_v4().to_string();
    let handle = SessionHandle {
        backend: tokio::sync::Mutex::new(backend),
        forward_task,
    };
    registry()
        .sessions
        .lock()
        .insert(session_id.clone(), handle);
    Ok(SessionId(session_id))
}

/// Plan 06-03 Task 3 — one-shot thumbnail capture for the recorder's
/// live-preview box. Returns PNG bytes; the renderer wraps them in a
/// `Blob`/`createObjectURL` for the `<img src>`.
///
/// Thumbnail failures are NON-FATAL from the UI's perspective — the
/// React component surfaces a neutral placeholder on any Err and never
/// unmounts the recorder view. We still emit a typed AppError for
/// debugging / telemetry.
///
/// `max_width` / `max_height` default to 320×200 when callers pass
/// `None` — matches the fixed UI frame size.
#[tauri::command]
#[specta::specta]
pub async fn capture_target_thumbnail(
    target: CaptureTargetDto,
    max_width: Option<u32>,
    max_height: Option<u32>,
) -> Result<Vec<u8>, AppError> {
    let max_w = max_width.unwrap_or(capture::thumbnail::DEFAULT_MAX_WIDTH);
    let max_h = max_height.unwrap_or(capture::thumbnail::DEFAULT_MAX_HEIGHT);
    // Clamp upper bound at 2× the default for HiDPI preview + protect
    // against renderer bugs flooding the native call with 4K requests.
    let max_w = max_w.min(capture::thumbnail::DEFAULT_MAX_WIDTH * 2);
    let max_h = max_h.min(capture::thumbnail::DEFAULT_MAX_HEIGHT * 2);
    let native_target: capture::CaptureTarget = target.into();
    capture::thumbnail::capture_thumbnail(&native_target, max_w, max_h)
        .await
        .map_err(|e| AppError::Capture(e.to_string()))
}

#[tauri::command]
#[specta::specta]
pub async fn get_capture_target(app: AppHandle) -> Result<Option<CaptureTargetDto>, AppError> {
    let settings = crate::commands::app_settings::load(&app);
    Ok(settings.capture_target.map(CaptureTargetDto::from))
}

#[tauri::command]
#[specta::specta]
pub async fn set_capture_target(
    app: AppHandle,
    target: CaptureTargetDto,
) -> Result<(), AppError> {
    let mut settings = crate::commands::app_settings::load(&app);
    settings.capture_target = Some(target.into());
    crate::commands::app_settings::save(&app, &settings)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capture_target_dto_round_trips_json() {
        let t = CaptureTargetDto::Window { window_id: 42 };
        let s = serde_json::to_string(&t).unwrap();
        let back: CaptureTargetDto = serde_json::from_str(&s).unwrap();
        match back {
            CaptureTargetDto::Window { window_id } => assert_eq!(window_id, 42),
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn window_id_validation_rejects_unknown() {
        // Populate the allow-list with id 100 only.
        {
            let mut ids = window_allow_list().ids.lock();
            ids.clear();
            ids.insert(100u64);
        }
        let ids = window_allow_list().ids.lock();
        assert!(ids.contains(&100));
        assert!(!ids.contains(&999));
    }

    #[tokio::test]
    async fn list_capture_targets_ipc_returns_struct() {
        // Can't fully exercise without Tauri runtime; shape-check only.
        let t = CaptureTargetsDto {
            displays: vec![],
            windows: vec![],
            playwright_auto_available: false,
        };
        let s = serde_json::to_string(&t).unwrap();
        assert!(s.contains("playwright_auto_available"));
    }

    #[test]
    fn capture_target_persistence_round_trips() {
        let t = capture::CaptureTarget::Window { window_id: capture::WindowId(7) };
        let dto: CaptureTargetDto = t.clone().into();
        let back: capture::CaptureTarget = dto.into();
        assert_eq!(t, back);
    }
}

