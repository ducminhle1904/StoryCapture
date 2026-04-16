// Dry-Run orchestrator (D-19).
//
// Iterates through DSL steps, invoking `BrowserDriver::execute` for each,
// and emitting `DryRunEvent` variants through an mpsc channel. Stops on
// first failure (per D-19 "log selector fallback chain on first mismatch").

use serde::Serialize;
use tokio::sync::mpsc;

use super::{BrowserDriver, ExecStep, SelectorAttempt};
use crate::IntelError;

/// Events streamed to the webview via `Channel<DryRunEvent>`.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DryRunEvent {
    Queued {
        step_id: String,
    },
    Running {
        step_id: String,
    },
    Pass {
        step_id: String,
        elapsed_ms: u64,
        selector_attempts: Vec<SelectorAttempt>,
    },
    Fail {
        step_id: String,
        error: String,
        selector_attempts: Vec<SelectorAttempt>,
    },
    Summary {
        total_steps: u32,
        passed: u32,
        failed: u32,
        total_ms: u64,
    },
    Done {
        task_id: String,
    },
    Error {
        message: String,
    },
}

/// Marker struct for namespacing. All functionality is in the free `run` function.
pub struct DryRunOrchestrator;

/// Execute a dry-run: iterate `steps` against `driver`, emitting status events
/// through `tx`. Stops on first failure.
///
/// The caller is expected to `tokio::spawn` this and store the resulting
/// `AbortHandle` for cancellation support.
pub async fn run<D: BrowserDriver + ?Sized>(
    driver: &D,
    steps: Vec<ExecStep>,
    task_id: String,
    tx: mpsc::Sender<DryRunEvent>,
) -> Result<(), IntelError> {
    let total = steps.len() as u32;
    let mut passed = 0u32;
    let mut failed = 0u32;
    let mut total_ms = 0u64;

    // Emit Queued for all steps up front so the UI can show the full plan.
    for s in &steps {
        tx.send(DryRunEvent::Queued {
            step_id: s.id.clone(),
        })
        .await
        .ok();
    }

    // Execute sequentially, stop on first failure.
    for s in &steps {
        tx.send(DryRunEvent::Running {
            step_id: s.id.clone(),
        })
        .await
        .ok();

        match driver.execute(s).await {
            Ok(r) => {
                total_ms += r.elapsed_ms;
                passed += 1;
                tx.send(DryRunEvent::Pass {
                    step_id: s.id.clone(),
                    elapsed_ms: r.elapsed_ms,
                    selector_attempts: r.selector_attempts,
                })
                .await
                .ok();
            }
            Err(e) => {
                failed += 1;
                tx.send(DryRunEvent::Fail {
                    step_id: s.id.clone(),
                    error: e.to_string(),
                    selector_attempts: e.selector_attempts(),
                })
                .await
                .ok();
                break; // stop on first failure per D-19
            }
        }
    }

    tx.send(DryRunEvent::Summary {
        total_steps: total,
        passed,
        failed,
        total_ms,
    })
    .await
    .ok();

    tx.send(DryRunEvent::Done { task_id }).await.ok();

    Ok(())
}
