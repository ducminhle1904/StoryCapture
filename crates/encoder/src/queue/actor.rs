//! Render queue actor.
//!
//! A single tokio task owns the actor. It:
//!   1. On boot, calls `storage::render_job_repo::on_startup_mark_orphans`
//!      to flip any leftover `running` rows to `interrupted` (Pitfall #12).
//!   2. In a polling loop (mpsc-driven + periodic tick), queries the DB
//!      for pending jobs ordered by (priority DESC, created_at ASC) up to
//!      pool capacity, marks each `running`, and spawns a per-job task
//!      that drives the [`JobExecutor`].
//!   3. Forwards `RenderProgress` snapshots to a caller-supplied
//!      `mpsc::Sender<RenderProgress>` for the Tauri channel.
//!   4. On per-job completion, calls `mark_completed` / `mark_failed` /
//!      `cancel` in storage.
//!
//! The actor exposes a cheap cloneable `RenderQueueHandle` (one `mpsc`
//! sender behind the scenes) so Tauri commands can poke it.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use rusqlite::Connection;
use storage::repos::render_job_repo;
use tokio::sync::{mpsc, Mutex};
use tokio_util::sync::CancellationToken;
use tracing::{error, warn};
use uuid::Uuid;

use crate::error::{EncoderError, Result};
use crate::pool::{PoolConfig, SidecarPool};
use crate::progress::RenderProgress;
use crate::queue::job::{JobOutcome, SharedExecutor};

/// Messages the host/UI can push into the actor.
#[derive(Debug)]
pub enum QueueMsg {
    /// Hint the actor that a new job has landed in storage — it will
    /// run a poll cycle opportunistically. (Not required for correctness;
    /// the periodic tick picks it up otherwise.)
    Enqueue(Uuid),
    /// Cancel a running or pending job.
    Cancel(Uuid),
    /// Stop the actor loop.
    Shutdown,
    /// Test/host hook: drive one poll+spawn cycle synchronously and
    /// reply when all spawned jobs have finished. Used by integration
    /// tests to avoid polling timing games; production code shouldn't
    /// need it (the periodic tick covers the same ground).
    TickAndDrain(tokio::sync::oneshot::Sender<()>),
}

/// Cheap cloneable handle. Tauri commands hold one.
#[derive(Debug, Clone)]
pub struct RenderQueueHandle {
    tx: mpsc::Sender<QueueMsg>,
}

impl RenderQueueHandle {
    pub async fn send(&self, msg: QueueMsg) -> Result<()> {
        self.tx
            .send(msg)
            .await
            .map_err(|e| EncoderError::Io(format!("queue send: {e}")))
    }

    /// Accessor used only by tests that need to peek at the raw sender.
    #[cfg(test)]
    pub fn sender(&self) -> mpsc::Sender<QueueMsg> {
        self.tx.clone()
    }
}

/// Construction parameters. Kept as a struct so tests + production wire
/// the same knobs explicitly.
pub struct RenderQueueConfig {
    pub pool: PoolConfig,
    /// Periodic poll tick when the actor is idle.
    pub tick: Duration,
}

impl Default for RenderQueueConfig {
    fn default() -> Self {
        Self {
            pool: PoolConfig::default(),
            tick: Duration::from_millis(500),
        }
    }
}

pub struct RenderQueueActor {
    cfg: RenderQueueConfig,
    pool: SidecarPool,
    db: Arc<Mutex<Connection>>,
    executor: SharedExecutor,
    progress_tx: mpsc::Sender<RenderProgress>,
    rx: mpsc::Receiver<QueueMsg>,
    running: HashMap<Uuid, RunningJob>,
    /// Join receiver — completed jobs drop a result tuple here so the
    /// actor loop can reconcile DB state without racing.
    done_tx: mpsc::Sender<(Uuid, std::result::Result<JobOutcome, String>)>,
    done_rx: mpsc::Receiver<(Uuid, std::result::Result<JobOutcome, String>)>,
}

struct RunningJob {
    cancel: CancellationToken,
}

impl RenderQueueActor {
    /// Flip orphaned `running` rows to `interrupted` (resume-on-relaunch).
    pub async fn init_resume(&self) -> Result<u32> {
        let conn = self.db.lock().await;
        render_job_repo::on_startup_mark_orphans(&conn)
            .map_err(|e| EncoderError::Io(format!("on_startup_mark_orphans: {e}")))
    }

    async fn try_poll_and_spawn(&mut self) -> Result<()> {
        let capacity = self
            .pool
            .max_concurrent()
            .saturating_sub(self.running.len());
        if capacity == 0 {
            return Ok(());
        }
        let ready = {
            let conn = self.db.lock().await;
            render_job_repo::poll_ready(&conn, capacity as u32)
                .map_err(|e| EncoderError::Io(format!("poll_ready: {e}")))?
        };
        for job in ready {
            self.spawn_job(job).await?;
        }
        Ok(())
    }

    async fn spawn_job(&mut self, job: storage::RenderJob) -> Result<()> {
        let cancel = CancellationToken::new();
        self.running.insert(
            job.id,
            RunningJob {
                cancel: cancel.clone(),
            },
        );

        {
            let conn = self.db.lock().await;
            render_job_repo::mark_running(&conn, job.id)
                .map_err(|e| EncoderError::Io(format!("mark_running: {e}")))?;
        }

        let executor = self.executor.clone();
        let external_progress_tx = self.progress_tx.clone();
        let db = self.db.clone();
        let (progress_tx, mut progress_rx) = mpsc::channel::<RenderProgress>(64);
        let pool = self.pool.clone();
        let done_tx = self.done_tx.clone();
        let job_id = job.id;

        tokio::spawn(async move {
            while let Some(progress) = progress_rx.recv().await {
                {
                    let conn = db.lock().await;
                    if let Err(e) =
                        render_job_repo::update_progress(&conn, progress.job_id, progress.pct)
                    {
                        warn!(
                            job_id = %progress.job_id,
                            error = %e,
                            "update_progress failed"
                        );
                    }
                }
                let _ = external_progress_tx.send(progress).await;
            }
        });

        tokio::spawn(async move {
            // Permit binds the sidecar pool concurrency. When this task
            // returns, the permit drops and the next pending job becomes
            // eligible.
            let _permit = match pool.acquire().await {
                Ok(p) => Some(p),
                Err(e) => {
                    let _ = done_tx.send((job_id, Err(e.to_string()))).await;
                    return;
                }
            };

            let outcome = match executor.execute(job, progress_tx, cancel).await {
                Ok(o) => Ok(o),
                Err(e) => Err(e.to_string()),
            };
            let _ = done_tx.send((job_id, outcome)).await;
        });

        Ok(())
    }

    async fn reconcile_done(
        &mut self,
        job_id: Uuid,
        outcome: std::result::Result<JobOutcome, String>,
    ) {
        self.running.remove(&job_id);
        let conn = self.db.lock().await;
        match outcome {
            Ok(JobOutcome::Completed { output_path }) => {
                if let Err(e) = render_job_repo::mark_completed(&conn, job_id, &output_path) {
                    warn!(%job_id, error = %e, "mark_completed failed");
                }
            }
            Ok(JobOutcome::Cancelled) => {
                // `cancel` in storage only fires if the job is still in
                // pending|running — a completed/failed job would reject.
                if let Err(e) = render_job_repo::cancel(&conn, job_id) {
                    warn!(%job_id, error = %e, "cancel transition failed");
                }
            }
            Ok(JobOutcome::Failed { message }) => {
                if let Err(e) = render_job_repo::mark_failed(&conn, job_id, &message) {
                    warn!(%job_id, error = %e, "mark_failed transition failed");
                }
            }
            Err(message) => {
                if let Err(e) = render_job_repo::mark_failed(&conn, job_id, &message) {
                    warn!(%job_id, error = %e, "mark_failed (err) transition failed");
                }
            }
        }
    }

    async fn handle_msg(&mut self, msg: QueueMsg) -> bool {
        match msg {
            QueueMsg::Enqueue(_) => {
                if let Err(e) = self.try_poll_and_spawn().await {
                    warn!(error = %e, "poll_and_spawn after Enqueue failed");
                }
                true
            }
            QueueMsg::Cancel(id) => {
                if let Some(r) = self.running.get(&id) {
                    r.cancel.cancel();
                } else {
                    // Pending row: cancel directly in the DB. A running
                    // but somehow-unknown id (shouldn't happen) also ends
                    // up here.
                    let conn = self.db.lock().await;
                    if let Err(e) = render_job_repo::cancel(&conn, id) {
                        warn!(%id, error = %e, "cancel pending failed");
                    }
                }
                true
            }
            QueueMsg::Shutdown => false,
            QueueMsg::TickAndDrain(reply) => {
                if let Err(e) = self.try_poll_and_spawn().await {
                    warn!(error = %e, "poll failed during TickAndDrain");
                }
                while !self.running.is_empty() {
                    if let Some((id, out)) = self.done_rx.recv().await {
                        self.reconcile_done(id, out).await;
                    } else {
                        break;
                    }
                }
                let _ = reply.send(());
                true
            }
        }
    }

    pub async fn run(mut self) {
        if let Err(e) = self.init_resume().await {
            error!(error = %e, "init_resume failed");
        }
        let tick = self.cfg.tick;
        loop {
            tokio::select! {
                Some(msg) = self.rx.recv() => {
                    if !self.handle_msg(msg).await { break; }
                }
                Some((id, out)) = self.done_rx.recv() => {
                    self.reconcile_done(id, out).await;
                }
                _ = tokio::time::sleep(tick) => {
                    if let Err(e) = self.try_poll_and_spawn().await {
                        warn!(error = %e, "periodic poll failed");
                    }
                }
            }
        }
    }
}

/// Construct and spawn the render-queue actor task. Returns a cloneable
/// handle that Tauri commands + the UI can pass around.
pub async fn spawn_render_queue(
    cfg: RenderQueueConfig,
    db: Arc<Mutex<Connection>>,
    executor: SharedExecutor,
    progress_tx: mpsc::Sender<RenderProgress>,
) -> RenderQueueHandle {
    let (tx, rx) = mpsc::channel::<QueueMsg>(64);
    let (done_tx, done_rx) = mpsc::channel(64);
    let pool = SidecarPool::new(cfg.pool.clone());
    let actor = RenderQueueActor {
        cfg,
        pool,
        db,
        executor,
        progress_tx,
        rx,
        running: HashMap::new(),
        done_tx,
        done_rx,
    };
    tokio::spawn(actor.run());
    RenderQueueHandle { tx }
}

/// Host-side helper: open a `project.sqlite` connection wrapped in a
/// tokio `Mutex` so both the actor and Tauri commands can share it.
pub fn open_project_conn(path: &Path) -> Result<Arc<Mutex<Connection>>> {
    let conn = Connection::open(path)
        .map_err(|e| EncoderError::Io(format!("open project db {}: {e}", path.display())))?;
    Ok(Arc::new(Mutex::new(conn)))
}
