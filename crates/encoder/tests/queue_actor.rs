//! Integration tests for the render queue actor (Plan 02-10 / Task 2).
//!
//! These tests use the `NoopJobExecutor` + an in-memory project.sqlite
//! (seeded via `storage::migrations::project`) so they don't depend on
//! a real FFmpeg binary.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use encoder::queue::actor::{spawn_render_queue, QueueMsg, RenderQueueConfig, RenderQueueHandle};
use encoder::queue::job::{JobExecutor, JobOutcome, NoopJobExecutor, SharedExecutor};
use encoder::{PoolConfig, RenderProgress};
use rusqlite::Connection;
use storage::migrations::project as project_migrations;
use storage::repos::render_job_repo;
use storage::{NewRenderJob, RenderJobStatus};
use tokio::sync::{mpsc, Mutex};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

fn fresh_db() -> Arc<Mutex<Connection>> {
    let mut c = Connection::open_in_memory().unwrap();
    project_migrations::migrations().to_latest(&mut c).unwrap();
    Arc::new(Mutex::new(c))
}

fn new_job(story: &str, priority: i32) -> NewRenderJob {
    NewRenderJob {
        story_id: story.into(),
        preset_id: None,
        format: "mp4".into(),
        resolution: "1080p".into(),
        fps: 60,
        quality: "high".into(),
        priority,
        batch_id: None,
    }
}

async fn seed(db: &Arc<Mutex<Connection>>, j: &NewRenderJob) -> Uuid {
    let conn = db.lock().await;
    render_job_repo::enqueue(&conn, j).unwrap()
}

async fn tick_and_drain(handle: &RenderQueueHandle) {
    let (tx, rx) = tokio::sync::oneshot::channel();
    handle.send(QueueMsg::TickAndDrain(tx)).await.unwrap();
    let _ = rx.await;
}

fn default_cfg(pool_size: usize) -> RenderQueueConfig {
    RenderQueueConfig {
        pool: PoolConfig {
            max_concurrent: pool_size,
            cancel_grace: Duration::from_millis(200),
        },
        tick: Duration::from_millis(50),
    }
}

#[tokio::test]
async fn actor_polls_pending_up_to_pool_capacity() {
    let db = fresh_db();
    seed(&db, &new_job("s1", 0)).await;
    seed(&db, &new_job("s1", 0)).await;
    seed(&db, &new_job("s1", 0)).await;

    // Blocking executor — jobs hang until released. This lets us observe
    // the "2 running + 1 pending" state precisely.
    #[derive(Clone)]
    struct Blocking(Arc<tokio::sync::Notify>);
    #[async_trait]
    impl JobExecutor for Blocking {
        async fn execute(
            &self,
            job: storage::RenderJob,
            _progress_tx: mpsc::Sender<RenderProgress>,
            _cancel: CancellationToken,
        ) -> encoder::Result<JobOutcome> {
            self.0.notified().await;
            Ok(JobOutcome::Completed {
                output_path: PathBuf::from(format!("/tmp/{}.mp4", job.id)),
            })
        }
    }

    let notify = Arc::new(tokio::sync::Notify::new());
    let exec: SharedExecutor = Arc::new(Blocking(notify.clone()));
    let (prog_tx, _prog_rx) = mpsc::channel::<RenderProgress>(64);
    let handle = spawn_render_queue(default_cfg(2), db.clone(), exec, prog_tx).await;

    // Nudge the actor; two jobs should transition to running.
    handle.send(QueueMsg::Enqueue(Uuid::nil())).await.unwrap();
    // Wait for the actor to persist `mark_running` for both jobs.
    for _ in 0..100 {
        let conn = db.lock().await;
        let mut stmt = conn
            .prepare("SELECT COUNT(*) FROM render_jobs WHERE status='running'")
            .unwrap();
        let n: i64 = stmt.query_row([], |r| r.get(0)).unwrap();
        if n == 2 {
            break;
        }
        drop(stmt);
        drop(conn);
        tokio::time::sleep(Duration::from_millis(10)).await;
    }

    {
        let conn = db.lock().await;
        let mut stmt = conn
            .prepare("SELECT status, COUNT(*) FROM render_jobs GROUP BY status")
            .unwrap();
        let rows: Vec<(String, i64)> = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        let map: std::collections::HashMap<_, _> = rows.into_iter().collect();
        assert_eq!(map.get("running").copied(), Some(2), "map={map:?}");
        assert_eq!(map.get("pending").copied(), Some(1), "map={map:?}");
    }

    // Release the two running jobs so the test can complete cleanly.
    notify.notify_waiters();
    notify.notify_waiters();
    handle.send(QueueMsg::Shutdown).await.unwrap();
}

#[tokio::test]
async fn actor_priority_order() {
    let db = fresh_db();
    let low = seed(&db, &new_job("s1", 0)).await;
    tokio::time::sleep(Duration::from_millis(2)).await;
    let high = seed(&db, &new_job("s1", 10)).await;
    tokio::time::sleep(Duration::from_millis(2)).await;
    let mid = seed(&db, &new_job("s1", 5)).await;

    let exec: SharedExecutor = Arc::new(NoopJobExecutor {
        output_root: PathBuf::from("/tmp"),
    });
    let (prog_tx, _rx) = mpsc::channel(64);
    let handle = spawn_render_queue(default_cfg(1), db.clone(), exec, prog_tx).await;
    // Tick: pool_size=1 so only `high` should be picked up first.
    tick_and_drain(&handle).await;

    {
        let conn = db.lock().await;
        let high_row = render_job_repo::get(&conn, high).unwrap().unwrap();
        assert_eq!(high_row.status, RenderJobStatus::Completed);
        // mid and low should still be pending.
        let mid_row = render_job_repo::get(&conn, mid).unwrap().unwrap();
        assert_eq!(mid_row.status, RenderJobStatus::Pending);
        let low_row = render_job_repo::get(&conn, low).unwrap().unwrap();
        assert_eq!(low_row.status, RenderJobStatus::Pending);
    }

    // Next tick picks `mid` (next highest priority).
    tick_and_drain(&handle).await;
    {
        let conn = db.lock().await;
        let mid_row = render_job_repo::get(&conn, mid).unwrap().unwrap();
        assert_eq!(mid_row.status, RenderJobStatus::Completed);
        let low_row = render_job_repo::get(&conn, low).unwrap().unwrap();
        assert_eq!(low_row.status, RenderJobStatus::Pending);
    }
    handle.send(QueueMsg::Shutdown).await.unwrap();
}

#[tokio::test]
async fn actor_cancel_marks_cancelled() {
    let db = fresh_db();
    let id = seed(&db, &new_job("s1", 0)).await;

    #[derive(Clone)]
    struct Hangs(Arc<tokio::sync::Notify>);
    #[async_trait]
    impl JobExecutor for Hangs {
        async fn execute(
            &self,
            _job: storage::RenderJob,
            _progress_tx: mpsc::Sender<RenderProgress>,
            cancel: CancellationToken,
        ) -> encoder::Result<JobOutcome> {
            self.0.notify_waiters();
            cancel.cancelled().await;
            Ok(JobOutcome::Cancelled)
        }
    }

    let running_started = Arc::new(tokio::sync::Notify::new());
    let exec: SharedExecutor = Arc::new(Hangs(running_started.clone()));
    let (prog_tx, _rx) = mpsc::channel(64);
    let handle = spawn_render_queue(default_cfg(1), db.clone(), exec, prog_tx).await;
    handle.send(QueueMsg::Enqueue(id)).await.unwrap();

    // Wait for the executor to actually begin running.
    tokio::time::timeout(Duration::from_secs(1), running_started.notified())
        .await
        .expect("executor started");

    handle.send(QueueMsg::Cancel(id)).await.unwrap();

    // Poll for the DB row to reach Cancelled.
    for _ in 0..100 {
        let conn = db.lock().await;
        let row = render_job_repo::get(&conn, id).unwrap().unwrap();
        if row.status == RenderJobStatus::Cancelled {
            return;
        }
        drop(conn);
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("job never transitioned to cancelled");
}

#[tokio::test]
async fn actor_completion_marks_completed_with_output_path() {
    let db = fresh_db();
    let id = seed(&db, &new_job("s1", 0)).await;
    let exec: SharedExecutor = Arc::new(NoopJobExecutor {
        output_root: PathBuf::from("/tmp/renders"),
    });
    let (prog_tx, _rx) = mpsc::channel(64);
    let handle = spawn_render_queue(default_cfg(1), db.clone(), exec, prog_tx).await;
    tick_and_drain(&handle).await;

    let conn = db.lock().await;
    let row = render_job_repo::get(&conn, id).unwrap().unwrap();
    assert_eq!(row.status, RenderJobStatus::Completed);
    assert_eq!(row.progress_pct, 100.0);
    let out = row.output_path.unwrap();
    assert!(out.to_string_lossy().contains("/tmp/renders"));
}

#[tokio::test]
async fn actor_failure_marks_failed() {
    let db = fresh_db();
    let id = seed(&db, &new_job("s1", 0)).await;

    struct Bombs;
    #[async_trait]
    impl JobExecutor for Bombs {
        async fn execute(
            &self,
            _job: storage::RenderJob,
            _progress_tx: mpsc::Sender<RenderProgress>,
            _cancel: CancellationToken,
        ) -> encoder::Result<JobOutcome> {
            Ok(JobOutcome::Failed {
                message: "ffmpeg exited 1: invalid codec".into(),
            })
        }
    }

    let exec: SharedExecutor = Arc::new(Bombs);
    let (prog_tx, _rx) = mpsc::channel(64);
    let handle = spawn_render_queue(default_cfg(1), db.clone(), exec, prog_tx).await;
    tick_and_drain(&handle).await;

    let conn = db.lock().await;
    let row = render_job_repo::get(&conn, id).unwrap().unwrap();
    assert_eq!(row.status, RenderJobStatus::Failed);
    assert!(row.error.as_deref().unwrap().contains("invalid codec"));
}

#[tokio::test]
async fn on_boot_marks_orphans() {
    let db = fresh_db();
    let id = seed(&db, &new_job("s1", 0)).await;
    {
        let conn = db.lock().await;
        render_job_repo::mark_running(&conn, id).unwrap();
    }
    // Spawning the actor runs init_resume internally.
    let exec: SharedExecutor = Arc::new(NoopJobExecutor {
        output_root: PathBuf::from("/tmp"),
    });
    let (prog_tx, _rx) = mpsc::channel(64);
    let handle = spawn_render_queue(default_cfg(1), db.clone(), exec, prog_tx).await;
    // Give the actor time to run init_resume.
    tokio::time::sleep(Duration::from_millis(50)).await;

    let conn = db.lock().await;
    let row = render_job_repo::get(&conn, id).unwrap().unwrap();
    assert_eq!(row.status, RenderJobStatus::Interrupted);
    drop(conn);
    handle.send(QueueMsg::Shutdown).await.unwrap();
}

#[tokio::test]
async fn actor_cancel_pending_job() {
    let db = fresh_db();
    // Pool size 1 + long-running first job means the second stays pending
    // and can be cancelled purely through the DB path.
    let blocker = seed(&db, &new_job("s1", 10)).await;
    let pending = seed(&db, &new_job("s1", 0)).await;

    #[derive(Clone)]
    struct Blocks(Arc<tokio::sync::Notify>);
    #[async_trait]
    impl JobExecutor for Blocks {
        async fn execute(
            &self,
            _job: storage::RenderJob,
            _progress_tx: mpsc::Sender<RenderProgress>,
            _cancel: CancellationToken,
        ) -> encoder::Result<JobOutcome> {
            self.0.notified().await;
            Ok(JobOutcome::Completed {
                output_path: PathBuf::from("/tmp/done.mp4"),
            })
        }
    }
    let release = Arc::new(tokio::sync::Notify::new());
    let exec: SharedExecutor = Arc::new(Blocks(release.clone()));
    let (prog_tx, _rx) = mpsc::channel(64);
    let handle = spawn_render_queue(default_cfg(1), db.clone(), exec, prog_tx).await;

    // Let the actor pick up `blocker`.
    for _ in 0..100 {
        let conn = db.lock().await;
        let row = render_job_repo::get(&conn, blocker).unwrap().unwrap();
        if row.status == RenderJobStatus::Running {
            break;
        }
        drop(conn);
        tokio::time::sleep(Duration::from_millis(10)).await;
    }

    handle.send(QueueMsg::Cancel(pending)).await.unwrap();
    // Wait for cancelled status.
    for _ in 0..100 {
        let conn = db.lock().await;
        let row = render_job_repo::get(&conn, pending).unwrap().unwrap();
        if row.status == RenderJobStatus::Cancelled {
            release.notify_waiters();
            return;
        }
        drop(conn);
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("pending job was not cancelled");
}
