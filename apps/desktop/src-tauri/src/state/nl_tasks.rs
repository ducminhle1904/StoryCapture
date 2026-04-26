//! Shared AbortHandle map for in-flight NL turns.
//!
//! The registry is managed as Tauri state (`app.manage(Arc::new(NlTaskRegistry::default()))`)
//! and accessed from `nl_chat_send` / `nl_cancel` commands. Each spawned NL
//! turn stores its `AbortHandle` here so the webview can cancel long streams.
//!
//! `insert` checks a per-project cap of 4 concurrent turns and returns
//! `false` if the cap would be exceeded.

use std::collections::HashMap;
use std::sync::Mutex;
use tokio::task::AbortHandle;
use uuid::Uuid;

use intelligence::nl::schemas::StoryDoc;

/// Maximum concurrent NL turns per project.
const MAX_CONCURRENT_PER_PROJECT: usize = 4;

/// Registry entry pairing a task's abort handle with its project context.
struct TaskEntry {
    handle: AbortHandle,
    project_id: String,
}

/// Thread-safe registry for in-flight NL turn abort handles.
///
/// Also holds an in-memory cache of `StoryDoc` outputs keyed by `task_id`,
/// so `nl_diff_apply` can retrieve the doc after `StoryDocReady` without
/// re-querying the LLM.
///
/// Each registry instance gets a unique `session_id` (UUID v4) generated at
/// creation time, used for per-session metrics aggregation.
pub struct NlTaskRegistry {
    tasks: Mutex<HashMap<String, TaskEntry>>,
    /// Cached StoryDoc from completed turns, keyed by task_id.
    docs: Mutex<HashMap<String, StoryDoc>>,
    /// Unique session identifier generated at app startup.
    session_id: String,
}

impl Default for NlTaskRegistry {
    fn default() -> Self {
        Self {
            tasks: Mutex::new(HashMap::new()),
            docs: Mutex::new(HashMap::new()),
            session_id: Uuid::new_v4().to_string(),
        }
    }
}

impl NlTaskRegistry {
    /// Returns the unique session ID for this registry instance.
    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    /// Insert a new task. Returns `true` if inserted, `false` if the
    /// per-project concurrency cap would be exceeded.
    pub fn insert(&self, id: String, project_id: String, handle: AbortHandle) -> bool {
        let mut map = self.tasks.lock().unwrap();
        let count = map.values().filter(|e| e.project_id == project_id).count();
        if count >= MAX_CONCURRENT_PER_PROJECT {
            return false;
        }
        map.insert(id, TaskEntry { handle, project_id });
        true
    }

    /// Abort a task and remove it from the registry. Returns `true` if
    /// the task was found and aborted. Also removes any cached doc for
    /// this task to prevent memory leaks on cancellation.
    pub fn abort(&self, id: &str) -> bool {
        if let Some(entry) = self.tasks.lock().unwrap().remove(id) {
            entry.handle.abort();
            self.docs.lock().unwrap().remove(id);
            true
        } else {
            false
        }
    }

    /// Remove a task from the registry without aborting.
    pub fn remove(&self, id: &str) {
        self.tasks.lock().unwrap().remove(id);
    }

    /// Store a completed StoryDoc for later retrieval by `nl_diff_apply`.
    pub fn store_doc(&self, task_id: String, doc: StoryDoc) {
        self.docs.lock().unwrap().insert(task_id, doc);
    }

    /// Retrieve and remove a stored StoryDoc.
    pub fn take_doc(&self, task_id: &str) -> Option<StoryDoc> {
        self.docs.lock().unwrap().remove(task_id)
    }

    /// Peek at a stored StoryDoc (without removing).
    pub fn get_doc(&self, task_id: &str) -> Option<StoryDoc> {
        self.docs.lock().unwrap().get(task_id).cloned()
    }

    /// Drop a stored doc (used by `nl_diff_reject`).
    pub fn drop_doc(&self, task_id: &str) {
        self.docs.lock().unwrap().remove(task_id);
    }
}

/// Create a dummy `AbortHandle` for testing. Spawns a sleeping future and
/// returns its abort handle.
#[cfg(test)]
fn test_abort_handle() -> AbortHandle {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
        .unwrap();
    rt.block_on(async {
        let h =
            tokio::spawn(async { tokio::time::sleep(std::time::Duration::from_secs(3600)).await });
        h.abort_handle()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn insert_and_abort() {
        let reg = NlTaskRegistry::default();
        let handle = test_abort_handle();
        assert!(reg.insert("t1".into(), "p1".into(), handle));
        assert!(reg.abort("t1"));
        assert!(!reg.abort("t1")); // already removed
    }

    #[test]
    fn respects_concurrency_cap() {
        let reg = NlTaskRegistry::default();
        for i in 0..MAX_CONCURRENT_PER_PROJECT {
            let h = test_abort_handle();
            assert!(reg.insert(format!("t{i}"), "proj".into(), h));
        }
        let h = test_abort_handle();
        assert!(!reg.insert("overflow".into(), "proj".into(), h));

        // Different project is fine
        let h2 = test_abort_handle();
        assert!(reg.insert("other".into(), "other_proj".into(), h2));
    }

    #[test]
    fn doc_cache_lifecycle() {
        let reg = NlTaskRegistry::default();
        let doc = StoryDoc {
            title: "Test".into(),
            steps: vec![],
        };
        reg.store_doc("t1".into(), doc.clone());
        assert!(reg.get_doc("t1").is_some());
        let taken = reg.take_doc("t1");
        assert!(taken.is_some());
        assert!(reg.get_doc("t1").is_none());
    }
}
