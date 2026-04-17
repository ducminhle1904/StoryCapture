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
use serde::Serialize;
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
    let primary: Box<dyn automation::BrowserDriver> = match playwright {
        Some(pw) => Box::new(pw),
        None => {
            return Err(AppError::Automation(
                "Playwright sidecar failed to spawn — check that Node.js is installed and `scripts/playwright-sidecar` has `pnpm install` run".into(),
            ));
        }
    };
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

    Ok(())
}
