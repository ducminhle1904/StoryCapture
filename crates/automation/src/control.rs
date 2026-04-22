use std::sync::atomic::{AtomicBool, Ordering};

use tokio::sync::Notify;

/// Cooperative run control for a single automation session.
///
/// Pause takes effect at explicit checkpoints between commands and inside
/// pause-aware waits. In-flight browser operations still run to completion.
pub struct RunControl {
    paused: AtomicBool,
    cancelled: AtomicBool,
    resumed: Notify,
}

impl RunControl {
    pub fn new() -> Self {
        Self {
            paused: AtomicBool::new(false),
            cancelled: AtomicBool::new(false),
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

    /// Cooperative cancel — checked by the executor at step boundaries.
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        // Wake any waiters so a paused run exits the loop promptly.
        self.resumed.notify_waiters();
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }

    pub async fn checkpoint(&self) {
        while self.is_paused() && !self.is_cancelled() {
            self.resumed.notified().await;
        }
    }
}

impl Default for RunControl {
    fn default() -> Self {
        Self::new()
    }
}
