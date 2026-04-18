// automation IPC.
//
// `launch_automation` parses a story source, launches both drivers
// (chromiumoxide in-process + Playwright sidecar via `tauri-plugin-shell`),
// runs the executor, and forwards every `ExecutorEvent` to the renderer
// over a Tauri `Channel<ExecutorEvent>`.
//
// The Playwright sidecar binary is the SEA artifact built by
// `scripts/playwright-sidecar/build-sea.mjs` and bundled as
// `apps/desktop/src-tauri/binaries/playwright-sidecar-<triple>`.

use crate::error::AppError;
use crate::state::AppState;
use automation::{Executor, ExecutorEvent, LaunchOptions, NoopDriver, PlaywrightSidecarDriver};
use serde::{Deserialize, Serialize};
use std::process::Stdio;
use std::sync::Arc;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_shell::ShellExt;
use tokio::process::Command as TokioCommand;
use tokio::sync::Mutex;

/// Tauri / specta wrapper around `automation::ExecutorEvent`.
///
/// The `automation` crate is pure — it doesn't depend on `specta`.
/// We wrap its event into a JSON `Value` here so the `Channel<T>` payload
/// type satisfies `specta::Type` without leaking Tauri into `automation`.
#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct AutomationEvent {
    /// JSON-stringified `automation::ExecutorEvent` (the event enum is
    /// defined in the pure `automation` crate which deliberately doesn't
    /// depend on `specta`; the renderer parses with `JSON.parse`).
    pub json: String,
}

impl From<ExecutorEvent> for AutomationEvent {
    fn from(e: ExecutorEvent) -> Self {
        AutomationEvent {
            json: serde_json::to_string(&e).unwrap_or_else(|_| "{}".into()),
        }
    }
}

/// Launch a story against both drivers and stream events to the renderer.
///
/// `on_event` is a typed `Channel<ExecutorEvent>` that the renderer holds
/// open for the duration of the run; the host pumps every event from the
/// executor mpsc receiver into the channel.
#[tauri::command]
#[specta::specta]
/// Plan 06-02 — when `chrome_hiding` is `Some(true)`, the host threads
/// a validated http(s) URL into `LaunchOptions::app_url_for_hiding` so
/// `LaunchConfig::from_meta` appends `--app=<meta.app>` to the launch
/// args (D-09/D-10). `meta.app` is parsed via `url::Url` at this layer
/// (T-06-09) to reject non-http/https schemes before it reaches the
/// automation crate. Non-sticky per invocation — a new `LaunchOptions`
/// is built every call, no global env state.
pub async fn launch_automation(
    app: AppHandle,
    _state: State<'_, AppState>,
    story_source: String,
    project_folder: String,
    on_event: Channel<AutomationEvent>,
    chrome_hiding: Option<bool>,
) -> Result<(), AppError> {
    tracing::info!(
        target: "storycapture::automation",
        story_bytes = story_source.len(),
        project_folder = %project_folder,
        "launch_automation invoked"
    );
    // Build LaunchOptions locally (backlog #1 — was previously threaded
    // through `std::env::set_var` which is unsafe under Rust 1.80+ and
    // racy across concurrent `launch_automation` invocations). The
    // automation crate now takes `&LaunchOptions` by reference.
    let settings = crate::commands::app_settings::load(&app);
    let browser_executable = settings
        .browser_executable
        .as_ref()
        .filter(|s| !s.is_empty())
        .map(std::path::PathBuf::from);

    // Plan 06-02 — chrome-hiding (D-09/D-10). Validate `meta.app` with
    // `url::Url` here (T-06-09) so schemes outside http/https never
    // reach the launch args. Parse the story up front to inspect meta
    // before building LaunchOptions; the parser runs twice (once here
    // for the URL gate, once below for the executor) but it's pure + fast.
    let app_url_for_hiding = if chrome_hiding == Some(true) {
        let preview = story_parser::parse(&story_source);
        let app_url = preview
            .ast
            .as_ref()
            .and_then(|a| a.meta.app.clone());
        let safe = match app_url.as_deref() {
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
            app_url
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

    let launch_opts = LaunchOptions {
        browser_executable,
        app_url_for_hiding,
    };

    // Parse the story (pure crate, no IO outside the input string).
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

    // Open project DB for persistence (Plan 05).
    let project_path = std::path::PathBuf::from(&project_folder);
    let project_db = storage::ProjectDb::open(&project_path).map_err(|e| {
        tracing::error!(target: "storycapture::automation", error = %e, "ProjectDb::open failed");
        e
    })?;
    tracing::info!(target: "storycapture::automation", "ProjectDb opened");

    // Resolve screenshot dir within the project folder's `assets/` dir.
    let screenshot_dir = project_path.join(storage::ASSETS_DIRNAME);
    std::fs::create_dir_all(&screenshot_dir).map_err(|e| {
        tracing::error!(target: "storycapture::automation", error = %e, dir = %screenshot_dir.display(), "create_dir_all failed");
        AppError::from(e)
    })?;
    tracing::info!(target: "storycapture::automation", "screenshot dir ready");

    // Launch the Playwright sidecar via tauri-plugin-shell.
    tracing::info!(target: "storycapture::automation", "resolving playwright sidecar via tauri-plugin-shell");
    let sidecar = app
        .shell()
        .sidecar("playwright-sidecar")
        .map_err(|e| {
            tracing::error!(target: "storycapture::automation", error = %e, "shell.sidecar resolve failed");
            AppError::Automation(format!("sidecar resolve: {e}"))
        })?;
    // The shell plugin's sidecar command isn't a tokio::process::Child, so
    // we spawn the resolved binary path through tokio directly to keep the
    // stdin/stdout pipes hot for JSON-RPC framing.
    // The shell-plugin sidecar resolves the per-triple binary path. We
    // discard the wrapper and re-spawn through tokio so we own the
    // stdin/stdout pipes for JSON-RPC framing.
    drop(sidecar);
    // Spawn raw (path-resolved) Playwright sidecar with piped stdio.
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
    // The SEA wrapper's default module-lookup candidates don't match the
    // layout Tauri produces (resources land in Contents/Resources/binaries/,
    // not Contents/Resources/). Point the sidecar at the bundled modules
    // dir explicitly via env.
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
    let playwright = match tokio_cmd.spawn() {
        Ok(mut child) => {
            if let Some(stderr) = child.stderr.take() {
                tokio::spawn(async move {
                    use tokio::io::{AsyncBufReadExt, BufReader};
                    let mut lines = BufReader::new(stderr).lines();
                    while let Ok(Some(line)) = lines.next_line().await {
                        tracing::warn!(target: "storycapture::automation", sidecar_stderr = %line);
                    }
                });
            }
            match PlaywrightSidecarDriver::from_child(child) {
                Ok(d) => Some(d),
                Err(e) => {
                    tracing::warn!(target: "storycapture::automation", "playwright sidecar wrap failed: {e}");
                    None
                }
            }
        }
        Err(e) => {
            tracing::warn!(target: "storycapture::automation", "playwright sidecar spawn failed (binary not built?): {e}");
            None
        }
    };

    // Playwright is the only automation driver. If the sidecar didn't
    // spawn, there is no meaningful fallback — surface a clear error.
    let playwright = match playwright {
        Some(pw) => pw,
        None => {
            return Err(AppError::Automation(
                "Playwright sidecar failed to spawn — check that Node.js is installed and `scripts/playwright-sidecar` has `pnpm install` run".into(),
            ));
        }
    };
    // Plan 05-02: wrap the Playwright driver in an Arc<Mutex<>> so a
    // background probe task can call `browser_process()` to populate the
    // pid stash while the executor runs. The executor needs `Box<dyn
    // BrowserDriver>`, so we thread the Arc through a small forwarding
    // adapter that implements BrowserDriver by delegating to the inner
    // mutex-guarded driver.
    let shared_pw: Arc<Mutex<PlaywrightSidecarDriver>> = Arc::new(Mutex::new(playwright));
    // Exponential-backoff probe: start at 100ms, double up to 1s, ~10s budget.
    // Stops early on concrete pid / remote-browser signal; aborts after 3
    // consecutive driver errors (launch permanently failed).
    playwright_pid_stash().set(None);
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
                        let _ = playwright_pid_stash().set(Some(PlaywrightLaunchInfo {
                            pid: info.pid,
                            executable_path: info.executable_path,
                        }));
                        if info.reason.as_deref() == Some("remote-browser")
                            || info.pid.is_some()
                        {
                            break;
                        }
                    }
                    Err(_) => {
                        consecutive_errors += 1;
                        if consecutive_errors >= 3 {
                            break;
                        }
                    }
                }
                delay = std::cmp::min(delay * 2, cap);
            }
        });
    }

    let primary: Box<dyn automation::BrowserDriver> =
        Box::new(crate::commands::automation_shared::SharedPlaywrightDriver::new(shared_pw));
    let fallback: Box<dyn automation::BrowserDriver> = Box::new(NoopDriver::new());

    let persistence = Some(Arc::new(Mutex::new(project_db)) as automation::PersistenceHandle);

    // Run the executor and pump events to the renderer.
    tracing::info!(target: "storycapture::automation", "Executor::run starting");
    let mut events = Executor::run(story, primary, fallback, persistence, screenshot_dir, launch_opts);
    while let Some(evt) = events.recv().await {
        // Mirror every event into tracing so we can diagnose without the
        // renderer side. For step_failed/story_ended specifically, log the
        // full debug so error_message is visible.
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
    // Story finished (executor channel closed). Clear the stash so the
    // UI greys out the Playwright-auto option until the next launch.
    playwright_pid_stash().set(None);

    Ok(())
}

// ──────────────────────────────────────────────────────────────────────
// Plan 05-02: resolve_playwright_target + pid stash
// ──────────────────────────────────────────────────────────────────────

/// Per-process stash of the most recent Playwright launch info. Written by
/// `launch_automation` when the executor emits `LaunchOk`, cleared on
/// `Closed` or when the command returns. Read by `resolve_playwright_target`
/// to turn "the UI asks for Playwright auto" into a concrete window id.
///
/// T-05-02-01: pid flows ONLY from the host's Playwright driver into this
/// stash, never from the renderer. The renderer asks "use playwright-auto";
/// the host builds the CaptureTarget.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlaywrightLaunchInfo {
    pub pid: Option<i32>,
    pub executable_path: Option<String>,
}

pub struct PlaywrightPidStash(parking_lot::Mutex<Option<PlaywrightLaunchInfo>>);
impl PlaywrightPidStash {
    /// Stores the new value and returns `true` iff it differs from the
    /// prior one. Callers polling the driver use the returned bool to
    /// skip downstream notifications when nothing changed.
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

/// Test-only helper to inject a pid for the IPC test (avoids spawning a
/// real Playwright). Only available under `cfg(test)` builds.
#[cfg(test)]
pub(crate) fn __test_set_playwright_pid(info: Option<PlaywrightLaunchInfo>) {
    playwright_pid_stash().set(info);
}

/// Resolve the current Playwright auto-target to a concrete window id.
///
/// Returns:
///   - `Ok(Some(WindowId))` — a Chromium window owned by the Playwright
///     pid is currently on-screen; UI should enable + pre-select the
///     "Playwright browser (auto)" entry.
///   - `Ok(None)` — no Playwright launched yet, or remote-browser session,
///     or the pid failed to resolve within the retry budget. UI should
///     keep the auto entry disabled.
///
/// This command NEVER returns an error for "not available" — only for
/// unexpected SCK failures (TCC, ABI). The distinction matters: UI code
/// checks `.is_some()` to decide enablement, not `.is_ok()`.
#[tauri::command]
#[specta::specta]
pub async fn resolve_playwright_target(
    _state: State<'_, AppState>,
) -> Result<Option<ResolvedPlaywrightTarget>, AppError> {
    let info = match playwright_pid_stash().get() {
        Some(i) => i,
        None => return Ok(None),
    };
    let Some(pid) = info.pid else {
        // remote-browser or similar — auto target stays disabled.
        return Ok(None);
    };

    #[cfg(target_os = "macos")]
    {
        let resolved = capture::macos::window::find_window_by_pid(pid, Some("Chromium"))
            .await
            .map_err(|e| AppError::Capture(e.to_string()))?;
        let Some(window_id) = resolved else {
            return Ok(None);
        };
        Ok(Some(ResolvedPlaywrightTarget {
            window_id: window_id.0,
            pid,
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
        Ok(Some(ResolvedPlaywrightTarget {
            window_id: hwnd as u64,
            pid,
        }))
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = pid;
        Ok(None)
    }
}

/// Returned by `resolve_playwright_target`. The `pid` is echoed back so the
/// renderer can store it as part of a `WindowByPid` capture target (the
/// actual WindowByPid resolve-at-start behavior in SckBackend always
/// re-resolves, so the stored pid is only a UI display hint).
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct ResolvedPlaywrightTarget {
    pub window_id: u64,
    pub pid: i32,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_playwright_target_ipc_empty_stash_returns_none_shape() {
        // Clear the stash; caller with nothing launched gets Ok(None).
        playwright_pid_stash().set(None);
        assert!(playwright_pid_stash().get().is_none());
    }

    #[test]
    fn resolve_playwright_target_ipc_remote_browser_sentinel_is_none() {
        // Simulate a remote-browser response: pid=None, reason="remote-browser".
        playwright_pid_stash().set(Some(PlaywrightLaunchInfo {
            pid: None,
            executable_path: None,
        }));
        let info = playwright_pid_stash().get().unwrap();
        // The resolve command returns Ok(None) for this shape (pid.is_none()).
        assert!(info.pid.is_none());
        // Reset so other tests aren't affected.
        playwright_pid_stash().set(None);
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
