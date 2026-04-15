//! Job execution — pluggable via the [`JobExecutor`] trait so the render
//! queue actor can be driven by a real FFmpeg sidecar in production and
//! by a test double in unit tests.

use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use storage::RenderJob;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::error::{EncoderError, Result};
use crate::progress::RenderProgress;

/// Terminal outcome of a single render job.
#[derive(Debug, Clone)]
pub enum JobOutcome {
    /// Produced an output file at `path`.
    Completed { output_path: PathBuf },
    /// Job was cancelled before completion.
    Cancelled,
    /// Job failed with a stderr-tail diagnostic.
    Failed { message: String },
}

/// Pluggable render-job runner. Production uses [`FanoutJobExecutor`]
/// (wrapping `fanout::render_intermediate` + `fanout::fanout_encode`); tests
/// supply a scripted double.
#[async_trait]
pub trait JobExecutor: Send + Sync + 'static {
    /// Execute a single render job. Implementers MUST:
    /// - forward `RenderProgress` snapshots over `progress_tx`,
    /// - observe `cancel` (via `select!`) to abort cleanly,
    /// - return a [`JobOutcome`] (never `Err` for clean cancel — use
    ///   `JobOutcome::Cancelled`; only infrastructure failures bubble up
    ///   as `Err`).
    async fn execute(
        &self,
        job: RenderJob,
        progress_tx: mpsc::Sender<RenderProgress>,
        cancel: CancellationToken,
    ) -> Result<JobOutcome>;
}

/// Shared trait-object alias.
pub type SharedExecutor = Arc<dyn JobExecutor>;

/// A minimal test executor that emits a single progress update and
/// completes with a synthetic output path. Not used in production.
#[derive(Debug, Clone)]
pub struct NoopJobExecutor {
    pub output_root: PathBuf,
}

#[async_trait]
impl JobExecutor for NoopJobExecutor {
    async fn execute(
        &self,
        job: RenderJob,
        progress_tx: mpsc::Sender<RenderProgress>,
        cancel: CancellationToken,
    ) -> Result<JobOutcome> {
        // Emit a single progress snapshot (best-effort) so downstream
        // consumers have something to observe.
        let _ = progress_tx
            .send(RenderProgress {
                job_id: job.id,
                pct: 0.0,
                frame: 0,
                fps: 0.0,
                speed: 0.0,
                eta_ms: 0,
            })
            .await;

        // Allow cancel to race; otherwise complete immediately.
        tokio::select! {
            _ = cancel.cancelled() => Ok(JobOutcome::Cancelled),
            _ = tokio::time::sleep(std::time::Duration::from_millis(1)) => {
                let out = self.output_root.join(format!("{}.mp4", job.id));
                Ok(JobOutcome::Completed { output_path: out })
            }
        }
    }
}

/// Helper: map an `EncoderError` into a `JobOutcome::Failed` with a
/// stderr-tail-like diagnostic.
pub fn outcome_from_error(e: EncoderError) -> JobOutcome {
    JobOutcome::Failed {
        message: e.to_string(),
    }
}
