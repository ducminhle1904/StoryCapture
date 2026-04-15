//! Session actor (D-06 / ARCHITECTURE.md Pattern 4).
//!
//! Wraps the executor in a long-lived tokio task; outside callers send
//! `SessionCmd::*` and observe events through the bridged event stream.
//!
//! Phase 1 surface is intentionally minimal. Pause/Stop/Status are stubbed
//! — they wire into Phase 1's recording HUD (UI-04) and are filled in when
//! the recorder UI lands.

use crate::events::ExecutorEvent;
use tokio::sync::{mpsc, oneshot};
use uuid::Uuid;

#[derive(Debug)]
pub struct SessionId(pub Uuid);

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
}

impl SessionActor {
    pub fn spawn() -> (mpsc::Sender<SessionCmd>, mpsc::Receiver<ExecutorEvent>) {
        let (cmd_tx, cmd_rx) = mpsc::channel(32);
        let (evt_tx, evt_rx) = mpsc::channel(256);
        let actor = SessionActor {
            rx: cmd_rx,
            events_tx: evt_tx,
        };
        tokio::spawn(actor.run());
        (cmd_tx, evt_rx)
    }

    async fn run(mut self) {
        while let Some(cmd) = self.rx.recv().await {
            match cmd {
                SessionCmd::Start { reply, .. } => {
                    // Phase 1: stubbed start — caller usually invokes the
                    // executor directly via `Executor::run`; the actor
                    // shape exists so Plan 09 can wire the recorder UI
                    // commands without rewriting the surface.
                    let _ = reply.send(Ok(SessionId(Uuid::now_v7())));
                }
                SessionCmd::Pause { reply } => {
                    let _ = reply.send(());
                }
                SessionCmd::Stop { reply } => {
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
