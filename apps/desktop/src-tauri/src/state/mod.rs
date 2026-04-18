// AppState — host-side actor handle registry.
//
// Per D-06: state ownership lives in tokio mpsc actors, NOT in
// `Arc<Mutex<BigState>>`. AppState here is intentionally minimal — it only
// holds (a) paths the host needs to know about and (b) a typed map of
// `mpsc::Sender` handles that downstream plans (Plans 06/07/08) populate
// when their actors spawn.
//
// Plan 01-03 ships the placeholder; Plans 06/07/08 add typed channel newtypes
// and their corresponding senders.

pub mod nl_tasks;

use std::{collections::HashMap, path::PathBuf, sync::Arc, sync::Mutex};

use parking_lot::Mutex as PLMutex;

use reqwest::Client as HttpClient;
use tokio::sync::Mutex as TokioMutex;

use crate::commands::render::RenderQueueState;

/// shared handle to the active Playwright sidecar driver.
///
/// `launch_automation` populates this when it spawns the executor's
/// driver, and clears it at story end. The picker commands
/// (`picker_start`/`cancel`/`is_active`) read it to drive the SAME
/// sidecar instance the executor is using — picker can't spin up its own
/// because the overlay is injected via `addInitScript` at launch time.
pub type SharedPlaywrightDriverHandle =
    Arc<TokioMutex<Option<Arc<TokioMutex<automation::PlaywrightSidecarDriver>>>>>;

/// Cross-thread handle map for actor senders. Keys are stable string tags
/// (e.g. `"automation"`, `"capture"`, `"encoder"`) chosen by each downstream
/// plan; values are erased mpsc senders. Erasure (`serde_json::Value`) is
/// intentional: each consumer downcasts via its own typed wrapper. Plans
/// adding senders SHOULD also expose a typed accessor on `AppState` (e.g.
/// `pub fn capture_sender(&self) -> Option<CaptureCmdSender>`).
pub type ActorRegistry = Mutex<HashMap<String, tokio::sync::mpsc::Sender<serde_json::Value>>>;

// Note: AppState no longer derives Debug — `playwright_driver` holds
// `PlaywrightSidecarDriver` (no Debug impl, owns process handles).
pub struct AppState {
    /// Resolved at startup from `app.path().app_data_dir()`. Plan 01-09
    /// (storage) puts the global SQLite + per-project databases here.
    pub data_dir: PathBuf,

    /// Resolved at startup from `app.path().app_log_dir()`. Plan 01-03
    /// owns this — `tracing-subscriber` rolls files in this dir.
    pub log_dir: PathBuf,

    /// Actor registry — see module comment.
    pub actors: ActorRegistry,

    /// Render queue state. `None` until the host calls
    /// `install_render_queue` during project-open; cleared when the
    /// project closes. Wrapped in `parking_lot::Mutex` for cheap
    /// synchronous access from Tauri commands.
    pub render_queue: PLMutex<Option<RenderQueueState>>,

    /// Shared HTTP client for connection pool reuse across LLM and TTS
    /// providers. Created once at startup with generous timeouts; individual
    /// providers inherit the pool but may override per-request timeouts.
    pub http_client: HttpClient,

    /// handle to the in-flight Playwright sidecar driver
    /// (populated by `launch_automation`, cleared at story end). The
    /// picker commands read this to issue `pickElement.*` against the
    /// same sidecar the executor is driving.
    pub playwright_driver: SharedPlaywrightDriverHandle,
}

impl AppState {
    pub fn new(data_dir: PathBuf, log_dir: PathBuf) -> Self {
        let http_client = HttpClient::builder()
            .timeout(std::time::Duration::from_secs(180))
            .pool_idle_timeout(std::time::Duration::from_secs(90))
            .pool_max_idle_per_host(8)
            .build()
            .expect("shared reqwest client");
        Self {
            data_dir,
            log_dir,
            actors: Mutex::new(HashMap::new()),
            render_queue: PLMutex::new(None),
            http_client,
            playwright_driver: Arc::new(TokioMutex::new(None)),
        }
    }

    /// Snapshot the currently-installed render queue state. Returns
    /// `None` when no project is open.
    pub fn render_queue(&self) -> Option<RenderQueueState> {
        self.render_queue.lock().clone()
    }

    /// Called by the host during project-open (Plan 11 wires the full
    /// flow; Plan 02-10 parks the slot).
    pub fn install_render_queue(&self, rq: RenderQueueState) {
        *self.render_queue.lock() = Some(rq);
    }

    pub fn clear_render_queue(&self) {
        *self.render_queue.lock() = None;
    }
}
