// Dry-Run IPC.
//
// `dryrun_start` spawns a DryRunOrchestrator task against a mock
// BrowserDriver (real driver wired when Phase 1 `phase1-wired` feature
// is enabled). Events stream to the renderer via `Channel<DryRunEventDto>`.
//
// `dryrun_cancel` aborts a running dry-run task by its task_id.

use crate::error::AppError;
use intelligence::dryrun::{run, DryRunEvent, ExecStep};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::OnceLock;
use tauri::ipc::Channel;
use tokio::task::AbortHandle;
use uuid::Uuid;

// ---------------------------------------------------------------------------
// DTO — wraps intelligence crate's DryRunEvent for specta/IPC
// ---------------------------------------------------------------------------

/// IPC wrapper around `intelligence::dryrun::DryRunEvent`.
///
/// The `intelligence` crate is pure (no specta dependency). We wrap the
/// event into JSON so the `Channel<T>` payload type satisfies `specta::Type`
/// without leaking Tauri into `intelligence`.
#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct DryRunEventDto {
    /// JSON-stringified `DryRunEvent`.
    pub json: String,
}

impl From<DryRunEvent> for DryRunEventDto {
    fn from(e: DryRunEvent) -> Self {
        DryRunEventDto {
            json: serde_json::to_string(&e).unwrap_or_else(|_| "{}".into()),
        }
    }
}

/// Input steps from the webview (matches ExecStep shape).
#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct DryRunStepDto {
    pub id: String,
    pub verb: String,
    pub target: Option<String>,
    pub value: Option<String>,
}

impl From<DryRunStepDto> for ExecStep {
    fn from(dto: DryRunStepDto) -> Self {
        ExecStep {
            id: dto.id,
            verb: dto.verb,
            target: dto.target,
            value: dto.value,
        }
    }
}

// ---------------------------------------------------------------------------
// Task registry — mirrors CaptureRegistry pattern from commands/capture.rs
// ---------------------------------------------------------------------------

#[derive(Default)]
struct DryRunTaskRegistry {
    inner: Mutex<HashMap<String, AbortHandle>>,
}

impl DryRunTaskRegistry {
    fn insert(&self, task_id: String, handle: AbortHandle) {
        self.inner.lock().insert(task_id, handle);
    }

    fn abort(&self, task_id: &str) -> bool {
        if let Some(handle) = self.inner.lock().remove(task_id) {
            handle.abort();
            true
        } else {
            false
        }
    }

    fn remove(&self, task_id: &str) {
        self.inner.lock().remove(task_id);
    }
}

fn registry() -> &'static DryRunTaskRegistry {
    static REGISTRY: OnceLock<DryRunTaskRegistry> = OnceLock::new();
    REGISTRY.get_or_init(DryRunTaskRegistry::default)
}

// ---------------------------------------------------------------------------
// Mock driver for when Phase 1 is not wired
// ---------------------------------------------------------------------------

// TODO(phase-1): When the `phase1-wired` feature is enabled, construct
// a real BrowserDriver here instead of the mock. The orchestrator API
// is trait-generic so no behavioural change is needed — just swap the
// concrete type.
use intelligence::dryrun::{BrowserDriver, DriverError, SelectorAttempt, StepResult};

struct StubBrowserDriver;

#[async_trait::async_trait]
impl BrowserDriver for StubBrowserDriver {
    async fn execute(
        &self,
        _step: &ExecStep,
    ) -> Result<StepResult, DriverError> {
        // Simulate instant success with no selector attempts.
        Ok(StepResult {
            elapsed_ms: 1,
            selector_attempts: vec![SelectorAttempt {
                strategy: "stub".into(),
                success: true,
                elapsed_ms: 1,
            }],
            screenshot: None,
        })
    }

    async fn navigate(&self, _url: &str) -> Result<(), DriverError> {
        Ok(())
    }

    async fn close(&self) -> Result<(), DriverError> {
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Start a dry-run against the given steps.
///
/// Returns a `task_id` that can be passed to `dryrun_cancel` to abort.
/// Events are streamed to the renderer via `on_event`.
#[tauri::command]
#[specta::specta]
pub async fn dryrun_start(
    steps: Vec<DryRunStepDto>,
    on_event: Channel<DryRunEventDto>,
) -> Result<String, AppError> {
    if steps.is_empty() {
        return Err(AppError::InvalidArgument(
            "dry-run requires at least one step".into(),
        ));
    }

    let exec_steps: Vec<ExecStep> = steps.into_iter().map(Into::into).collect();
    let task_id = Uuid::new_v4().to_string();
    let task_id_clone = task_id.clone();

    // TODO(phase-1): Replace StubBrowserDriver with real driver.
    let driver = StubBrowserDriver;

    let (tx, mut rx) = tokio::sync::mpsc::channel::<DryRunEvent>(64);

    // Forwarder task: pump events from the orchestrator to the Tauri channel.
    let on_event_clone = on_event.clone();
    let task_id_for_cleanup = task_id.clone();
    let join = tokio::spawn(async move {
        // Spawn the orchestrator.
        let orch_tx = tx;
        let orch_task_id = task_id_clone;
        let exec = exec_steps;
        let orch = tokio::spawn(async move {
            run(&driver, exec, orch_task_id, orch_tx).await.ok();
        });

        // Forward events to the renderer channel.
        while let Some(ev) = rx.recv().await {
            if let Err(e) = on_event_clone.send(DryRunEventDto::from(ev)) {
                tracing::warn!(
                    target: "storycapture::dryrun",
                    "channel send failed: {e}"
                );
                break;
            }
        }

        // Wait for orchestrator to finish.
        let _ = orch.await;

        // Clean up registry entry.
        registry().remove(&task_id_for_cleanup);
    });

    // Store the abort handle so dryrun_cancel can stop the task.
    registry().insert(task_id.clone(), join.abort_handle());

    Ok(task_id)
}

/// Cancel a running dry-run by task_id.
#[tauri::command]
#[specta::specta]
pub async fn dryrun_cancel(task_id: String) -> Result<(), AppError> {
    if registry().abort(&task_id) {
        Ok(())
    } else {
        Err(AppError::NotFound(format!(
            "dry-run task {task_id} not found or already completed"
        )))
    }
}
