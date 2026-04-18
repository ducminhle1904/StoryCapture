use std::sync::atomic::{AtomicBool, Ordering};

use tokio::sync::Notify;

/// Cooperative run control for a single automation session.
///
/// Pause takes effect at explicit checkpoints between commands and inside
/// pause-aware waits. In-flight browser operations still run to completion.
pub struct RunControl {
    paused: AtomicBool,
    resumed: Notify,
}

impl RunControl {
    pub fn new() -> Self {
        Self {
            paused: AtomicBool::new(false),
            resumed: Notify::new(),
        }
    }

    pub fn pause(&self) {
        self.paused.store(true, Ordering::Release);
    }

    pub fn resume(&self) {
        self.paused.store(false, Ordering::Release);
        self.resumed.notify_waiters();
    }

    pub fn is_paused(&self) -> bool {
        self.paused.load(Ordering::Acquire)
    }

    pub async fn checkpoint(&self) {
        while self.is_paused() {
            self.resumed.notified().await;
        }
    }
}

impl Default for RunControl {
    fn default() -> Self {
        Self::new()
    }
}
