// automation IPC.
//
// `launch_automation` parses a story, starts the browser drivers, and
// forwards `ExecutorEvent`s to the renderer over a Tauri channel.

use crate::error::AppError;
use crate::state::AppState;
use automation::{
    BrowserSessionProfile, Executor, ExecutorEvent, LaunchOptions, NoopDriver,
    PlaywrightSidecarDriver, RunControl,
};
use serde::{Deserialize, Serialize};
use std::process::Stdio;
use std::sync::Arc;
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_shell::ShellExt;
use tokio::process::Command as TokioCommand;
use tokio::sync::Mutex;

/// Tauri / specta wrapper around `automation::ExecutorEvent`.
#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct AutomationEvent {
    /// JSON-stringified `automation::ExecutorEvent`.
    pub json: String,
}

impl From<ExecutorEvent> for AutomationEvent {
    fn from(e: ExecutorEvent) -> Self {
        AutomationEvent {
            json: serde_json::to_string(&e).unwrap_or_else(|_| "{}".into()),
        }
    }
}

/// Launch a story and stream events to the renderer.
#[tauri::command]
#[specta::specta]
#[tracing::instrument(
    level = "info",
    skip_all,
    fields(cmd = "launch_automation"),
    err(Debug)
)]
pub async fn launch_automation(
    app: AppHandle,
    state: State<'_, AppState>,
    story_source: String,
    project_folder: String,
    on_event: Channel<AutomationEvent>,
    chrome_hiding: Option<bool>,
    // Optional recording session to tear down when the story ends. When set,
    // the matching recording is stopped at the end of the event loop —
    // normal completion, error, or channel close — so the encoder sidecar
    // finalizes cleanly without depending on the UI.
    recording_session_id: Option<String>,
) -> Result<(), AppError> {
    tracing::info!(
        target: "storycapture::automation",
        story_bytes = story_source.len(),
        project_folder = %project_folder,
        recording_session_id = ?recording_session_id,
        "launch_automation invoked"
    );
    // Parse once and reuse the AST.
    let parse = story_parser::parse(&story_source);
    let story = match parse.ast {
        Some(ast) => {
            tracing::info!(
                target: "storycapture::automation",
                scenes = ast.scenes.len(),
                "story parsed"
            );
            ast
        }
        None => {
            tracing::error!(
                target: "storycapture::automation",
                diagnostics = ?parse.diagnostics,
                "story parse failed"
            );
            return Err(AppError::InvalidArgument("story parse failed".into()));
        }
    };

    // Build LaunchOptions locally.
    let settings = crate::commands::app_settings::load(&app);
    let browser_executable = settings
        .browser_executable
        .as_ref()
        .filter(|s| !s.is_empty())
        .map(std::path::PathBuf::from);
    let language_choice = crate::commands::app_settings::browser_language_choice(&settings);

    // Validate `meta.app` before adding app-hiding args.
    let app_url_for_hiding = if chrome_hiding == Some(true) {
        let app_url = story.meta.app.as_deref();
        let safe = match app_url {
            Some(raw) => match url::Url::parse(raw) {
                Ok(u) => matches!(u.scheme(), "http" | "https"),
                Err(_) => false,
            },
            None => false,
        };
        if safe {
            tracing::info!(
                target: "storycapture::automation",
                "chrome-hiding ON — LaunchConfig::from_meta will append --app=<meta.app>"
            );
            app_url.map(str::to_owned)
        } else {
            tracing::warn!(
                target: "storycapture::automation",
                "chrome-hiding requested but meta.app is missing or not http/https — ignored"
            );
            None
        }
    } else {
        None
    };

    // Open the project DB.
    let project_path = std::path::PathBuf::from(&project_folder);
    let project_db = storage::ProjectDb::open(&project_path).map_err(|e| {
        tracing::error!(target: "storycapture::automation", error = %e, "ProjectDb::open failed");
        e
    })?;
    tracing::info!(target: "storycapture::automation", "ProjectDb opened");

    // Resolve the screenshot dir.
    let screenshot_dir = project_path.join(storage::ASSETS_DIRNAME);
    std::fs::create_dir_all(&screenshot_dir).map_err(|e| {
        tracing::error!(target: "storycapture::automation", error = %e, dir = %screenshot_dir.display(), "create_dir_all failed");
        AppError::from(e)
    })?;
    tracing::info!(target: "storycapture::automation", "screenshot dir ready");

    // Resolve the Playwright sidecar via tauri-plugin-shell.
    tracing::info!(target: "storycapture::automation", "resolving playwright sidecar via tauri-plugin-shell");
    let sidecar = app
        .shell()
        .sidecar("playwright-sidecar")
        .map_err(|e| {
            tracing::error!(target: "storycapture::automation", error = %e, "shell.sidecar resolve failed");
            AppError::Automation(format!("sidecar resolve: {e}"))
        })?;
    drop(sidecar);
    let playwright = spawn_playwright_sidecar(&app).await.map_err(|e| {
        AppError::Automation(format!(
            "Playwright sidecar failed to spawn — check Node.js install and `scripts/playwright-sidecar` pnpm install. ({e})"
        ))
    })?;
    // Share the driver with the pid probe task.
    let shared_pw: Arc<Mutex<PlaywrightSidecarDriver>> = Arc::new(Mutex::new(playwright));
    // publish to AppState so the picker_* commands can issue
    // pickElement.* against the SAME sidecar instance the executor is
    // driving. Cleared at story end (after the executor channel closes).
    {
        let mut slot = state.playwright_driver.lock().await;
        *slot = Some(shared_pw.clone());
        tracing::info!(target: "storycapture::automation", "published shared Playwright driver to AppState (picker enabled)");
    }
    // Publish to preview_driver so `start_preview_stream` can attach the
    // CDP screencast to the same sidecar instance.
    {
        let mut slot = state.preview_driver.lock().await;
        *slot = Some(shared_pw.clone());
    }
    // wire the id-absent JSON-RPC notification forwarder
    // that bridges the sidecar's broadcast channel to a Tauri event
    // (`picker_hover_preview`). One forwarder per driver lifetime; the
    // task exits automatically when the broadcast channel closes (driver
    // dropped at story end).
    {
        let rx = {
            let d = shared_pw.lock().await;
            d.subscribe_notifications()
        };
        // spawn_notification_forwarder returns a JoinHandle; it lives for
        // the duration of the story run and is dropped on stop.
        let _forwarder = crate::commands::picker::spawn_notification_forwarder(app.clone(), rx);
        tracing::info!(target: "storycapture::automation", "spawned picker hover-preview forwarder");
    }
    // Exponential-backoff probe with a ~10s budget.
    playwright_pid_stash().set(None);
    playwright_first_paint_stash().set(false);
    {
        let probe_driver = shared_pw.clone();
        tokio::spawn(async move {
            let budget = std::time::Duration::from_secs(10);
            let deadline = std::time::Instant::now() + budget;
            let mut delay = std::time::Duration::from_millis(100);
            let cap = std::time::Duration::from_secs(1);
            let mut consecutive_errors: u32 = 0;
            while std::time::Instant::now() < deadline {
                tokio::time::sleep(delay).await;
                let result = {
                    let driver = probe_driver.lock().await;
                    driver.browser_process().await
                };
                match result {
                    Ok(info) => {
                        consecutive_errors = 0;
                        let remote = info.reason.as_deref() == Some("remote-browser");
                        let pid_resolved = info.pid.is_some();
                        let _ = playwright_pid_stash().set(Some(PlaywrightLaunchInfo {
                            pid: info.pid,
                            executable_path: info.executable_path,
                        }));
                        if remote || pid_resolved {
                            break;
                        }
                    }
                    Err(e) => {
                        consecutive_errors += 1;
                        tracing::debug!(
                            target: "storycapture::automation",
                            error = %e,
                            consecutive_errors,
                            "browser_process probe failed; will retry"
                        );
                        if consecutive_errors >= 3 {
                            tracing::warn!(
                                target: "storycapture::automation",
                                error = %e,
                                "browser_process probe gave up after 3 consecutive errors"
                            );
                            break;
                        }
                    }
                }
                delay = std::cmp::min(delay * 2, cap);
            }
        });
    }

    {
        let paint_driver = shared_pw.clone();
        tokio::spawn(async move {
            let launch_deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
            loop {
                if playwright_pid_stash().get().is_some() {
                    break;
                }
                if std::time::Instant::now() >= launch_deadline {
                    tracing::warn!(
                        target: "storycapture::automation",
                        "wait_for_first_paint skipped: pid never resolved within budget"
                    );
                    return;
                }
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
            let info = playwright_pid_stash().get();
            if info.as_ref().and_then(|i| i.pid).is_none() {
                return;
            }
            let driver = paint_driver.lock().await;
            match driver.wait_for_first_paint(10_000).await {
                Ok(()) => {
                    playwright_first_paint_stash().set(true);
                    tracing::info!(
                        target: "storycapture::automation",
                        "Playwright first paint signaled — SCK attach is now unblocked"
                    );
                }
                Err(e) => {
                    tracing::warn!(
                        target: "storycapture::automation",
                        error = %e,
                        "wait_for_first_paint failed; start_recording will fall back to pre-260418-fpr behavior"
                    );
                }
            }
        });
    }

    let primary: Box<dyn automation::BrowserDriver> =
        Box::new(crate::commands::automation_shared::SharedPlaywrightDriver::new(shared_pw));
    let fallback: Box<dyn automation::BrowserDriver> = Box::new(NoopDriver::new());

    let browser_session_profile = refresh_latest_browser_session_profile(&state).await;
    let launch_opts = LaunchOptions {
        browser_executable,
        app_url_for_hiding,
        language_choice,
        browser_session_profile,
    };

    let persistence = Some(Arc::new(Mutex::new(project_db)) as automation::PersistenceHandle);
    let control = Arc::new(RunControl::new());
    set_active_run_control(Some(control.clone()));

    // The recording path is read-only against `.story.targets.json` —
    // self_heal=false. A primary-miss raises `PrimaryMissNoHeal` which the
    // HUD surfaces with "Open in Simulator". The record path never consults
    // the targets sidecar, so `story_path` stays `None` (no harm if present
    // — the self_heal=false gate short-circuits before the sidecar is read).
    tracing::info!(target: "storycapture::automation", "Executor::run_with_story_path starting (self_heal=false)");
    let mut events = Executor::run_with_story_path(
        story,
        /* story_path */ None,
        primary,
        fallback,
        persistence,
        screenshot_dir,
        launch_opts,
        Some(control.clone()),
        /* self_heal */ false,
    );
    while let Some(evt) = events.recv().await {
        // Mirror events into tracing for diagnostics.
        let truncate_at = match &evt {
            automation::ExecutorEvent::StepFailed { .. }
            | automation::ExecutorEvent::StoryEnded { .. } => 4000,
            _ => 400,
        };
        let evt_dbg = format!("{:?}", evt);
        tracing::info!(
            target: "storycapture::automation",
            event = %&evt_dbg.chars().take(truncate_at).collect::<String>(),
            "executor event"
        );
        if let Err(e) = on_event.send(AutomationEvent::from(evt)) {
            tracing::warn!(target: "storycapture::automation", "channel send failed: {e}");
            break;
        }
    }
    tracing::info!(target: "storycapture::automation", "Executor channel closed (story ended)");
    clear_active_run_control(&control);
    // Clear the stash when the story ends.
    playwright_pid_stash().set(None);
    playwright_first_paint_stash().set(false);
    // Preview teardown precedes automation teardown so the pump task's
    // watch-channel exits cleanly. Preview failure here does not propagate
    // (intentional isolation).
    stop_preview_stream_inner(&state).await;
    {
        let mut slot = state.preview_driver.lock().await;
        *slot = None;
    }
    // drop the shared driver handle so the picker disables
    // until the next launch.
    {
        let mut slot = state.playwright_driver.lock().await;
        *slot = None;
    }

    // Auto-stop the attached recording so the encoder sidecar doesn't wait
    // on the UI to call stop_recording. Uses the same RecorderHandle shape
    // the SessionActor will consume.
    if let Some(sid) = recording_session_id {
        use automation::RecorderHandle as _;
        let handle = crate::commands::encode::TauriRecorderHandle::new(sid.clone());
        match handle.stop().await {
            Ok(()) => tracing::info!(
                target: "storycapture::automation",
                session = %sid,
                "auto-stopped attached recording at story end"
            ),
            Err(e) => tracing::warn!(
                target: "storycapture::automation",
                session = %sid,
                error = %e,
                "auto-stop of attached recording failed"
            ),
        }
    }

    Ok(())
}

fn active_run_control() -> &'static parking_lot::Mutex<Option<Arc<RunControl>>> {
    use std::sync::OnceLock;
    static ACTIVE: OnceLock<parking_lot::Mutex<Option<Arc<RunControl>>>> = OnceLock::new();
    ACTIVE.get_or_init(|| parking_lot::Mutex::new(None))
}

fn set_active_run_control(control: Option<Arc<RunControl>>) {
    *active_run_control().lock() = control;
}

fn clear_active_run_control(expected: &Arc<RunControl>) {
    let mut guard = active_run_control().lock();
    if guard
        .as_ref()
        .is_some_and(|current| Arc::ptr_eq(current, expected))
    {
        *guard = None;
    }
}

pub(crate) async fn refresh_latest_browser_session_profile(
    state: &AppState,
) -> Option<BrowserSessionProfile> {
    let stream_id = state.active_author_stream_id.lock().await.clone()?;
    let driver = {
        let sessions = state.author_preview_sessions.lock().await;
        sessions
            .get(&stream_id)
            .map(|session| session.driver.clone())
    }?;
    match driver.call_author_session_profile(&stream_id).await {
        Ok(profile) => {
            *state.latest_browser_session_profile.lock().await = Some(profile.clone());
            Some(profile)
        }
        Err(err) => {
            tracing::warn!(
                target: "storycapture::automation",
                stream_id = %stream_id,
                error = %err,
                "failed to export author browser session profile; recording will continue without refreshed profile"
            );
            state.latest_browser_session_profile.lock().await.clone()
        }
    }
}

async fn export_and_store_author_profile(
    state: &AppState,
    stream_id: &str,
    driver: &PlaywrightSidecarDriver,
    viewport: Option<(u32, u32)>,
) -> Option<BrowserSessionProfile> {
    match driver.call_author_session_profile(stream_id).await {
        Ok(mut profile) => {
            if let Some((width, height)) = viewport {
                profile.viewport = Some(story_parser::Viewport { width, height });
            }
            *state.latest_browser_session_profile.lock().await = Some(profile.clone());
            Some(profile)
        }
        Err(err) => {
            tracing::warn!(
                target: "storycapture::automation",
                stream_id = %stream_id,
                error = %err,
                "failed to export author browser session profile"
            );
            None
        }
    }
}

pub(crate) fn pause_active_automation() {
    if let Some(control) = active_run_control().lock().clone() {
        control.pause();
    }
}

pub(crate) fn resume_active_automation() {
    if let Some(control) = active_run_control().lock().clone() {
        control.resume();
    }
}

// ──────────────────────────────────────────────────────────────────────
// Live preview pump (Rust → `preview://frame` event)
// ──────────────────────────────────────────────────────────────────────

/// Start the CDP screencast and pump decoded frames into a Tauri event.
///
/// Returns `UnavailableOnBackend` when no Playwright driver is registered
/// with `AppState::preview_driver` — the frontend uses this to fall back
/// to the static preview stage. A second invocation aborts any prior
/// pump task so frames are not double-emitted.
#[tauri::command]
#[specta::specta]
#[tracing::instrument(
    level = "info",
    skip_all,
    fields(cmd = "start_preview_stream"),
    err(Debug)
)]
pub async fn start_preview_stream(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), AppError> {
    let shared = {
        let guard = state.preview_driver.lock().await;
        guard
            .clone()
            .ok_or_else(|| AppError::UnavailableOnBackend("no active Playwright session".into()))?
    };

    {
        let driver = shared.lock().await;
        driver
            .call_preview_start()
            .await
            .map_err(|e| AppError::Automation(e.to_string()))?;
    }

    if let Some(prev) = state.preview_pump.lock().await.take() {
        prev.abort();
    }

    let mut rx = { shared.lock().await.subscribe_preview() };
    let app_for_emit = app.clone();
    // Drop-counter + periodic window log. watch::changed() already coalesces
    // multiple sends into one wake, so drop_count here tracks emit failures,
    // not sidecar-level backpressure (that lives on sidecar
    // state.previewDropCount). Env-tunable window length for tests.
    let log_interval = std::time::Duration::from_secs(
        std::env::var("PREVIEW_PUMP_LOG_SECS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(30),
    );
    let handle = tokio::spawn(async move {
        let mut drop_count: u64 = 0;
        let mut last_log = tokio::time::Instant::now();
        while rx.changed().await.is_ok() {
            let snapshot = rx.borrow_and_update().clone();
            if let Some(frame) = snapshot {
                if let Err(err) = app_for_emit.emit("preview://frame", &frame) {
                    tracing::warn!(target: "storycapture::preview", error = %err, "preview emit failed");
                    drop_count += 1;
                }
            }
            if last_log.elapsed() >= log_interval {
                if drop_count > 0 {
                    tracing::warn!(
                        target: "storycapture::preview",
                        dropped = drop_count,
                        "preview frames dropped in window"
                    );
                }
                drop_count = 0;
                last_log = tokio::time::Instant::now();
            }
        }
        tracing::debug!(target: "storycapture::preview", "preview pump exited (sender dropped)");
    });
    *state.preview_pump.lock().await = Some(handle);
    Ok(())
}

/// Stop the preview pump and instruct the sidecar to end the CDP
/// screencast. Idempotent — a second call without an active stream is a
/// no-op. Preview-stop errors are swallowed (CLAUDE.md: intentional
/// isolation — preview lifecycle MUST NOT cascade into recording).
#[tauri::command]
#[specta::specta]
#[tracing::instrument(
    level = "info",
    skip_all,
    fields(cmd = "stop_preview_stream"),
    err(Debug)
)]
pub async fn stop_preview_stream(state: State<'_, AppState>) -> Result<(), AppError> {
    stop_preview_stream_inner(&state).await;
    Ok(())
}

/// Shared teardown used by both the Tauri command and the
/// recording-lifecycle hook so preview always stops before automation.
pub(crate) async fn stop_preview_stream_inner(state: &AppState) {
    if let Some(h) = state.preview_pump.lock().await.take() {
        h.abort();
    }
    let shared_opt = state.preview_driver.lock().await.clone();
    if let Some(shared) = shared_opt {
        let driver = shared.lock().await;
        if let Err(e) = driver.call_preview_stop().await {
            tracing::debug!(
                target: "storycapture::automation",
                error = %e,
                "preview stop returned error during teardown (best-effort, ignored)"
            );
        }
    }
}

// ──────────────────────────────────────────────────────────────────────
// Author-time preview sessions
//
// Separate Playwright sidecar per editor-surface preview streamId. Never
// reuses the recording driver. `attach_author_driver(streamId)` hands back
// the driver handle so the simulator can run DSL verbs against the same
// session without a third Chromium instance.
// ──────────────────────────────────────────────────────────────────────

async fn author_driver(
    state: &AppState,
    stream_id: &str,
) -> Result<Arc<PlaywrightSidecarDriver>, AppError> {
    let sessions = state.author_preview_sessions.lock().await;
    sessions
        .get(stream_id)
        .map(|s| s.driver.clone())
        .ok_or_else(|| AppError::InvalidArgument(format!("unknown author stream: {stream_id}")))
}

/// Spawn a Playwright sidecar child process and wrap it as a driver. Shared
/// by `launch_automation` and `start_author_preview`.
async fn spawn_playwright_sidecar(app: &AppHandle) -> Result<PlaywrightSidecarDriver, AppError> {
    let sidecar_path = match crate::commands::encode::resolve_sidecar_path("playwright-sidecar") {
        Ok(p) => p,
        Err(e) => {
            tracing::warn!(target: "storycapture::automation", "playwright sidecar path unresolved ({e}); falling back to PATH lookup");
            std::path::PathBuf::from("playwright-sidecar")
        }
    };
    tracing::info!(
        target: "storycapture::automation",
        sidecar_path = %sidecar_path.display(),
        "spawning playwright sidecar"
    );
    let modules_dir = app
        .path()
        .resource_dir()
        .ok()
        .map(|r| r.join("binaries").join("playwright-sidecar-modules"));
    let mut tokio_cmd = TokioCommand::new(&sidecar_path);
    tokio_cmd
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(dir) = modules_dir.as_ref() {
        tracing::info!(
            target: "storycapture::automation",
            modules_dir = %dir.display(),
            "setting STORYCAPTURE_SIDECAR_MODULES for sidecar"
        );
        tokio_cmd.env("STORYCAPTURE_SIDECAR_MODULES", dir);
    }
    let mut child = tokio_cmd
        .spawn()
        .map_err(|e| AppError::Automation(format!("sidecar spawn: {e}")))?;
    if let Some(stderr) = child.stderr.take() {
        tokio::spawn(async move {
            use tokio::io::{AsyncBufReadExt, BufReader};
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                tracing::warn!(target: "storycapture::automation", sidecar_stderr = %line);
            }
        });
    }
    PlaywrightSidecarDriver::from_child(child)
        .map_err(|e| AppError::Automation(format!("sidecar wrap: {e}")))
}

/// Arguments for the editor-surface viewport switcher.
#[derive(Debug, Deserialize, specta::Type)]
pub struct AuthorViewportArgs {
    pub width: u32,
    pub height: u32,
}

/// Spawn an ephemeral author-time Playwright session and start its CDP
/// screencast. Returns the generated streamId; frontend binds
/// `<LivePreview streamId=... />` to the matching `preview://frame` events.
///
/// `initial_url` is usually `story.meta.app`; `None` launches on
/// about:blank and caller-side state stays happy for missing meta.app.
#[tauri::command]
#[specta::specta]
#[tracing::instrument(
    level = "info",
    skip_all,
    fields(cmd = "start_author_preview"),
    err(Debug)
)]
pub async fn start_author_preview(
    app: AppHandle,
    state: State<'_, AppState>,
    initial_url: Option<String>,
    viewport_width: Option<u32>,
    viewport_height: Option<u32>,
) -> Result<String, AppError> {
    let stream_id = format!("author-{}", uuid::Uuid::new_v4());
    let settings = crate::commands::app_settings::load(&app);
    let browser_environment =
        crate::commands::app_settings::browser_language_choice(&settings).browser_environment();
    // No outer Mutex: all driver methods take `&self` with internal fine-
    // grained locking, so concurrent callers (picker + LivePreview canvas
    // input forwarder) don't serialize.
    let driver_arc: Arc<PlaywrightSidecarDriver> = Arc::new(spawn_playwright_sidecar(&app).await?);

    // Spawn + load URL + start screencast under this streamId.
    {
        let vp = match (viewport_width, viewport_height) {
            (Some(w), Some(h)) if w > 0 && h > 0 => Some((w, h)),
            _ => Some((1280u32, 800u32)),
        };
        driver_arc
            .call_author_launch(&stream_id, initial_url.as_deref(), vp, &browser_environment)
            .await
            .map_err(|e| AppError::Automation(format!("author.launch: {e}")))?;
        driver_arc
            .call_preview_start_stream(&stream_id)
            .await
            .map_err(|e| AppError::Automation(format!("startPreviewStream: {e}")))?;
        *state.active_author_stream_id.lock().await = Some(stream_id.clone());
        let app_for_profile = app.clone();
        let driver_for_profile = driver_arc.clone();
        let stream_id_for_profile = stream_id.clone();
        tokio::spawn(async move {
            let state_for_profile = app_for_profile.state::<AppState>();
            let _ = export_and_store_author_profile(
                &state_for_profile,
                &stream_id_for_profile,
                &driver_for_profile,
                vp,
            )
            .await;
        });
    }

    // Each author session owns its own sidecar + watch channel, so every
    // frame delivered here already belongs to this stream. Emit on a
    // per-stream Tauri event so the webview can listen without payload-side
    // demuxing — one channel per session, one listener per component.
    let mut rx = driver_arc.subscribe_preview();
    let app_for_emit = app.clone();
    let event_name = format!("preview://frame/{stream_id}");
    let stream_id_for_log = stream_id.clone();
    let pump = tokio::spawn(async move {
        while rx.changed().await.is_ok() {
            let snapshot = rx.borrow_and_update().clone();
            if let Some(frame) = snapshot {
                if let Err(err) = app_for_emit.emit(&event_name, &frame) {
                    tracing::warn!(
                        target: "storycapture::preview",
                        error = %err,
                        stream_id = %stream_id_for_log,
                        "author preview emit failed"
                    );
                }
            }
        }
    });

    // Nav-state pump. Sidecar broadcasts every session's snapshot on the
    // same channel; filter by stream_id so cross-session listeners stay
    // isolated. Per-stream Tauri event mirrors the frame channel.
    let mut nav_rx = driver_arc.subscribe_nav();
    let app_for_nav = app.clone();
    let nav_event_name = format!("preview://nav/{stream_id}");
    let nav_stream_id = stream_id.clone();
    let nav_pump = tokio::spawn(async move {
        while nav_rx.changed().await.is_ok() {
            let snapshot = nav_rx.borrow_and_update().clone();
            let Some(snap) = snapshot else { continue };
            if snap.stream_id != nav_stream_id {
                continue;
            }
            let payload = AuthorPreviewNavPayload {
                stream_id: snap.stream_id,
                url: snap.url,
                can_go_back: snap.can_go_back,
                can_go_forward: snap.can_go_forward,
            };
            if let Err(err) = app_for_nav.emit(&nav_event_name, &payload) {
                tracing::warn!(
                    target: "storycapture::preview",
                    error = %err,
                    stream_id = %nav_stream_id,
                    "author preview nav emit failed"
                );
            }
        }
    });

    let mut sessions = state.author_preview_sessions.lock().await;
    sessions.insert(
        stream_id.clone(),
        crate::state::AuthorPreviewSession {
            driver: driver_arc,
            pump: Some(pump),
            nav_pump: Some(nav_pump),
        },
    );
    Ok(stream_id)
}

/// Teardown an ephemeral author-time session. Idempotent.
#[tauri::command]
#[specta::specta]
#[tracing::instrument(
    level = "info",
    skip_all,
    fields(cmd = "stop_author_preview"),
    err(Debug)
)]
pub async fn stop_author_preview(
    state: State<'_, AppState>,
    stream_id: String,
) -> Result<(), AppError> {
    {
        let mut active = state.active_author_stream_id.lock().await;
        if active.as_deref() == Some(stream_id.as_str()) {
            *active = None;
            *state.latest_browser_session_profile.lock().await = None;
        }
    }
    let session_opt = {
        let mut sessions = state.author_preview_sessions.lock().await;
        sessions.remove(&stream_id)
    };
    if let Some(mut session) = session_opt {
        if let Some(pump) = session.pump.take() {
            pump.abort();
        }
        if let Some(pump) = session.nav_pump.take() {
            pump.abort();
        }
        if let Err(e) = session.driver.call_preview_stop_stream(&stream_id).await {
            tracing::debug!(
                target: "storycapture::automation",
                stream_id = %stream_id,
                error = %e,
                "author preview stop_stream returned error during teardown (best-effort)"
            );
        }
        if let Err(e) = session.driver.call_author_close(&stream_id).await {
            tracing::debug!(
                target: "storycapture::automation",
                stream_id = %stream_id,
                error = %e,
                "author preview close returned error during teardown (best-effort)"
            );
        }
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
#[tracing::instrument(
    level = "info",
    skip_all,
    fields(cmd = "pause_author_preview"),
    err(Debug)
)]
pub async fn pause_author_preview(
    state: State<'_, AppState>,
    stream_id: String,
) -> Result<(), AppError> {
    let driver = author_driver(&state, &stream_id).await?;
    driver
        .call_pause_stream(&stream_id)
        .await
        .map_err(|e| AppError::Automation(e.to_string()))?;
    Ok(())
}

#[tauri::command]
#[specta::specta]
#[tracing::instrument(
    level = "info",
    skip_all,
    fields(cmd = "resume_author_preview"),
    err(Debug)
)]
pub async fn resume_author_preview(
    state: State<'_, AppState>,
    stream_id: String,
) -> Result<(), AppError> {
    let driver = author_driver(&state, &stream_id).await?;
    driver
        .call_resume_stream(&stream_id)
        .await
        .map_err(|e| AppError::Automation(e.to_string()))?;
    Ok(())
}

#[tauri::command]
#[specta::specta]
// Trace level: caller can pump on every viewport tween frame; an
// info-level entry per call would dominate the log.
#[tracing::instrument(
    level = "trace",
    skip_all,
    fields(cmd = "set_author_preview_viewport"),
    err(Debug)
)]
pub async fn set_author_preview_viewport(
    state: State<'_, AppState>,
    stream_id: String,
    args: AuthorViewportArgs,
) -> Result<(), AppError> {
    let driver = author_driver(&state, &stream_id).await?;
    driver
        .call_author_set_viewport(&stream_id, args.width, args.height)
        .await
        .map_err(|e| AppError::Automation(e.to_string()))?;
    Ok(())
}

/// Navigate a live author-preview session to a new URL without relaunch.
/// Caller must pass an http(s) URL; the sidecar re-validates and rejects
/// otherwise.
#[tauri::command]
#[specta::specta]
#[tracing::instrument(
    level = "info",
    skip_all,
    fields(cmd = "set_author_preview_url"),
    err(Debug)
)]
pub async fn set_author_preview_url(
    state: State<'_, AppState>,
    stream_id: String,
    url: String,
) -> Result<(), AppError> {
    let driver = author_driver(&state, &stream_id).await?;
    driver
        .call_author_goto(&stream_id, &url)
        .await
        .map_err(|e| AppError::Automation(e.to_string()))?;
    Ok(())
}

/// Payload of `preview://nav/<streamId>` Tauri events. Mirrors the sidecar's
/// `preview/nav` JSON-RPC notification one-for-one.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AuthorPreviewNavPayload {
    pub stream_id: String,
    pub url: String,
    pub can_go_back: bool,
    pub can_go_forward: bool,
}

/// URL-bar Back. No-op when at history index 0.
#[tauri::command]
#[specta::specta]
#[tracing::instrument(
    level = "info",
    skip_all,
    fields(cmd = "author_preview_back"),
    err(Debug)
)]
pub async fn author_preview_back(
    state: State<'_, AppState>,
    stream_id: String,
) -> Result<(), AppError> {
    let driver = author_driver(&state, &stream_id).await?;
    driver
        .call_author_back(&stream_id)
        .await
        .map_err(|e| AppError::Automation(e.to_string()))?;
    Ok(())
}

/// URL-bar Forward. No-op when forward stack is empty.
#[tauri::command]
#[specta::specta]
#[tracing::instrument(
    level = "info",
    skip_all,
    fields(cmd = "author_preview_forward"),
    err(Debug)
)]
pub async fn author_preview_forward(
    state: State<'_, AppState>,
    stream_id: String,
) -> Result<(), AppError> {
    let driver = author_driver(&state, &stream_id).await?;
    driver
        .call_author_forward(&stream_id)
        .await
        .map_err(|e| AppError::Automation(e.to_string()))?;
    Ok(())
}

/// URL-bar Reload. Always re-emits a `preview/nav` notification.
#[tauri::command]
#[specta::specta]
#[tracing::instrument(
    level = "info",
    skip_all,
    fields(cmd = "author_preview_reload"),
    err(Debug)
)]
pub async fn author_preview_reload(
    state: State<'_, AppState>,
    stream_id: String,
) -> Result<(), AppError> {
    let driver = author_driver(&state, &stream_id).await?;
    driver
        .call_author_reload(&stream_id)
        .await
        .map_err(|e| AppError::Automation(e.to_string()))?;
    Ok(())
}

/// Renderer-side pointer events from the LivePreview canvas, forwarded
/// into the headless author browser via Playwright's `page.mouse` API.
/// Coordinates are in page viewport space (the renderer transforms canvas
/// px → page px before calling).
#[derive(Debug, Clone, Deserialize, Serialize, specta::Type)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum AuthorInputEvent {
    Mousemove {
        x: f64,
        y: f64,
    },
    Click {
        x: f64,
        y: f64,
        #[serde(default)]
        button: AuthorMouseButton,
    },
    Wheel {
        x: f64,
        y: f64,
        #[serde(rename = "deltaX")]
        delta_x: f64,
        #[serde(rename = "deltaY")]
        delta_y: f64,
    },
    Keydown {
        key: String,
        code: String,
        #[serde(default)]
        modifiers: AuthorKeyModifiers,
        #[serde(default)]
        repeat: bool,
    },
    Keyup {
        key: String,
        code: String,
        #[serde(default)]
        modifiers: AuthorKeyModifiers,
    },
    Text {
        text: String,
    },
}

#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AuthorKeyModifiers {
    #[serde(default)]
    pub shift: bool,
    #[serde(default)]
    pub ctrl: bool,
    #[serde(default)]
    pub alt: bool,
    #[serde(default)]
    pub meta: bool,
}

#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum AuthorMouseButton {
    #[default]
    Left,
    Right,
    Middle,
}

/// Forward a pointer/wheel event from the LivePreview canvas into the
/// headless author browser. No-op if the session has been torn down.
#[tauri::command]
#[specta::specta]
// Trace level: up to 60 Hz under hover; would otherwise drown the log.
#[tracing::instrument(
    level = "trace",
    skip_all,
    fields(cmd = "author_dispatch_input"),
    err(Debug)
)]
pub async fn author_dispatch_input(
    state: State<'_, AppState>,
    stream_id: String,
    event: AuthorInputEvent,
) -> Result<(), AppError> {
    // INFO on click/wheel (rare, diagnostic-worthy), DEBUG on mousemove
    // (fires at 60 Hz — would flood the log at INFO).
    match &event {
        AuthorInputEvent::Click { x, y, button } => {
            tracing::info!(
                target: "storycapture::automation",
                stream_id = %stream_id,
                x = *x, y = *y, button = ?button,
                "author_dispatch_input click"
            );
        }
        AuthorInputEvent::Wheel {
            x,
            y,
            delta_x,
            delta_y,
        } => {
            tracing::info!(
                target: "storycapture::automation",
                stream_id = %stream_id,
                x = *x, y = *y, dx = *delta_x, dy = *delta_y,
                "author_dispatch_input wheel"
            );
        }
        AuthorInputEvent::Mousemove { x, y } => {
            // DEBUG-only: mousemove fires at 60 Hz and would flood INFO.
            // Enable via RUST_LOG=storycapture::automation=debug when
            // diagnosing a frontend→Rust forwarding gap.
            tracing::debug!(
                target: "storycapture::automation",
                stream_id = %stream_id,
                x = *x, y = *y,
                "author_dispatch_input mousemove"
            );
        }
        AuthorInputEvent::Keydown {
            key, code, repeat, ..
        } => {
            let is_modifier = matches!(key.as_str(), "Shift" | "Control" | "Alt" | "Meta")
                || code.starts_with("Shift")
                || code.starts_with("Control")
                || code.starts_with("Alt")
                || code.starts_with("Meta");
            if is_modifier {
                tracing::info!(
                    target: "storycapture::automation",
                    stream_id = %stream_id,
                    key = %key, code = %code, repeat = *repeat,
                    "author_dispatch_input keydown (modifier)"
                );
            } else {
                tracing::debug!(
                    target: "storycapture::automation",
                    stream_id = %stream_id,
                    key = %key, code = %code, repeat = *repeat,
                    "author_dispatch_input keydown"
                );
            }
        }
        AuthorInputEvent::Keyup { key, code, .. } => {
            tracing::debug!(
                target: "storycapture::automation",
                stream_id = %stream_id,
                key = %key, code = %code,
                "author_dispatch_input keyup"
            );
        }
        AuthorInputEvent::Text { text } => {
            // Privacy: log length only — user may be typing a password.
            tracing::info!(
                target: "storycapture::automation",
                stream_id = %stream_id,
                len = text.chars().count(),
                "author_dispatch_input text"
            );
        }
    }
    let driver = author_driver(&state, &stream_id).await?;
    let payload = serde_json::to_value(&event).map_err(|e| AppError::Automation(e.to_string()))?;
    let result = driver
        .call_author_dispatch_input(&stream_id, &payload)
        .await
        .map_err(|e| AppError::Automation(e.to_string()));
    if let Err(e) = &result {
        tracing::warn!(
            target: "storycapture::automation",
            stream_id = %stream_id,
            error = %e,
            "author_dispatch_input sidecar call failed"
        );
    }
    result
}

/// Readiness probe: confirms streamId is registered + sidecar is alive.
#[tauri::command]
#[specta::specta]
#[tracing::instrument(
    level = "info",
    skip_all,
    fields(cmd = "attach_author_driver"),
    err(Debug)
)]
pub async fn attach_author_driver(
    state: State<'_, AppState>,
    stream_id: String,
) -> Result<(), AppError> {
    let driver = author_driver(&state, &stream_id).await?;
    driver
        .pick_element_is_active()
        .await
        .map_err(|e| AppError::Automation(format!("attach_author_driver probe: {e}")))?;
    Ok(())
}

// ──────────────────────────────────────────────────────────────────────
// resolve_playwright_target + pid stash
// ──────────────────────────────────────────────────────────────────────

/// Per-process stash of the latest Playwright launch info.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlaywrightLaunchInfo {
    pub pid: Option<i32>,
    pub executable_path: Option<String>,
}

pub struct PlaywrightPidStash(parking_lot::Mutex<Option<PlaywrightLaunchInfo>>);
impl PlaywrightPidStash {
    /// Store a new value and report whether it changed.
    pub fn set(&self, v: Option<PlaywrightLaunchInfo>) -> bool {
        let mut guard = self.0.lock();
        if *guard == v {
            return false;
        }
        *guard = v;
        true
    }
    pub fn get(&self) -> Option<PlaywrightLaunchInfo> {
        self.0.lock().clone()
    }
}

pub(crate) fn playwright_pid_stash() -> &'static PlaywrightPidStash {
    use std::sync::OnceLock;
    static STASH: OnceLock<PlaywrightPidStash> = OnceLock::new();
    STASH.get_or_init(|| PlaywrightPidStash(parking_lot::Mutex::new(None)))
}

pub struct PlaywrightFirstPaintStash(std::sync::atomic::AtomicBool);
impl PlaywrightFirstPaintStash {
    pub fn set(&self, v: bool) {
        self.0.store(v, std::sync::atomic::Ordering::SeqCst);
    }
    pub fn get(&self) -> bool {
        self.0.load(std::sync::atomic::Ordering::SeqCst)
    }
}

pub(crate) fn playwright_first_paint_stash() -> &'static PlaywrightFirstPaintStash {
    use std::sync::OnceLock;
    static STASH: OnceLock<PlaywrightFirstPaintStash> = OnceLock::new();
    STASH.get_or_init(|| PlaywrightFirstPaintStash(std::sync::atomic::AtomicBool::new(false)))
}

/// Test-only helper to inject a pid.
#[cfg(test)]
pub(crate) fn __test_set_playwright_pid(info: Option<PlaywrightLaunchInfo>) {
    playwright_pid_stash().set(info);
}

/// Resolve the current Playwright auto-target to a window id.
#[tauri::command]
#[specta::specta]
#[tracing::instrument(
    level = "info",
    skip_all,
    fields(cmd = "resolve_playwright_target"),
    err(Debug)
)]
pub async fn resolve_playwright_target(
    state: State<'_, AppState>,
) -> Result<Option<ResolvedPlaywrightTarget>, AppError> {
    let info = match playwright_pid_stash().get() {
        Some(i) => i,
        None => return Ok(None),
    };
    let Some(pid) = info.pid else {
        // Remote-browser or similar: keep the auto target disabled.
        return Ok(None);
    };
    let content_crop = resolve_playwright_content_crop(&state).await;

    #[cfg(target_os = "macos")]
    {
        let resolved = capture::macos::window::find_window_by_pid_with_frame(pid, None)
            .await
            .map_err(|e| AppError::Capture(e.to_string()))?;
        let Some((window_id, frame_w, frame_h)) = resolved else {
            return Ok(None);
        };
        // No retina multiplication — must match sck_backend.rs which
        // configures the stream canvas at the raw frame dimensions.
        // Multiplying here would give the encoder display-scale dims
        // while SCK streams at window-scale → black padding.
        let width_px = frame_w as u32;
        let height_px = frame_h as u32;
        Ok(Some(ResolvedPlaywrightTarget {
            window_id: window_id.0,
            pid,
            width_px,
            height_px,
            content_crop,
        }))
    }
    #[cfg(target_os = "windows")]
    {
        let hwnd = capture::windows::window::find_window_by_pid(pid, None)
            .await
            .map_err(|e| AppError::Capture(e.to_string()))?;
        let Some(hwnd) = hwnd else {
            return Ok(None);
        };
        // TODO: read GetWindowRect(hwnd) here; for now the frontend falls
        // back to display dims on Windows, which is OK because WGC does NOT
        // exhibit the same black-padding behavior (it sizes the output
        // surface to the GraphicsCaptureItem).
        Ok(Some(ResolvedPlaywrightTarget {
            window_id: hwnd as u64,
            pid,
            width_px: 0,
            height_px: 0,
            content_crop,
        }))
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = pid;
        Ok(None)
    }
}

async fn resolve_playwright_content_crop(
    state: &State<'_, AppState>,
) -> Option<ResolvedFrameCropDto> {
    let driver = { state.playwright_driver.lock().await.clone() }?;
    let result = {
        let driver = driver.lock().await;
        driver.page_content_crop().await
    };
    match result {
        Ok(info) => {
            tracing::info!(
                target: "storycapture::automation",
                crop_x = info.crop.x,
                crop_y = info.crop.y,
                crop_w = info.crop.w,
                crop_h = info.crop.h,
                crop_basis_w = info.crop.basis_w,
                crop_basis_h = info.crop.basis_h,
                inner_w = info.metrics.inner_width,
                inner_h = info.metrics.inner_height,
                outer_w = info.metrics.outer_width,
                outer_h = info.metrics.outer_height,
                dpr = info.metrics.device_pixel_ratio,
                "resolve_playwright_target: browser content crop resolved"
            );
            Some(ResolvedFrameCropDto {
                x: info.crop.x,
                y: info.crop.y,
                w: info.crop.w,
                h: info.crop.h,
                basis_w: info.crop.basis_w,
                basis_h: info.crop.basis_h,
            })
        }
        Err(error) => {
            tracing::warn!(
                target: "storycapture::automation",
                %error,
                "resolve_playwright_target: browser content crop unavailable"
            );
            None
        }
    }
}

/// Read macOS Stage Manager's global-enable flag.
///
/// Stage Manager (macOS 13+) groups windows into per-app "stages" and stops
/// compositing off-stage windows, which silently breaks SCK window-target
/// capture. We surface this as a pre-flight warning in the Recorder UI so
/// users understand why recording another app blacks out — the workaround
/// is to disable Stage Manager in Control Centre, matching Screen Studio's
/// and CleanShot X's UX. Returns `false` on non-macOS platforms.
#[tauri::command]
#[specta::specta]
#[tracing::instrument(
    level = "info",
    skip_all,
    fields(cmd = "is_stage_manager_enabled"),
    err(Debug)
)]
pub async fn is_stage_manager_enabled() -> Result<bool, AppError> {
    #[cfg(target_os = "macos")]
    {
        // `defaults read com.apple.WindowManager GloballyEnabled` — the
        // de-facto stable key used by Raycast/Alfred/BetterTouchTool. No
        // entitlement needed; works sandboxed or not.
        let output = tokio::process::Command::new("defaults")
            .args(["read", "com.apple.WindowManager", "GloballyEnabled"])
            .output()
            .await
            .map_err(|e| AppError::Capture(format!("defaults read failed: {e}")))?;
        if !output.status.success() {
            // Key not set on this user — Stage Manager has never been
            // toggled, so effectively off.
            return Ok(false);
        }
        let s = String::from_utf8_lossy(&output.stdout);
        Ok(s.trim() == "1")
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(false)
    }
}

/// Returned by `resolve_playwright_target`.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct ResolvedPlaywrightTarget {
    pub window_id: u64,
    pub pid: i32,
    /// Window pixel width (retina-scaled on macOS). `0` when unknown
    /// (Windows path currently doesn't populate this — renderer treats 0
    /// as "fall back to display dims").
    pub width_px: u32,
    /// Window pixel height (retina-scaled on macOS). See `width_px`.
    pub height_px: u32,
    /// Frame-relative crop for the page viewport within the captured browser
    /// window. `basis_w/h` allow the capture layer to scale logical browser
    /// measurements to Retina/DPI-scaled native frames.
    pub content_crop: Option<ResolvedFrameCropDto>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, specta::Type)]
pub struct ResolvedFrameCropDto {
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
    #[serde(default)]
    pub basis_w: Option<u32>,
    #[serde(default)]
    pub basis_h: Option<u32>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_playwright_target_ipc_empty_stash_returns_none_shape() {
        // Clear the stash.
        playwright_pid_stash().set(None);
        assert!(playwright_pid_stash().get().is_none());
    }

    #[test]
    fn resolve_playwright_target_ipc_remote_browser_sentinel_is_none() {
        // Simulate a remote-browser response.
        playwright_pid_stash().set(Some(PlaywrightLaunchInfo {
            pid: None,
            executable_path: None,
        }));
        let info = playwright_pid_stash().get().unwrap();
        // The resolve command returns Ok(None) here.
        assert!(info.pid.is_none());
        // Reset so other tests stay isolated.
        playwright_pid_stash().set(None);
    }

    #[test]
    fn keydown_serde_roundtrip() {
        let json = r#"{"type":"keydown","key":"a","code":"KeyA","modifiers":{"shift":false,"ctrl":false,"alt":false,"meta":false},"repeat":false}"#;
        let ev: AuthorInputEvent = serde_json::from_str(json).unwrap();
        let v = serde_json::to_value(&ev).unwrap();
        assert_eq!(v["type"], "keydown");
        assert_eq!(v["key"], "a");
        assert_eq!(v["code"], "KeyA");
        assert_eq!(v["repeat"], false);
        assert_eq!(v["modifiers"]["shift"], false);
    }

    #[test]
    fn keydown_modifiers_default_when_omitted() {
        let json = r#"{"type":"keydown","key":"Shift","code":"ShiftLeft"}"#;
        let ev: AuthorInputEvent = serde_json::from_str(json).unwrap();
        if let AuthorInputEvent::Keydown {
            modifiers, repeat, ..
        } = ev
        {
            assert!(!modifiers.shift && !modifiers.ctrl && !modifiers.alt && !modifiers.meta);
            assert!(!repeat);
        } else {
            panic!("expected Keydown");
        }
    }

    #[test]
    fn keyup_serde_roundtrip() {
        let json = r#"{"type":"keyup","key":"a","code":"KeyA","modifiers":{"shift":true,"ctrl":false,"alt":false,"meta":false}}"#;
        let ev: AuthorInputEvent = serde_json::from_str(json).unwrap();
        let v = serde_json::to_value(&ev).unwrap();
        assert_eq!(v["type"], "keyup");
        assert_eq!(v["modifiers"]["shift"], true);
    }

    #[test]
    fn text_serde_roundtrip_with_unicode() {
        let json = r#"{"type":"text","text":"xin chào"}"#;
        let ev: AuthorInputEvent = serde_json::from_str(json).unwrap();
        let v = serde_json::to_value(&ev).unwrap();
        assert_eq!(v["type"], "text");
        assert_eq!(v["text"], "xin chào");
    }

    #[test]
    fn resolve_playwright_target_ipc_local_pid_is_stored() {
        playwright_pid_stash().set(Some(PlaywrightLaunchInfo {
            pid: Some(12345),
            executable_path: Some("/opt/Chromium".into()),
        }));
        let info = playwright_pid_stash().get().unwrap();
        assert_eq!(info.pid, Some(12345));
        assert_eq!(info.executable_path.as_deref(), Some("/opt/Chromium"));
        playwright_pid_stash().set(None);
    }
}
