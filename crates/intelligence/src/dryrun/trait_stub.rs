// Trait-shape stub for dry-run testing.
//
// When `crates/automation` is available, switch over to
// `pub use automation::{BrowserDriver, DriverError, ExecStep, StepResult, SelectorAttempt};`.
//
// This stub mirrors the subset of the API that the DryRunOrchestrator
// actually uses. Field names and semantics match
// `crates/automation/src/driver.rs` and `crates/automation/src/events.rs`.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::fmt;

/// Minimal representation of a DSL step for driver execution.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecStep {
    pub id: String,
    pub verb: String,
    pub target: Option<String>,
    pub value: Option<String>,
}

/// Which selector strategy was tried and whether it succeeded.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SelectorAttempt {
    pub strategy: String,
    pub success: bool,
    pub elapsed_ms: u64,
}

/// Successful step execution result.
#[derive(Debug, Clone)]
pub struct StepResult {
    pub elapsed_ms: u64,
    pub selector_attempts: Vec<SelectorAttempt>,
    pub screenshot: Option<Vec<u8>>,
}

/// Errors returned by a `BrowserDriver`.
#[derive(Debug)]
pub enum DriverError {
    SelectorNotFound {
        message: String,
        selector_attempts: Vec<SelectorAttempt>,
    },
    Timeout {
        message: String,
        selector_attempts: Vec<SelectorAttempt>,
    },
    NavigationFailed(String),
    Other(String),
}

impl DriverError {
    /// Extract the selector fallback chain from the error, if any.
    pub fn selector_attempts(&self) -> Vec<SelectorAttempt> {
        match self {
            DriverError::SelectorNotFound {
                selector_attempts, ..
            } => selector_attempts.clone(),
            DriverError::Timeout {
                selector_attempts, ..
            } => selector_attempts.clone(),
            _ => vec![],
        }
    }
}

impl fmt::Display for DriverError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            DriverError::SelectorNotFound { message, .. } => {
                write!(f, "selector not found: {message}")
            }
            DriverError::Timeout { message, .. } => write!(f, "timeout: {message}"),
            DriverError::NavigationFailed(m) => write!(f, "navigation failed: {m}"),
            DriverError::Other(m) => write!(f, "{m}"),
        }
    }
}

impl std::error::Error for DriverError {}

/// Trait that the DryRunOrchestrator depends on.
///
/// TODO: When `crates/automation` merges, replace this with
/// `pub use automation::BrowserDriver;` via the `phase1-wired` feature flag.
#[async_trait]
pub trait BrowserDriver: Send + Sync {
    async fn execute(&self, step: &ExecStep) -> Result<StepResult, DriverError>;
    async fn navigate(&self, url: &str) -> Result<(), DriverError>;
    async fn close(&self) -> Result<(), DriverError>;
}
