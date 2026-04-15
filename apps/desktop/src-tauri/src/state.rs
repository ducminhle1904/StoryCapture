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

use std::{collections::HashMap, path::PathBuf, sync::Mutex};

/// Cross-thread handle map for actor senders. Keys are stable string tags
/// (e.g. `"automation"`, `"capture"`, `"encoder"`) chosen by each downstream
/// plan; values are erased mpsc senders. Erasure (`serde_json::Value`) is
/// intentional: each consumer downcasts via its own typed wrapper. Plans
/// adding senders SHOULD also expose a typed accessor on `AppState` (e.g.
/// `pub fn capture_sender(&self) -> Option<CaptureCmdSender>`).
pub type ActorRegistry = Mutex<HashMap<String, tokio::sync::mpsc::Sender<serde_json::Value>>>;

#[derive(Debug)]
pub struct AppState {
    /// Resolved at startup from `app.path().app_data_dir()`. Plan 01-09
    /// (storage) puts the global SQLite + per-project databases here.
    pub data_dir: PathBuf,

    /// Resolved at startup from `app.path().app_log_dir()`. Plan 01-03
    /// owns this — `tracing-subscriber` rolls files in this dir.
    pub log_dir: PathBuf,

    /// Actor registry — see module comment.
    pub actors: ActorRegistry,
}

impl AppState {
    pub fn new(data_dir: PathBuf, log_dir: PathBuf) -> Self {
        Self {
            data_dir,
            log_dir,
            actors: Mutex::new(HashMap::new()),
        }
    }
}
