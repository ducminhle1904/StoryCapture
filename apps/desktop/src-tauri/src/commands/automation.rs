// automation IPC.
//
// `launch_automation` parses a story, starts the browser drivers, and
// forwards `ExecutorEvent`s to the renderer over a Tauri channel.

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

    let launch_opts = LaunchOptions {
        browser_executable,
        app_url_for_hiding,
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
    // Re-spawn the resolved binary through tokio so we own stdio.
    drop(sidecar);
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
    // Point the sidecar at the bundled modules dir explicitly.
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

    // Playwright is the only automation driver.
    let playwright = match playwright {
        Some(pw) => pw,
        None => {
            return Err(AppError::Automation(
                "Playwright sidecar failed to spawn — check that Node.js is installed and `scripts/playwright-sidecar` has `pnpm install` run".into(),
            ));
        }
    };
    // Share the driver with the pid probe task.
    let shared_pw: Arc<Mutex<PlaywrightSidecarDriver>> = Arc::new(Mutex::new(playwright));
    // Exponential-backoff probe with a ~10s budget.
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

    // Run the executor and forward events.
    tracing::info!(target: "storycapture::automation", "Executor::run starting");
    let mut events = Executor::run(story, primary, fallback, persistence, screenshot_dir, launch_opts);
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
    // Clear the stash when the story ends.
    playwright_pid_stash().set(None);

    Ok(())
}

// ──────────────────────────────────────────────────────────────────────
// Plan 05-02: resolve_playwright_target + pid stash
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

/// Test-only helper to inject a pid.
#[cfg(test)]
pub(crate) fn __test_set_playwright_pid(info: Option<PlaywrightLaunchInfo>) {
    playwright_pid_stash().set(info);
}

/// Resolve the current Playwright auto-target to a window id.
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
        // Remote-browser or similar: keep the auto target disabled.
        return Ok(None);
    };

    #[cfg(target_os = "macos")]
    {
        let resolved = capture::macos::window::find_window_by_pid(pid, None)
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

/// Returned by `resolve_playwright_target`.
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
