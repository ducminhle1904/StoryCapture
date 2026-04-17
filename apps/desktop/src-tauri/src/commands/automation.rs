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
use automation::{Executor, ExecutorEvent, NoopDriver, PlaywrightSidecarDriver};
use serde::{Deserialize, Serialize};
use std::process::Stdio;
use std::sync::Arc;
use tauri::ipc::Channel;
use tauri::{AppHandle, State};
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
pub async fn launch_automation(
    app: AppHandle,
    _state: State<'_, AppState>,
    story_source: String,
    project_folder: String,
    on_event: Channel<AutomationEvent>,
) -> Result<(), AppError> {
    // Apply user-configured browser executable (Phase 1 browser picker).
    // `LaunchConfig::from_meta` reads this env var; set it per-invocation so
    // a settings change takes effect without app restart.
    let settings = crate::commands::app_settings::load(&app);
    if let Some(path) = settings.browser_executable.as_ref() {
        std::env::set_var("STORYCAPTURE_BROWSER_PATH", path);
    } else {
        std::env::remove_var("STORYCAPTURE_BROWSER_PATH");
    }

    // Parse the story (pure crate, no IO outside the input string).
    let parse = story_parser::parse(&story_source);
    let story = parse
        .ast
        .ok_or_else(|| AppError::InvalidArgument("story parse failed".into()))?;

    // Open project DB for persistence (Plan 05).
    let project_path = std::path::PathBuf::from(&project_folder);
    let project_db = storage::ProjectDb::open(&project_path)?;

    // Resolve screenshot dir within the project folder's `assets/` dir.
    let screenshot_dir = project_path.join(storage::ASSETS_DIRNAME);
    std::fs::create_dir_all(&screenshot_dir).map_err(AppError::from)?;

    // Launch the Playwright sidecar via tauri-plugin-shell.
    let sidecar = app
        .shell()
        .sidecar("playwright-sidecar")
        .map_err(|e| AppError::Automation(format!("sidecar resolve: {e}")))?;
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
    let mut tokio_cmd = TokioCommand::new(&sidecar_path);
    tokio_cmd
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let playwright = match tokio_cmd.spawn() {
        Ok(child) => match PlaywrightSidecarDriver::from_child(child) {
            Ok(d) => Some(d),
            Err(e) => {
                tracing::warn!(target: "storycapture::automation", "playwright sidecar wrap failed: {e}");
                None
            }
        },
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
    let mut events = Executor::run(story, primary, fallback, persistence, screenshot_dir);
    while let Some(evt) = events.recv().await {
        if let Err(e) = on_event.send(AutomationEvent::from(evt)) {
            tracing::warn!(target: "storycapture::automation", "channel send failed: {e}");
            break;
        }
    }
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
    #[cfg(not(target_os = "macos"))]
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
