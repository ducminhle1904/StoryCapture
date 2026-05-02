//! Render queue repository. Implements the priority-poll + resume
//! semantics used by the background render queue.

use crate::error::StorageError;
use crate::models::{now_millis, NewRenderJob, RenderJob, RenderJobStatus};
use rusqlite::{params, Connection};
use std::path::{Path, PathBuf};
use std::str::FromStr;
use uuid::Uuid;

fn parse_uuid(s: &str) -> Result<Uuid, rusqlite::Error> {
    Uuid::parse_str(s).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
    })
}

fn row_to_job(row: &rusqlite::Row<'_>) -> rusqlite::Result<RenderJob> {
    let id: String = row.get(0)?;
    let preset_id: Option<String> = row.get(2)?;
    let status: String = row.get(7)?;
    let output_path: Option<String> = row.get(13)?;
    Ok(RenderJob {
        id: parse_uuid(&id)?,
        story_id: row.get(1)?,
        preset_id: match preset_id {
            Some(s) => Some(parse_uuid(&s)?),
            None => None,
        },
        format: row.get(3)?,
        resolution: row.get(4)?,
        fps: row.get::<_, i64>(5)? as u32,
        quality: row.get(6)?,
        status: RenderJobStatus::from_str(&status).map_err(|e| {
            rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, e.into())
        })?,
        progress_pct: row.get::<_, f64>(8)? as f32,
        started_at: row.get(9)?,
        completed_at: row.get(10)?,
        error: row.get(11)?,
        priority: row.get::<_, i64>(12)? as i32,
        output_path: output_path.map(PathBuf::from),
        batch_id: row.get(14)?,
        created_at: row.get(15)?,
    })
}

const SELECT_COLS: &str = "id, story_id, preset_id, format, resolution, fps, quality, status, progress_pct, started_at, completed_at, error, priority, output_path, batch_id, created_at";

/// Default retention window for terminal (completed/failed/cancelled) rows.
/// Prevents the render_jobs table from growing unboundedly over months of
/// usage while still leaving enough history for the "recent exports" UI.
const DEFAULT_RETENTION_LIMIT: usize = 100;

pub fn enqueue(conn: &Connection, j: &NewRenderJob) -> Result<Uuid, StorageError> {
    let id = Uuid::now_v7();
    let created_at = now_millis();
    conn.execute(
        "INSERT INTO render_jobs (id, story_id, preset_id, format, resolution, fps, quality, status, progress_pct, priority, output_path, batch_id, created_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'pending', 0.0, ?8, ?9, ?10, ?11)",
        params![
            id.to_string(),
            j.story_id,
            j.preset_id.map(|u| u.to_string()),
            j.format,
            j.resolution,
            j.fps as i64,
            j.quality,
            j.priority as i64,
            j.output_path
                .as_ref()
                .map(|p| p.to_string_lossy().to_string()),
            j.batch_id,
            created_at,
        ],
    )?;
    // Amortise retention pruning across enqueues. Non-terminal rows are
    // untouched; only the OLDEST completed/failed/cancelled rows beyond
    // the retention window are removed.
    let _ = prune_completed_before(conn, DEFAULT_RETENTION_LIMIT)?;
    Ok(id)
}

/// Delete terminal (completed/failed/cancelled) rows beyond the most
/// recent `limit` entries, ordered by `created_at` descending. Non-
/// terminal rows (pending/running/interrupted) are never touched.
///
/// Returns the number of rows deleted.
pub fn prune_completed_before(conn: &Connection, limit: usize) -> Result<u32, StorageError> {
    let n = conn.execute(
        "DELETE FROM render_jobs \
         WHERE status IN ('completed','failed','cancelled') \
         AND id NOT IN ( \
             SELECT id FROM render_jobs \
             WHERE status IN ('completed','failed','cancelled') \
             ORDER BY created_at DESC \
             LIMIT ?1 \
         )",
        params![limit as i64],
    )?;
    Ok(n as u32)
}

/// Priority poll: highest-priority pending jobs first, FIFO within same
/// priority. Does NOT mutate status — the caller chooses which to pick up.
pub fn poll_ready(conn: &Connection, limit: u32) -> Result<Vec<RenderJob>, StorageError> {
    let mut stmt = conn.prepare_cached(&format!(
        "SELECT {SELECT_COLS} FROM render_jobs WHERE status='pending' ORDER BY priority DESC, created_at ASC LIMIT ?1"
    ))?;
    let rows = stmt
        .query_map(params![limit as i64], row_to_job)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn get(conn: &Connection, id: Uuid) -> Result<Option<RenderJob>, StorageError> {
    let row = conn
        .query_row(
            &format!("SELECT {SELECT_COLS} FROM render_jobs WHERE id = ?1"),
            params![id.to_string()],
            row_to_job,
        )
        .optional()?;
    Ok(row)
}

pub fn mark_running(conn: &Connection, id: Uuid) -> Result<(), StorageError> {
    let now = now_millis();
    let n = conn.execute(
        "UPDATE render_jobs SET status='running', started_at=?1 WHERE id=?2 AND status='pending'",
        params![now, id.to_string()],
    )?;
    if n == 0 {
        return Err(StorageError::NotFound(format!("pending render job {id}")));
    }
    Ok(())
}

pub fn update_progress(conn: &Connection, id: Uuid, pct: f32) -> Result<(), StorageError> {
    let pct = pct.clamp(0.0, 100.0);
    conn.execute(
        "UPDATE render_jobs SET progress_pct=?1 WHERE id=?2 AND status='running'",
        params![pct as f64, id.to_string()],
    )?;
    Ok(())
}

pub fn mark_completed(conn: &Connection, id: Uuid, output_path: &Path) -> Result<(), StorageError> {
    let now = now_millis();
    let out = output_path.to_string_lossy().to_string();
    let n = conn.execute(
        "UPDATE render_jobs SET status='completed', completed_at=?1, progress_pct=100.0, output_path=?2 WHERE id=?3",
        params![now, out, id.to_string()],
    )?;
    if n == 0 {
        return Err(StorageError::NotFound(format!("render job {id}")));
    }
    Ok(())
}

pub fn mark_failed(conn: &Connection, id: Uuid, error: &str) -> Result<(), StorageError> {
    let now = now_millis();
    let n = conn.execute(
        "UPDATE render_jobs SET status='failed', completed_at=?1, error=?2 WHERE id=?3",
        params![now, error, id.to_string()],
    )?;
    if n == 0 {
        return Err(StorageError::NotFound(format!("render job {id}")));
    }
    Ok(())
}

/// Cancel only if currently pending or running.
pub fn cancel(conn: &Connection, id: Uuid) -> Result<(), StorageError> {
    let now = now_millis();
    let n = conn.execute(
        "UPDATE render_jobs SET status='cancelled', completed_at=?1 \
         WHERE id=?2 AND status IN ('pending','running')",
        params![now, id.to_string()],
    )?;
    if n == 0 {
        return Err(StorageError::NotFound(format!(
            "cancellable render job {id}"
        )));
    }
    Ok(())
}

/// Resume-on-relaunch: any job left in 'running' when the app starts was
/// orphaned by a crash/quit and must be marked 'interrupted' so the UI
/// can prompt the user to retry. Returns number of affected rows.
pub fn on_startup_mark_orphans(conn: &Connection) -> Result<u32, StorageError> {
    let n = conn.execute(
        "UPDATE render_jobs SET status='interrupted' WHERE status='running'",
        [],
    )?;
    Ok(n as u32)
}

pub fn list_active(conn: &Connection, story_id: &str) -> Result<Vec<RenderJob>, StorageError> {
    let mut stmt = conn.prepare_cached(&format!(
        "SELECT {SELECT_COLS} FROM render_jobs WHERE story_id=?1 AND status IN ('pending','running','interrupted') ORDER BY priority DESC, created_at ASC"
    ))?;
    let rows = stmt
        .query_map(params![story_id], row_to_job)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn list_by_batch(conn: &Connection, batch_id: &str) -> Result<Vec<RenderJob>, StorageError> {
    let mut stmt = conn.prepare_cached(&format!(
        "SELECT {SELECT_COLS} FROM render_jobs WHERE batch_id=?1 ORDER BY created_at ASC"
    ))?;
    let rows = stmt
        .query_map(params![batch_id], row_to_job)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

use rusqlite::OptionalExtension;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::migrations::project;

    fn conn() -> Connection {
        let mut c = Connection::open_in_memory().unwrap();
        project::migrations().to_latest(&mut c).unwrap();
        c
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
            output_path: None,
            batch_id: None,
        }
    }

    #[test]
    fn enqueue_and_poll_priority_order() {
        let c = conn();
        let low = enqueue(&c, &new_job("s1", 0)).unwrap();
        // Ensure strictly increasing created_at ordering between rows.
        std::thread::sleep(std::time::Duration::from_millis(2));
        let high = enqueue(&c, &new_job("s1", 10)).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(2));
        let mid = enqueue(&c, &new_job("s1", 5)).unwrap();

        let ready = poll_ready(&c, 10).unwrap();
        assert_eq!(ready.len(), 3);
        assert_eq!(ready[0].id, high);
        assert_eq!(ready[1].id, mid);
        assert_eq!(ready[2].id, low);
    }

    #[test]
    fn running_to_completed_lifecycle() {
        let c = conn();
        let id = enqueue(&c, &new_job("s1", 0)).unwrap();
        mark_running(&c, id).unwrap();
        update_progress(&c, id, 42.5).unwrap();
        let j = get(&c, id).unwrap().unwrap();
        assert_eq!(j.status, RenderJobStatus::Running);
        assert!((j.progress_pct - 42.5).abs() < 0.01);
        mark_completed(&c, id, Path::new("exports/out.mp4")).unwrap();
        let j = get(&c, id).unwrap().unwrap();
        assert_eq!(j.status, RenderJobStatus::Completed);
        assert_eq!(j.progress_pct, 100.0);
        assert_eq!(j.output_path.unwrap(), PathBuf::from("exports/out.mp4"));
    }

    #[test]
    fn cancel_transitions_only_pending_or_running() {
        let c = conn();
        let id = enqueue(&c, &new_job("s1", 0)).unwrap();
        cancel(&c, id).unwrap();
        assert_eq!(
            get(&c, id).unwrap().unwrap().status,
            RenderJobStatus::Cancelled
        );
        // Second cancel fails (not in pending/running).
        assert!(cancel(&c, id).is_err());
    }

    #[test]
    fn orphan_detection_flips_running_to_interrupted() {
        let c = conn();
        let id = enqueue(&c, &new_job("s1", 0)).unwrap();
        mark_running(&c, id).unwrap();
        // Simulate crash: on_startup_mark_orphans should flip this row.
        let affected = on_startup_mark_orphans(&c).unwrap();
        assert_eq!(affected, 1);
        assert_eq!(
            get(&c, id).unwrap().unwrap().status,
            RenderJobStatus::Interrupted
        );
    }

    #[test]
    fn list_active_and_batch() {
        let c = conn();
        let j1 = enqueue(
            &c,
            &NewRenderJob {
                batch_id: Some("batchA".into()),
                ..new_job("s1", 0)
            },
        )
        .unwrap();
        std::thread::sleep(std::time::Duration::from_millis(2));
        let j2 = enqueue(
            &c,
            &NewRenderJob {
                batch_id: Some("batchA".into()),
                ..new_job("s1", 0)
            },
        )
        .unwrap();
        let done = enqueue(&c, &new_job("s1", 0)).unwrap();
        mark_running(&c, done).unwrap();
        mark_completed(&c, done, Path::new("x")).unwrap();

        let active = list_active(&c, "s1").unwrap();
        assert_eq!(active.len(), 2);
        let batch = list_by_batch(&c, "batchA").unwrap();
        assert_eq!(batch.len(), 2);
        assert_eq!(batch[0].id, j1);
        assert_eq!(batch[1].id, j2);
    }

    #[test]
    fn prune_completed_before_retains_limit_terminal_rows_and_never_touches_active() {
        let c = conn();
        // Seed 5 completed jobs with strictly increasing created_at.
        let mut terminal_ids = Vec::new();
        for i in 0..5 {
            let id = enqueue(&c, &new_job(&format!("term-{i}"), 0)).unwrap();
            mark_running(&c, id).unwrap();
            mark_completed(&c, id, Path::new("x")).unwrap();
            terminal_ids.push(id);
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
        // One failed + one cancelled to exercise both terminal classes.
        let failed = enqueue(&c, &new_job("failed", 0)).unwrap();
        mark_running(&c, failed).unwrap();
        mark_failed(&c, failed, "boom").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(2));
        let cancelled = enqueue(&c, &new_job("cancel", 0)).unwrap();
        cancel(&c, cancelled).unwrap();

        // Add a live pending + running job — must survive pruning.
        let live_pending = enqueue(&c, &new_job("live", 0)).unwrap();
        let live_running = enqueue(&c, &new_job("live2", 0)).unwrap();
        mark_running(&c, live_running).unwrap();

        // Retain only the 2 most recent terminal rows; expect 5 deletes.
        let deleted = prune_completed_before(&c, 2).unwrap();
        assert_eq!(deleted, 5);

        // Live rows untouched.
        assert!(get(&c, live_pending).unwrap().is_some());
        assert!(get(&c, live_running).unwrap().is_some());

        // The 2 most recently-created terminal rows (cancelled, failed)
        // should survive; older completed rows should be gone.
        assert!(get(&c, cancelled).unwrap().is_some());
        assert!(get(&c, failed).unwrap().is_some());
        for id in &terminal_ids {
            assert!(
                get(&c, *id).unwrap().is_none(),
                "older completed row {id} should have been pruned"
            );
        }
    }

    #[test]
    fn enqueue_triggers_retention_pruning() {
        let c = conn();
        // Seed DEFAULT_RETENTION_LIMIT+5 completed rows, each followed by
        // a short sleep so created_at is strictly monotonic.
        let mut terminal_ids = Vec::new();
        for i in 0..(DEFAULT_RETENTION_LIMIT + 5) {
            let id = enqueue(&c, &new_job(&format!("j-{i}"), 0)).unwrap();
            mark_running(&c, id).unwrap();
            mark_completed(&c, id, Path::new("x")).unwrap();
            terminal_ids.push(id);
        }
        // After the next enqueue, the terminal-row count should be capped.
        let fresh = enqueue(&c, &new_job("fresh", 0)).unwrap();
        let terminal_count: i64 = c
            .query_row(
                "SELECT COUNT(*) FROM render_jobs WHERE status IN ('completed','failed','cancelled')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(
            terminal_count as usize <= DEFAULT_RETENTION_LIMIT,
            "terminal rows {terminal_count} exceeded retention {DEFAULT_RETENTION_LIMIT}"
        );
        // The just-enqueued row (pending) is untouched.
        assert!(get(&c, fresh).unwrap().is_some());
    }

    #[test]
    fn mark_failed_sets_error() {
        let c = conn();
        let id = enqueue(&c, &new_job("s1", 0)).unwrap();
        mark_running(&c, id).unwrap();
        mark_failed(&c, id, "ffmpeg exited 1").unwrap();
        let j = get(&c, id).unwrap().unwrap();
        assert_eq!(j.status, RenderJobStatus::Failed);
        assert_eq!(j.error.as_deref(), Some("ffmpeg exited 1"));
    }
}
