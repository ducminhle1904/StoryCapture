//! Session actor (D-06 / ARCHITECTURE.md Pattern 4).
//!
//! Wraps the executor in a long-lived tokio task; outside callers send
//! `SessionCmd::*` and observe events through the bridged event stream.
//!
//! Phase 1 surface is intentionally minimal. Pause/Stop/Status remain
//! mostly stubbed — they wire into Phase 1's recording HUD (UI-04).
//!
//! Recording lifecycle: an optional [`RecorderHandle`] can be attached at
//! spawn time. When the actor receives `SessionCmd::Stop` it calls
//! `recorder.stop().await` before acknowledging, so the DSL session and its
//! recording tear down together.

use crate::events::ExecutorEvent;
use async_trait::async_trait;
use tokio::sync::{mpsc, oneshot};
use uuid::Uuid;

#[derive(Debug)]
pub struct SessionId(pub Uuid);

/// Handle exposed to the DSL session so it can stop an attached recording
/// when the story ends or a stop command arrives.
///
/// Kept deliberately minimal — automation stays Tauri-free, so errors are
/// forwarded as plain strings.
#[async_trait]
pub trait RecorderHandle: Send + Sync {
    /// Best-effort stop. Idempotent: callers may invoke `stop()` on a
    /// session that has already stopped and expect `Ok(())`.
    async fn stop(&self) -> Result<(), String>;
}

/// No-op `RecorderHandle` for DSL runs with no attached recording.
pub struct NullRecorderHandle;

#[async_trait]
impl RecorderHandle for NullRecorderHandle {
    async fn stop(&self) -> Result<(), String> {
        Ok(())
    }
}

pub enum SessionCmd {
    Start {
        story_source: String,
        reply: oneshot::Sender<Result<SessionId, String>>,
    },
    Pause {
        reply: oneshot::Sender<()>,
    },
    Stop {
        reply: oneshot::Sender<()>,
    },
    GetStatus {
        reply: oneshot::Sender<SessionStatusSnapshot>,
    },
}

#[derive(Debug, Clone)]
pub struct SessionStatusSnapshot {
    pub running: bool,
    pub completed_steps: u32,
    pub failed_steps: u32,
}

pub struct SessionActor {
    rx: mpsc::Receiver<SessionCmd>,
    /// Egress event stream consumed by the Tauri host (bridged to a
    /// `Channel<ExecutorEvent>`).
    pub events_tx: mpsc::Sender<ExecutorEvent>,
    /// Optional recording attached to this session. Stopped when the actor
    /// receives `SessionCmd::Stop`.
    recorder: Option<Box<dyn RecorderHandle>>,
}

impl SessionActor {
    /// Spawn the actor with an optional attached recorder.
    ///
    /// Pass `None` for standalone DSL runs (headless CLI, tests, or any
    /// caller that does not own a recording pipeline).
    pub fn spawn(
        recorder: Option<Box<dyn RecorderHandle>>,
    ) -> (mpsc::Sender<SessionCmd>, mpsc::Receiver<ExecutorEvent>) {
        let (cmd_tx, cmd_rx) = mpsc::channel(32);
        let (evt_tx, evt_rx) = mpsc::channel(256);
        let actor = SessionActor {
            rx: cmd_rx,
            events_tx: evt_tx,
            recorder,
        };
        tokio::spawn(actor.run());
        (cmd_tx, evt_rx)
    }

    async fn run(mut self) {
        while let Some(cmd) = self.rx.recv().await {
            match cmd {
                SessionCmd::Start { reply, .. } => {
                    // Caller still invokes `Executor::run` directly; the
                    // actor shape is here so Phase 1's recorder UI can stop
                    // the session without rewriting the surface.
                    let _ = reply.send(Ok(SessionId(Uuid::now_v7())));
                }
                SessionCmd::Pause { reply } => {
                    let _ = reply.send(());
                }
                SessionCmd::Stop { reply } => {
                    if let Some(recorder) = self.recorder.as_ref() {
                        if let Err(e) = recorder.stop().await {
                            tracing::warn!(
                                target: "storycapture::session",
                                error = %e,
                                "attached recorder stop failed"
                            );
                        }
                    }
                    let _ = reply.send(());
                    break;
                }
                SessionCmd::GetStatus { reply } => {
                    let _ = reply.send(SessionStatusSnapshot {
                        running: true,
                        completed_steps: 0,
                        failed_steps: 0,
                    });
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::Arc;

    struct CountingRecorder {
        stops: Arc<AtomicU32>,
        fail: bool,
    }

    #[async_trait]
    impl RecorderHandle for CountingRecorder {
        async fn stop(&self) -> Result<(), String> {
            self.stops.fetch_add(1, Ordering::SeqCst);
            if self.fail {
                Err("simulated failure".into())
            } else {
                Ok(())
            }
        }
    }

    #[tokio::test]
    async fn stop_invokes_attached_recorder() {
        let stops = Arc::new(AtomicU32::new(0));
        let recorder = Box::new(CountingRecorder {
            stops: stops.clone(),
            fail: false,
        });
        let (cmd_tx, _events) = SessionActor::spawn(Some(recorder));
        let (reply_tx, reply_rx) = oneshot::channel();
        cmd_tx
            .send(SessionCmd::Stop { reply: reply_tx })
            .await
            .unwrap();
        reply_rx.await.unwrap();
        assert_eq!(stops.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn stop_without_recorder_is_noop() {
        let (cmd_tx, _events) = SessionActor::spawn(None);
        let (reply_tx, reply_rx) = oneshot::channel();
        cmd_tx
            .send(SessionCmd::Stop { reply: reply_tx })
            .await
            .unwrap();
        reply_rx.await.unwrap();
    }

    #[tokio::test]
    async fn stop_swallows_recorder_error() {
        // A failing recorder must not block the Stop ack — it's best-effort.
        let stops = Arc::new(AtomicU32::new(0));
        let recorder = Box::new(CountingRecorder {
            stops: stops.clone(),
            fail: true,
        });
        let (cmd_tx, _events) = SessionActor::spawn(Some(recorder));
        let (reply_tx, reply_rx) = oneshot::channel();
        cmd_tx
            .send(SessionCmd::Stop { reply: reply_tx })
            .await
            .unwrap();
        reply_rx.await.unwrap();
        assert_eq!(stops.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn null_recorder_handle_stops_cleanly() {
        let recorder: Box<dyn RecorderHandle> = Box::new(NullRecorderHandle);
        recorder.stop().await.unwrap();
    }
}
