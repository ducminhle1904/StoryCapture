//! Author-time driver state registry (Phase 11, D-16).
//!
//! Shared `AuthorDriverState` exclusive-lock that both `commands/picker.rs`
//! and `commands/simulator.rs` lock against. The enum is the single
//! authority on who owns the author-session driver at any instant.
//!
//! Transition table (lock-protected):
//!
//!   Idle                 ──(start_author_preview)──►  LivePreview{streamId}
//!   LivePreview{s}       ──(stop_author_preview)───►  Idle
//!   LivePreview{s}       ──(picker_start_author)───►  Picking{s, resume_to=None}
//!   LivePreview{s}       ──(simulator_start)───────►  SimulatorRunning{session}
//!   Picking{s,rt=None}   ──(pick resolve/cancel)───►  LivePreview{s}
//!   Picking{s,rt=Some}   ──(pick resolve/cancel)───►  *rt (restore prior)
//!   SimulatorRunning     ──(RunPaused)─────────────►  SimulatorPaused
//!   SimulatorRunning     ──(StoryEnded/Cancel)─────►  Idle or LivePreview{s}
//!   SimulatorPaused{s}   ──(simulator_step_to)────►   SimulatorRunning
//!   SimulatorPaused{s}   ──(simulator_cancel)─────►   Idle or LivePreview{s}
//!   SimulatorPaused{s}   ──(picker_start_author)──►   Picking{s, resume_to=SimulatorPaused}
//!
//! Invariants:
//!   * Picking is only reachable from LivePreview or SimulatorPaused.
//!   * SimulatorPaused is the only non-Idle state that carries a resume_to box.
//!   * Idle is reachable from any state via explicit teardown OR app shutdown.

use std::sync::Arc;

use serde::Serialize;

pub type StreamId = String;
pub type SimulatorSessionId = String;

#[derive(Debug, Clone)]
pub enum AuthorDriverState {
    Idle,
    LivePreview {
        stream_id: StreamId,
    },
    Picking {
        stream_id: StreamId,
        resume_to: Option<Box<AuthorDriverState>>,
    },
    SimulatorRunning {
        session: SimulatorSessionId,
    },
    SimulatorPaused {
        session: SimulatorSessionId,
    },
}

impl Default for AuthorDriverState {
    fn default() -> Self {
        Self::Idle
    }
}

#[derive(Default)]
pub struct AuthorDriverRegistry {
    pub state: tokio::sync::Mutex<AuthorDriverState>,
}

impl AuthorDriverRegistry {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }
}

#[derive(Debug, thiserror::Error, Serialize, specta::Type)]
#[serde(tag = "kind", content = "message")]
pub enum AuthorDriverError {
    #[error("Simulator running — cancel to pick")]
    SimulatorBusy,
    #[error("Pick already active")]
    AlreadyPicking,
    #[error("invalid transition from {from} to {to}")]
    InvalidTransition { from: String, to: String },
}

impl AuthorDriverState {
    /// D-13 + D-15 complement: gate picker-start against the current state.
    pub fn can_start_pick(&self) -> Result<(), AuthorDriverError> {
        match self {
            AuthorDriverState::SimulatorRunning { .. } => Err(AuthorDriverError::SimulatorBusy),
            AuthorDriverState::Picking { .. } => Err(AuthorDriverError::AlreadyPicking),
            _ => Ok(()),
        }
    }

    /// D-15: gate simulator-start against the current state.
    pub fn can_start_simulator(&self) -> Result<(), AuthorDriverError> {
        match self {
            AuthorDriverState::Picking { .. } => Err(AuthorDriverError::AlreadyPicking),
            _ => Ok(()),
        }
    }

    /// Transition into Picking, boxing the prior state into `resume_to`
    /// only when we came from SimulatorPaused (D-14). All other prior
    /// states resolve back to LivePreview{stream_id} via `end_pick`.
    pub fn begin_pick(&mut self, stream_id: StreamId) {
        let prior = std::mem::replace(self, AuthorDriverState::Idle);
        let resume_to = match &prior {
            AuthorDriverState::SimulatorPaused { .. } => Some(Box::new(prior)),
            _ => None,
        };
        *self = AuthorDriverState::Picking {
            stream_id,
            resume_to,
        };
    }

    /// Exit Picking — restore `resume_to` if Some, else land in
    /// LivePreview{stream_id} (keeps the session alive for subsequent picks).
    /// No-op if state isn't Picking.
    pub fn end_pick(&mut self) {
        let current = std::mem::replace(self, AuthorDriverState::Idle);
        match current {
            AuthorDriverState::Picking {
                stream_id,
                resume_to,
            } => {
                *self = match resume_to {
                    Some(prior) => *prior,
                    None => AuthorDriverState::LivePreview { stream_id },
                };
            }
            other => {
                // Not Picking — restore untouched.
                *self = other;
            }
        }
    }
}

/// RAII resume-on-drop guard for picker flows. The caller constructs this
/// with the prior state after transitioning into Picking; on success the
/// caller invokes `disarm()` and runs its own restoration. On error /
/// panic / early-return the Drop impl restores the prior state and
/// best-effort resumes the author-preview stream.
pub struct PickerResumeGuard {
    registry: Arc<AuthorDriverRegistry>,
    stream_id: StreamId,
    restore: std::sync::Mutex<Option<AuthorDriverState>>,
}

impl PickerResumeGuard {
    pub fn new(
        registry: Arc<AuthorDriverRegistry>,
        stream_id: StreamId,
        restore: AuthorDriverState,
    ) -> Self {
        Self {
            registry,
            stream_id,
            restore: std::sync::Mutex::new(Some(restore)),
        }
    }

    /// Disarm the guard — Drop becomes a no-op. Call on the success path
    /// after the command has performed its own restoration under the lock.
    pub fn disarm(&self) {
        self.restore.lock().unwrap().take();
    }
}

impl Drop for PickerResumeGuard {
    fn drop(&mut self) {
        let Some(state) = self.restore.lock().unwrap().take() else {
            return;
        };
        // Pitfall 2: shutdown-safe. If no tokio runtime is current (shutdown
        // tearing down the reactor), skip spawn — the OS reaps the process.
        let Ok(handle) = tokio::runtime::Handle::try_current() else {
            return;
        };
        let registry = self.registry.clone();
        let _stream_id = self.stream_id.clone();
        handle.spawn(async move {
            let mut g = registry.state.lock().await;
            *g = state;
            // TODO(11-03): call `crate::commands::automation::resume_author_preview(_stream_id)`
            // once the picker_start_author command in 11-03 wires the registry; until then
            // the guard only restores FSM state. Keep fire-and-forget semantics on that call.
        });
    }
}
