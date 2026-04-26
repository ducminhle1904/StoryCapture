//! `AutomationError` — typed error taxonomy for the automation crate.
//!
//! Per `<thiserror>` discipline: this crate exports its own typed errors;
//! the Tauri command boundary converts to `AppError`. No `anyhow` here.

use crate::events::AttemptLog;
use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Error, Serialize)]
#[serde(tag = "kind", content = "payload")]
pub enum AutomationError {
    #[error("browser error: {0}")]
    Browser(String),

    #[error("selector resolution failed: {last_error} (after {} attempts)", attempts.len())]
    Selector {
        attempts: Vec<AttemptLog>,
        last_error: String,
    },

    #[error("ambiguous selector: {candidates} candidates scored similarly for `{target}`")]
    AmbiguousSelector {
        target: String,
        candidates: usize,
        attempts: Vec<AttemptLog>,
    },

    #[error("timeout after {timeout_ms}ms: {context}")]
    Timeout { context: String, timeout_ms: u64 },

    #[error("navigation failed: {url}: {cause}")]
    NavigationFailed { url: String, cause: String },

    #[error("io: {0}")]
    Io(String),

    #[error("driver unavailable: {0}")]
    DriverUnavailable(String),

    #[error("capability mismatch: command `{command}` requires `{required:?}`, driver `{driver}` lacks it")]
    CapabilityMismatch {
        command: String,
        driver: String,
        required: String,
    },

    #[error("protocol error: {0}")]
    Protocol(String),

    /// Primary-miss raised on the record path where self-healing is
    /// disabled. Carries the step ordinal, optional stamped step_id, and a
    /// pre-rendered verb excerpt (e.g. `click "Save"`) so the HUD can
    /// surface the locked copy without re-formatting the command.
    ///
    /// Display string is the record-path primary-miss verbatim copy; do not
    /// paraphrase.
    #[error(
        "Step {step_ordinal}: \"{verb}\" could not match any element. Self-healing is disabled during recording. Open this story in Simulator, use \"Promote to fallback\" on step {step_ordinal}, then try again."
    )]
    PrimaryMissNoHeal {
        step_ordinal: u32,
        step_id: Option<uuid::Uuid>,
        verb: String,
    },
}

impl From<std::io::Error> for AutomationError {
    fn from(e: std::io::Error) -> Self {
        AutomationError::Io(e.to_string())
    }
}

impl From<serde_json::Error> for AutomationError {
    fn from(e: serde_json::Error) -> Self {
        AutomationError::Protocol(e.to_string())
    }
}

impl From<storage::StorageError> for AutomationError {
    fn from(e: storage::StorageError) -> Self {
        // Persistence failures during automation are surfaced as Io —
        // they're not browser failures, and not protocol failures.
        AutomationError::Io(format!("storage: {e}"))
    }
}

pub type Result<T> = std::result::Result<T, AutomationError>;
