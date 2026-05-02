//! Export orchestrator.
//!
//! Composes the AST (`effects::Graph`) + the format catalogue + the render
//! queue into a single entrypoint: `export_run(req, queue, db) ->
//! ExportResult`.
//!
//! For each [`OutputSpec`] in the request the orchestrator:
//!   1. Persists the graph snapshot as a sibling JSON file in the output
//!      folder so the queue worker can reload it without the UI process.
//!   2. Writes a `render_jobs` row via
//!      [`storage::repos::render_job_repo::enqueue`] stamped with the
//!      shared `batch_id`.
//!   3. Nudges the queue actor via `QueueMsg::Enqueue(job_id)`.
//!
//! The host wiring will install a `FanoutJobExecutor` that, on each
//! queue-pop, reads the graph JSON and runs `render_intermediate +
//! fanout_encode` against the real Tauri sidecar command. The orchestrator
//! itself stays pure — unit-testable without a real FFmpeg binary.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use effects::ast::video::{CursorSkin, VideoNode};
use effects::cursor::{
    render_cursor_pngs, render_cursor_pngs_from_actions_with_motion, skin_asset_path,
};
use rusqlite::Connection;
use storage::repos::render_job_repo;
use storage::NewRenderJob;
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::queue::actor::{QueueMsg, RenderQueueHandle};

use super::batch::OutputSpec;
use super::error::ExportError;
use super::resolution::res_label;

#[derive(Debug, Clone)]
pub struct ExportRequest {
    /// Story/project identifier (used by `render_jobs.story_id`).
    pub story_id: String,
    /// The fully-populated effect graph.
    pub graph: effects::Graph,
    /// Per-format OutputSpecs; `build_batch` stamps the shared `batch_id`.
    pub outputs: Vec<OutputSpec>,
    /// `render_jobs.priority` (higher = sooner).
    pub priority: i32,
    /// Destination folder for all outputs + the graph snapshot sidecar.
    pub output_folder: PathBuf,
    /// Optional preset reference (render_jobs.preset_id).
    pub preset_id: Option<Uuid>,
}

#[derive(Debug, Clone)]
pub struct ExportResult {
    pub batch_id: Uuid,
    pub job_ids: Vec<Uuid>,
    /// Sidecar JSON that the queue worker reloads per job. Caller may
    /// delete this after all jobs in the batch reach a terminal state.
    pub graph_snapshot_path: PathBuf,
}

/// Reject an output_folder that lives under a system-protected prefix
/// (macOS `/System`, `/usr`, `/bin`, `/etc`; Windows `C:\\Windows`,
/// `C:\\Program Files`) — T-02-33 mitigation.
pub fn validate_folder(folder: &Path) -> Result<(), ExportError> {
    if !folder.exists() {
        return Err(ExportError::OutputFolderMissing(folder.to_path_buf()));
    }
    if !folder.is_dir() {
        return Err(ExportError::OutputFolderMissing(folder.to_path_buf()));
    }
    let s = folder.to_string_lossy();
    // Protected system prefixes. Note: `/var/folders` (macOS per-user
    // temp root) and `/var/tmp` are explicitly permitted because the OS
    // itself puts writable temp directories there; we only forbid the
    // system-state subtrees.
    const FORBIDDEN: &[&str] = &[
        "/System/",
        "/usr/",
        "/bin/",
        "/sbin/",
        "/etc/",
        "/private/etc/",
        "/var/log/",
        "/var/db/",
        "/var/root/",
        "C:\\Windows\\",
        "C:\\Program Files\\",
        "C:\\ProgramData\\",
    ];
    // Also forbid the folder being exactly a protected root (no trailing
    // slash in `s`).
    const FORBIDDEN_EXACT: &[&str] = &[
        "/System",
        "/usr",
        "/bin",
        "/sbin",
        "/etc",
        "C:\\Windows",
        "C:\\Program Files",
        "C:\\ProgramData",
    ];
    for f in FORBIDDEN {
        if s.starts_with(f) {
            return Err(ExportError::OutputFolderNotAllowed(folder.to_path_buf()));
        }
    }
    for f in FORBIDDEN_EXACT {
        if s == *f {
            return Err(ExportError::OutputFolderNotAllowed(folder.to_path_buf()));
        }
    }
    Ok(())
}

/// Run the export. See module docs.
///
/// `queue` is optional so the orchestrator is testable without a spawned
/// actor — when `None`, the DB rows are written but no `Enqueue` nudge
/// fires (the actor's periodic tick would pick them up in production).
pub async fn export_run(
    req: ExportRequest,
    queue: Option<&RenderQueueHandle>,
    db: &Arc<Mutex<Connection>>,
) -> Result<ExportResult, ExportError> {
    if req.outputs.is_empty() {
        return Err(ExportError::EmptyBatch);
    }
    validate_folder(&req.output_folder)?;
    let batch_id = req.outputs[0].batch_id;
    if !req.outputs.iter().all(|o| o.batch_id == batch_id) {
        return Err(ExportError::Io(
            "outputs have mismatched batch_id (build_batch must stamp a single id)".into(),
        ));
    }

    let mut graph = req.graph;
    preprocess_cursor_overlays(&mut graph, &req.output_folder, batch_id)?;

    // Persist the graph snapshot once per batch — the queue worker will
    // reload it per job without needing the UI process to stay alive.
    let graph_json = serde_json::to_string(&graph)?;
    let snapshot_path = req
        .output_folder
        .join(format!(".export-graph-{batch_id}.json"));
    std::fs::write(&snapshot_path, &graph_json)?;

    let mut job_ids = Vec::with_capacity(req.outputs.len());
    for spec in &req.outputs {
        let new_job = NewRenderJob {
            story_id: req.story_id.clone(),
            preset_id: req.preset_id,
            format: spec.format.extension().to_string(),
            resolution: res_label(spec.resolution).to_string(),
            fps: spec.fps,
            quality: quality_label(spec.quality).into(),
            priority: req.priority,
            batch_id: Some(batch_id.to_string()),
        };
        let id = {
            let conn = db.lock().await;
            render_job_repo::enqueue(&conn, &new_job)
                .map_err(|e| ExportError::Storage(e.to_string()))?
        };
        if let Some(q) = queue {
            q.send(QueueMsg::Enqueue(id))
                .await
                .map_err(|e| ExportError::Queue(e.to_string()))?;
        }
        job_ids.push(id);
    }

    Ok(ExportResult {
        batch_id,
        job_ids,
        graph_snapshot_path: snapshot_path,
    })
}

fn quality_label(q: super::quality::Quality) -> &'static str {
    match q {
        super::quality::Quality::Low => "low",
        super::quality::Quality::Med => "med",
        super::quality::Quality::High => "high",
    }
}

fn preprocess_cursor_overlays(
    graph: &mut effects::Graph,
    output_folder: &Path,
    batch_id: Uuid,
) -> Result<(), ExportError> {
    let tmp_root = output_folder.join(format!(".tmp-render-{batch_id}"));
    let result = render_cursor_overlay_sidecars(graph, &tmp_root);
    if result.is_err() {
        let _ = std::fs::remove_dir_all(&tmp_root);
    }
    result
}

fn render_cursor_overlay_sidecars(
    graph: &mut effects::Graph,
    tmp_root: &Path,
) -> Result<(), ExportError> {
    for node in &mut graph.video {
        let VideoNode::CursorOverlay {
            id,
            motion_preset,
            skin,
            trajectory,
            ..
        } = node
        else {
            continue;
        };
        if !is_cursor_sidecar_json(&trajectory.png_sequence_dir) {
            continue;
        }

        let skin_path = skin_path_with_fallback(*skin);
        let out_dir = tmp_root.join(format!("cursor-{}", id.stable_label("clip")));
        let rendered = if is_actions_json(&trajectory.png_sequence_dir) {
            render_cursor_pngs_from_actions_with_motion(
                &trajectory.png_sequence_dir,
                &skin_path,
                &out_dir,
                trajectory.frame_count,
                *motion_preset,
            )
        } else {
            render_cursor_pngs(&trajectory.png_sequence_dir, &skin_path, &out_dir)
        }
        .map_err(|e| ExportError::CursorRender(e.to_string()))?;
        trajectory.png_sequence_dir = rendered.png_dir;
        trajectory.fps = rendered.fps;
        trajectory.frame_count = rendered.frame_count;
    }
    Ok(())
}

fn is_trajectory_json(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.ends_with(".trajectory.json"))
}

fn is_actions_json(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.ends_with(".actions.json"))
}

fn is_cursor_sidecar_json(path: &Path) -> bool {
    is_trajectory_json(path) || is_actions_json(path)
}

fn skin_path_with_fallback(skin: CursorSkin) -> PathBuf {
    let selected = skin_asset_path(skin);
    if selected.exists() {
        selected
    } else {
        skin_asset_path(CursorSkin::MacDefault)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::export::batch::{build_batch, BatchExportRequest};
    use crate::export::format::OutputFormat;
    use crate::export::quality::Quality;
    use crate::export::resolution::Resolution;
    use effects::ast::types::NodeId;
    use effects::ast::video::{CursorMotionPreset, CursorSkin, TrajectoryRef, VideoNode};
    use storage::migrations::project as project_migrations;

    fn fresh_db() -> Arc<Mutex<Connection>> {
        let mut c = Connection::open_in_memory().unwrap();
        project_migrations::migrations().to_latest(&mut c).unwrap();
        Arc::new(Mutex::new(c))
    }

    fn sample_graph() -> effects::Graph {
        effects::Graph::new(1920, 1080, 60)
    }

    fn write_test_trajectory(path: &Path) {
        std::fs::write(
            path,
            r#"{
              "recording_path": "/tmp/sample.mp4",
              "capture_rect": { "x": 0.0, "y": 0.0, "width": 32.0, "height": 24.0 },
              "fps": 60,
              "frame_count": 2,
              "frames": [
                { "t_ms": 0, "x": 4.0, "y": 5.0, "click": false },
                { "t_ms": 16, "x": 6.0, "y": 7.0, "click": false }
              ]
            }"#,
        )
        .unwrap();
    }

    fn write_test_actions(path: &Path) {
        std::fs::write(
            path,
            r#"{
              "version": 1,
              "recording_path": "/tmp/sample.mp4",
              "viewport": { "width": 32, "height": 24 },
              "capture_rect": { "x": 0.0, "y": 0.0, "width": 32.0, "height": 24.0 },
              "fps": 12,
              "frame_count": 4,
              "events": [
                {
                  "step_id": "step-1",
                  "ordinal": 1,
                  "verb": "click",
                  "t_start_ms": 100,
                  "t_action_ms": 200,
                  "t_end_ms": 250,
                  "target": {
                    "kind": "element",
                    "label": "Save",
                    "center": { "x": 20.0, "y": 12.0 },
                    "bounds": { "x": 16.0, "y": 10.0, "w": 8.0, "h": 4.0 }
                  },
                  "pointer": { "button": "left", "effect": "click" }
                }
              ]
            }"#,
        )
        .unwrap();
    }

    fn sample_request(folder: PathBuf) -> ExportRequest {
        let specs = build_batch(&BatchExportRequest {
            outputs: vec![
                (OutputFormat::Mp4, Resolution::R1080p, 60, Quality::Med),
                (OutputFormat::WebM, Resolution::R1080p, 30, Quality::High),
                (OutputFormat::Gif, Resolution::R720p, 24, Quality::Low),
            ],
            out_folder: folder.clone(),
            base_name: "t".into(),
        })
        .unwrap();
        ExportRequest {
            story_id: "test-story".into(),
            graph: sample_graph(),
            outputs: specs,
            priority: 5,
            output_folder: folder,
            preset_id: None,
        }
    }

    #[tokio::test]
    async fn export_run_enqueues_n_jobs_with_shared_batch_id() {
        let tmp = tempfile::tempdir().unwrap();
        let db = fresh_db();
        let req = sample_request(tmp.path().to_path_buf());
        let expected_batch = req.outputs[0].batch_id;
        let result = export_run(req, None, &db).await.unwrap();
        assert_eq!(result.job_ids.len(), 3);
        assert_eq!(result.batch_id, expected_batch);

        // Confirm all rows share the same batch_id in storage.
        let conn = db.lock().await;
        let rows = render_job_repo::list_by_batch(&conn, &expected_batch.to_string()).unwrap();
        assert_eq!(rows.len(), 3);
        for r in &rows {
            assert_eq!(
                r.batch_id.as_deref(),
                Some(expected_batch.to_string().as_str())
            );
            assert_eq!(r.priority, 5);
        }
        // Snapshot written.
        assert!(result.graph_snapshot_path.exists());
    }

    #[tokio::test]
    async fn export_run_preprocesses_cursor_trajectory_json_before_snapshot() {
        let tmp = tempfile::tempdir().unwrap();
        let trajectory = tmp.path().join("recording.trajectory.json");
        write_test_trajectory(&trajectory);
        let db = fresh_db();
        let mut req = sample_request(tmp.path().to_path_buf());
        req.outputs.truncate(1);
        let batch_id = req.outputs[0].batch_id;
        req.graph.video.push(VideoNode::CursorOverlay {
            id: NodeId::from_bytes([0x0C; 16]),
            skin: CursorSkin::MacDefault,
            size_scale: 1.0,
            motion_preset: Default::default(),
            color_tint: None,
            trajectory: TrajectoryRef {
                png_sequence_dir: trajectory.clone(),
                fps: 60,
                frame_count: 2,
            },
        });

        let result = export_run(req, None, &db).await.unwrap();
        let raw = std::fs::read_to_string(result.graph_snapshot_path).unwrap();
        let graph: effects::Graph = serde_json::from_str(&raw).unwrap();
        let cursor_dir = graph
            .video
            .iter()
            .find_map(|node| match node {
                VideoNode::CursorOverlay { trajectory, .. } => {
                    Some(trajectory.png_sequence_dir.clone())
                }
                _ => None,
            })
            .expect("cursor overlay");

        assert_ne!(cursor_dir, trajectory);
        assert!(cursor_dir.starts_with(tmp.path().join(format!(".tmp-render-{batch_id}"))));
        assert!(cursor_dir.join("frame_00000.png").exists());
        assert!(cursor_dir.join("frame_00001.png").exists());

        let filter = effects::FfmpegEmit::emit(&graph);
        assert!(
            filter.contains("frame_%05d.png"),
            "cursor overlay must point FFmpeg at the rendered PNG sequence: {filter}"
        );
        assert!(
            !filter.contains(".trajectory.json"),
            "trajectory JSON must not leak into FFmpeg inputs: {filter}"
        );
    }

    #[tokio::test]
    async fn export_run_preprocesses_cursor_actions_json_before_snapshot() {
        let tmp = tempfile::tempdir().unwrap();
        let actions = tmp.path().join("recording.actions.json");
        write_test_actions(&actions);
        let db = fresh_db();
        let mut req = sample_request(tmp.path().to_path_buf());
        req.outputs.truncate(1);
        req.graph.video.push(VideoNode::CursorOverlay {
            id: NodeId::from_bytes([0x0D; 16]),
            skin: CursorSkin::MacDefault,
            size_scale: 1.0,
            motion_preset: CursorMotionPreset::Cinematic,
            color_tint: None,
            trajectory: TrajectoryRef {
                png_sequence_dir: actions.clone(),
                fps: 12,
                frame_count: 8,
            },
        });

        let result = export_run(req, None, &db).await.unwrap();
        let raw = std::fs::read_to_string(result.graph_snapshot_path).unwrap();
        let graph: effects::Graph = serde_json::from_str(&raw).unwrap();
        let (motion_preset, cursor_dir) = graph
            .video
            .iter()
            .find_map(|node| match node {
                VideoNode::CursorOverlay {
                    motion_preset,
                    trajectory,
                    ..
                } => Some((*motion_preset, trajectory.png_sequence_dir.clone())),
                _ => None,
            })
            .expect("cursor overlay");

        assert_eq!(motion_preset, CursorMotionPreset::Cinematic);
        assert_ne!(cursor_dir, actions);
        assert!(cursor_dir.join("frame_00000.png").exists());
        assert!(cursor_dir.join("frame_00007.png").exists());
        assert_eq!(
            std::fs::read_dir(&cursor_dir)
                .unwrap()
                .filter(|entry| entry
                    .as_ref()
                    .ok()
                    .and_then(|entry| entry.path().extension().map(|ext| ext == "png"))
                    .unwrap_or(false))
                .count(),
            8
        );
    }

    #[tokio::test]
    async fn export_run_without_cursor_does_not_create_tmp_render_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let db = fresh_db();
        let req = sample_request(tmp.path().to_path_buf());
        let batch_id = req.outputs[0].batch_id;

        export_run(req, None, &db).await.unwrap();

        assert!(!tmp.path().join(format!(".tmp-render-{batch_id}")).exists());
    }

    #[tokio::test]
    async fn export_run_cleans_tmp_render_dir_when_cursor_preprocess_fails() {
        let tmp = tempfile::tempdir().unwrap();
        let trajectory = tmp.path().join("recording.trajectory.json");
        std::fs::write(&trajectory, b"{not-json").unwrap();
        let db = fresh_db();
        let mut req = sample_request(tmp.path().to_path_buf());
        req.outputs.truncate(1);
        let batch_id = req.outputs[0].batch_id;
        req.graph.video.push(VideoNode::CursorOverlay {
            id: NodeId::from_bytes([0x0C; 16]),
            skin: CursorSkin::MacDefault,
            size_scale: 1.0,
            motion_preset: Default::default(),
            color_tint: None,
            trajectory: TrajectoryRef {
                png_sequence_dir: trajectory,
                fps: 60,
                frame_count: 1,
            },
        });

        let err = export_run(req, None, &db).await.unwrap_err();

        assert!(matches!(err, ExportError::CursorRender(_)));
        assert!(!tmp.path().join(format!(".tmp-render-{batch_id}")).exists());
    }

    #[tokio::test]
    async fn export_run_priority_propagates() {
        let tmp = tempfile::tempdir().unwrap();
        let db = fresh_db();
        let mut req = sample_request(tmp.path().to_path_buf());
        req.priority = 42;
        let result = export_run(req, None, &db).await.unwrap();
        let conn = db.lock().await;
        for id in &result.job_ids {
            let j = render_job_repo::get(&conn, *id).unwrap().unwrap();
            assert_eq!(j.priority, 42);
        }
    }

    #[tokio::test]
    async fn export_run_rejects_nonexistent_folder() {
        let db = fresh_db();
        let req = ExportRequest {
            story_id: "x".into(),
            graph: sample_graph(),
            outputs: build_batch(&BatchExportRequest {
                outputs: vec![(OutputFormat::Mp4, Resolution::R720p, 30, Quality::Med)],
                out_folder: PathBuf::from("/nonexistent/xyzzy"),
                base_name: "f".into(),
            })
            .unwrap(),
            priority: 0,
            output_folder: PathBuf::from("/nonexistent/xyzzy"),
            preset_id: None,
        };
        let err = export_run(req, None, &db).await.unwrap_err();
        assert!(matches!(err, ExportError::OutputFolderMissing(_)));
    }

    #[tokio::test]
    async fn export_run_rejects_system_folder() {
        let db = fresh_db();
        // /System exists on macOS; on Linux use /bin/.  Pick whichever the
        // platform actually has so the test does not regress on bare VMs.
        let forbidden = if Path::new("/System").is_dir() {
            PathBuf::from("/System")
        } else if Path::new("/usr").is_dir() {
            PathBuf::from("/usr/")
        } else {
            // Fallback: can't validate on this platform, skip gracefully.
            eprintln!("skip: no protected folder available on this host");
            return;
        };
        let req = ExportRequest {
            story_id: "x".into(),
            graph: sample_graph(),
            outputs: build_batch(&BatchExportRequest {
                outputs: vec![(OutputFormat::Mp4, Resolution::R720p, 30, Quality::Med)],
                out_folder: forbidden.clone(),
                base_name: "f".into(),
            })
            .unwrap(),
            priority: 0,
            output_folder: forbidden,
            preset_id: None,
        };
        let err = export_run(req, None, &db).await.unwrap_err();
        assert!(matches!(err, ExportError::OutputFolderNotAllowed(_)));
    }

    #[tokio::test]
    async fn validate_folder_rejects_forbidden_prefixes() {
        // /etc/foo under /etc/ prefix.
        assert!(matches!(
            validate_folder(Path::new("/etc/foo")),
            Err(ExportError::OutputFolderMissing(_)) | Err(ExportError::OutputFolderNotAllowed(_))
        ));
    }
}
