//! FFmpeg-backed render queue executor.

use std::sync::Arc;

use async_trait::async_trait;
use effects::ast::{AudioNode, BackgroundKind, VideoNode};
use effects::background::{lookup as lookup_gradient, resolve_asset_path};
use storage::RenderJob;
use tempfile::Builder as TempFileBuilder;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::error::{EncoderError, Result};
use crate::fanout::{
    fanout_encode, render_direct_mp4, render_intermediate, FanoutPlan, IntermediateProgress,
    OutputFormat, OutputSpec, Quality, Resolution,
};
use crate::progress::RenderProgress;
use crate::queue::job::{JobExecutor, JobOutcome};
use crate::sidecar::SidecarCommand;

/// Production executor for post-production export jobs.
#[derive(Clone)]
pub struct FanoutJobExecutor {
    sidecar: Arc<dyn SidecarCommand>,
    h264_encoder: String,
}

impl FanoutJobExecutor {
    pub fn new(sidecar: Arc<dyn SidecarCommand>, h264_encoder: impl Into<String>) -> Self {
        Self {
            sidecar,
            h264_encoder: h264_encoder.into(),
        }
    }
}

#[async_trait]
impl JobExecutor for FanoutJobExecutor {
    async fn execute(
        &self,
        job: RenderJob,
        progress_tx: mpsc::Sender<RenderProgress>,
        cancel: CancellationToken,
    ) -> Result<JobOutcome> {
        send_progress(&progress_tx, job.id, 1.0).await;
        if cancel.is_cancelled() {
            return Ok(JobOutcome::Cancelled);
        }

        let output_path = job.output_path.clone().ok_or_else(|| {
            EncoderError::InvalidConfig(format!("render job {} missing output_path", job.id))
        })?;
        let batch_id = job.batch_id.as_deref().ok_or_else(|| {
            EncoderError::InvalidConfig(format!("render job {} missing batch_id", job.id))
        })?;
        let output_dir = output_path.parent().ok_or_else(|| {
            EncoderError::InvalidConfig(format!(
                "render job {} output_path has no parent: {}",
                job.id,
                output_path.display()
            ))
        })?;
        let graph_path = output_dir.join(format!(".export-graph-{batch_id}.json"));
        let cursor_temp_dir = output_dir.join(format!(".tmp-render-{batch_id}"));
        let graph_json = tokio::fs::read_to_string(&graph_path)
            .await
            .map_err(|e| EncoderError::Io(format!("read {}: {e}", graph_path.display())))?;
        let graph: effects::Graph = serde_json::from_str(&graph_json)
            .map_err(|e| EncoderError::Io(format!("parse {}: {e}", graph_path.display())))?;

        let extra_inputs = graph_input_args(&graph)?;
        if extra_inputs.is_empty() {
            cleanup_export_temps(&cursor_temp_dir, None).await;
            return Ok(JobOutcome::Failed {
                message: "export graph has no source video input".into(),
            });
        }

        let duration_ms = estimate_duration_ms(&graph);
        let spec = OutputSpec {
            format: parse_format(&job.format)?,
            resolution: parse_resolution(&job.resolution)?,
            fps: job.fps,
            quality: parse_quality(&job.quality)?,
            output_path: output_path.clone(),
        };

        if spec.format == OutputFormat::Mp4 {
            let result = render_direct_mp4(
                &graph,
                &extra_inputs,
                &spec,
                self.sidecar.as_ref(),
                &self.h264_encoder,
                duration_ms,
                Some(IntermediateProgress {
                    job_id: job.id,
                    tx: progress_tx.clone(),
                    start_pct: 1.0,
                    end_pct: 100.0,
                }),
            )
            .await;
            if result.is_err() {
                cleanup_export_temps(&cursor_temp_dir, None).await;
            }
            result?;
            let metadata_result = tokio::fs::metadata(&output_path).await.map_err(|e| {
                EncoderError::Io(format!("output missing {}: {e}", output_path.display()))
            });
            if metadata_result.is_err() {
                cleanup_export_temps(&cursor_temp_dir, None).await;
            }
            metadata_result?;
            cleanup_export_temps(&cursor_temp_dir, None).await;
            send_progress(&progress_tx, job.id, 100.0).await;
            return Ok(JobOutcome::Completed { output_path });
        }

        let intermediate_file = TempFileBuilder::new()
            .suffix(".ffv1.mkv")
            .tempfile_in(output_dir)
            .map_err(|e| {
                EncoderError::Io(format!(
                    "create intermediate in {}: {e}",
                    output_dir.display()
                ))
            })?;
        let intermediate_path = intermediate_file.path().to_path_buf();
        let _intermediate_guard = intermediate_file.into_temp_path();

        let intermediate = match render_intermediate(
            &graph,
            &extra_inputs,
            intermediate_path.clone(),
            self.sidecar.as_ref(),
            duration_ms,
            Some(IntermediateProgress {
                job_id: job.id,
                tx: progress_tx.clone(),
                start_pct: 1.0,
                end_pct: 45.0,
            }),
        )
        .await
        {
            Ok(intermediate) => intermediate,
            Err(e) => {
                cleanup_export_temps(&cursor_temp_dir, Some(&intermediate_path)).await;
                return Err(e);
            }
        };
        send_progress(&progress_tx, job.id, 45.0).await;

        if cancel.is_cancelled() {
            cleanup_export_temps(&cursor_temp_dir, Some(&intermediate_path)).await;
            return Ok(JobOutcome::Cancelled);
        }

        let plan = FanoutPlan {
            outputs: vec![spec],
        };
        let sidecar = self.sidecar.clone();
        let fanout_result = fanout_encode(
            &intermediate,
            &plan,
            move || sidecar.clone(),
            &self.h264_encoder,
        )
        .await;
        if fanout_result.is_err() {
            cleanup_export_temps(&cursor_temp_dir, Some(&intermediate_path)).await;
        }
        fanout_result?;
        let metadata_result = tokio::fs::metadata(&output_path).await.map_err(|e| {
            EncoderError::Io(format!("output missing {}: {e}", output_path.display()))
        });
        if metadata_result.is_err() {
            cleanup_export_temps(&cursor_temp_dir, Some(&intermediate_path)).await;
        }
        metadata_result?;
        cleanup_export_temps(&cursor_temp_dir, Some(&intermediate_path)).await;
        send_progress(&progress_tx, job.id, 100.0).await;
        Ok(JobOutcome::Completed { output_path })
    }
}

async fn cleanup_export_temps(
    cursor_temp_dir: &std::path::Path,
    intermediate_path: Option<&std::path::Path>,
) {
    if let Some(path) = intermediate_path {
        let _ = tokio::fs::remove_file(path).await;
    }
    let _ = tokio::fs::remove_dir_all(cursor_temp_dir).await;
}

async fn send_progress(tx: &mpsc::Sender<RenderProgress>, job_id: uuid::Uuid, pct: f32) {
    let _ = tx
        .send(RenderProgress {
            job_id,
            pct,
            frame: 0,
            fps: 0.0,
            speed: 0.0,
            eta_ms: 0,
        })
        .await;
}

fn graph_input_args(graph: &effects::Graph) -> Result<Vec<Vec<String>>> {
    let mut args = Vec::<Vec<String>>::new();
    for node in &graph.video {
        match node {
            VideoNode::Source { path, .. } => {
                args.push(vec!["-i".into(), path.to_string_lossy().into_owned()]);
            }
            VideoNode::Background { kind, .. } => match kind {
                BackgroundKind::Gradient { preset_id } => {
                    let preset = lookup_gradient(preset_id).ok_or_else(|| {
                        EncoderError::InvalidConfig(format!(
                            "unknown gradient preset in export graph: {preset_id}"
                        ))
                    })?;
                    args.push(vec![
                        "-loop".into(),
                        "1".into(),
                        "-i".into(),
                        resolve_asset_path(preset).to_string_lossy().into_owned(),
                    ]);
                }
                BackgroundKind::Image { path } => {
                    args.push(vec![
                        "-loop".into(),
                        "1".into(),
                        "-i".into(),
                        path.to_string_lossy().into_owned(),
                    ]);
                }
                BackgroundKind::Solid { color } => {
                    args.push(vec![
                        "-f".into(),
                        "lavfi".into(),
                        "-i".into(),
                        format!(
                            "color=c=0x{r:02X}{g:02X}{b:02X}@{a:.3}:s={w}x{h}",
                            r = color.r,
                            g = color.g,
                            b = color.b,
                            a = (color.a as f32) / 255.0,
                            w = graph.output_width,
                            h = graph.output_height,
                        ),
                    ]);
                }
            },
            _ => {}
        }
    }
    for node in &graph.audio {
        if let AudioNode::AudioSource { path, .. } = node {
            args.push(vec!["-i".into(), path.to_string_lossy().into_owned()]);
        }
    }
    Ok(args)
}

fn estimate_duration_ms(graph: &effects::Graph) -> u64 {
    graph
        .video
        .iter()
        .filter_map(|node| match node {
            VideoNode::ZoomPan { keyframes, .. } => keyframes.iter().map(|k| k.t_ms).max(),
            VideoNode::CursorOverlay { trajectory, .. } => {
                if trajectory.fps == 0 {
                    None
                } else {
                    Some((trajectory.frame_count as u64 * 1000) / trajectory.fps as u64)
                }
            }
            VideoNode::RippleOverlay { events, .. } => events
                .iter()
                .map(|e| e.t_impact_ms + u64::from(e.duration_ms))
                .max(),
            VideoNode::TextOverlay { boxes, .. } => boxes.iter().map(|b| b.t_end_ms).max(),
            VideoNode::Transition {
                duration_ms,
                offset_ms,
                ..
            } => Some(u64::from(*offset_ms + *duration_ms)),
            VideoNode::Source { .. } | VideoNode::Background { .. } => None,
        })
        .max()
        .unwrap_or(0)
}

fn parse_format(value: &str) -> Result<OutputFormat> {
    match value {
        "mp4" => Ok(OutputFormat::Mp4),
        "webm" => Ok(OutputFormat::WebM),
        "gif" => Ok(OutputFormat::Gif),
        other => Err(EncoderError::InvalidConfig(format!(
            "unsupported render format: {other}"
        ))),
    }
}

fn parse_resolution(value: &str) -> Result<Resolution> {
    match value {
        "720p" => Ok(Resolution::R720p),
        "1080p" => Ok(Resolution::R1080p),
        "4k" => Ok(Resolution::R4k),
        other => Err(EncoderError::InvalidConfig(format!(
            "unsupported render resolution: {other}"
        ))),
    }
}

fn parse_quality(value: &str) -> Result<Quality> {
    match value {
        "low" => Ok(Quality::Low),
        "med" => Ok(Quality::Med),
        "high" => Ok(Quality::High),
        other => Err(EncoderError::InvalidConfig(format!(
            "unsupported render quality: {other}"
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::queue::job::JobExecutor;
    use crate::{SidecarChild, SidecarCommand};
    use async_trait::async_trait;
    use effects::ast::types::{NodeId, SCHEMA_VERSION};
    use effects::ast::Rgba;
    use std::path::PathBuf;
    use storage::RenderJobStatus;

    struct WritingSidecar;

    #[async_trait]
    impl SidecarCommand for WritingSidecar {
        async fn spawn(&self, args: Vec<String>) -> Result<SidecarChild> {
            let out = args.last().expect("output arg").to_string();
            #[cfg(unix)]
            let mut cmd = {
                let mut cmd = tokio::process::Command::new("sh");
                cmd.arg("-c")
                    .arg("printf video > \"$1\"")
                    .arg("sh")
                    .arg(out);
                cmd
            };
            #[cfg(windows)]
            let mut cmd = {
                let mut cmd = tokio::process::Command::new("cmd");
                cmd.arg("/C").arg(format!("echo video>{out}"));
                cmd
            };
            use std::process::Stdio;
            cmd.stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            let mut child = cmd
                .spawn()
                .map_err(|e| EncoderError::SpawnFailed(e.to_string()))?;
            let stdin = child.stdin.take().unwrap();
            let stdout = child.stdout.take().unwrap();
            let stderr = child.stderr.take().unwrap();
            Ok(SidecarChild {
                stdin,
                stdout,
                stderr,
                child,
            })
        }

        async fn run(&self, args: Vec<String>) -> Result<()> {
            let out = args.last().expect("output arg");
            tokio::fs::write(out, b"video")
                .await
                .map_err(|e| EncoderError::Io(format!("write {out}: {e}")))
        }
    }

    #[test]
    fn graph_input_args_include_gradient_background_after_source() {
        let graph = effects::Graph {
            schema_version: SCHEMA_VERSION,
            output_width: 1280,
            output_height: 720,
            output_fps: 30,
            video: vec![
                VideoNode::Source {
                    id: NodeId::from_bytes([1; 16]),
                    path: PathBuf::from("/tmp/source.mp4"),
                    pts_offset_ms: 0,
                },
                VideoNode::Background {
                    id: NodeId::from_bytes([2; 16]),
                    kind: BackgroundKind::Gradient {
                        preset_id: "runway-dark".into(),
                    },
                    radius_px: 24.0,
                    shadow: None,
                    padding_px: 64,
                },
            ],
            audio: vec![],
        };

        let args = graph_input_args(&graph).unwrap();

        assert_eq!(args.len(), 2);
        assert_eq!(
            args[0],
            vec!["-i".to_string(), "/tmp/source.mp4".to_string()]
        );
        assert_eq!(args[1][0..3], ["-loop", "1", "-i"]);
        assert!(args[1][3].ends_with("assets/gradient-presets/runway-dark.png"));
    }

    #[test]
    fn graph_input_args_include_solid_background_as_lavfi() {
        let graph = effects::Graph {
            schema_version: SCHEMA_VERSION,
            output_width: 1280,
            output_height: 720,
            output_fps: 30,
            video: vec![VideoNode::Background {
                id: NodeId::from_bytes([2; 16]),
                kind: BackgroundKind::Solid {
                    color: Rgba::new(1, 2, 3, 255),
                },
                radius_px: 24.0,
                shadow: None,
                padding_px: 64,
            }],
            audio: vec![],
        };

        let args = graph_input_args(&graph).unwrap();

        assert_eq!(args.len(), 1);
        assert_eq!(args[0][0..3], ["-f", "lavfi", "-i"]);
        assert!(args[0][3].contains("color=c=0x010203@1.000:s=1280x720"));
    }

    #[test]
    fn graph_input_args_reject_unknown_gradient() {
        let graph = effects::Graph {
            schema_version: SCHEMA_VERSION,
            output_width: 1280,
            output_height: 720,
            output_fps: 30,
            video: vec![VideoNode::Background {
                id: NodeId::from_bytes([2; 16]),
                kind: BackgroundKind::Gradient {
                    preset_id: "missing-gradient".into(),
                },
                radius_px: 24.0,
                shadow: None,
                padding_px: 64,
            }],
            audio: vec![],
        };

        let err = graph_input_args(&graph).unwrap_err();

        assert!(err
            .to_string()
            .contains("unknown gradient preset in export graph: missing-gradient"));
    }

    #[tokio::test]
    async fn fanout_executor_writes_declared_output_path() {
        let tmp = tempfile::tempdir().unwrap();
        let source = tmp.path().join("recording.mp4");
        tokio::fs::write(&source, b"source").await.unwrap();

        let batch_id = uuid::Uuid::now_v7().to_string();
        let graph = effects::Graph {
            schema_version: SCHEMA_VERSION,
            output_width: 1280,
            output_height: 720,
            output_fps: 30,
            video: vec![VideoNode::Source {
                id: NodeId::from_bytes([1; 16]),
                path: source,
                pts_offset_ms: 0,
            }],
            audio: vec![],
        };
        let graph_path = tmp.path().join(format!(".export-graph-{batch_id}.json"));
        tokio::fs::write(&graph_path, serde_json::to_string(&graph).unwrap())
            .await
            .unwrap();

        let output_path = tmp.path().join("demo.720p.30.mp4");
        let job = RenderJob {
            id: uuid::Uuid::now_v7(),
            story_id: "story".into(),
            preset_id: None,
            format: "mp4".into(),
            resolution: "720p".into(),
            fps: 30,
            quality: "med".into(),
            status: RenderJobStatus::Running,
            progress_pct: 0.0,
            started_at: None,
            completed_at: None,
            error: None,
            priority: 0,
            output_path: Some(output_path.clone()),
            batch_id: Some(batch_id),
            created_at: 0,
        };
        let (tx, _rx) = mpsc::channel(8);
        let executor = FanoutJobExecutor::new(Arc::new(WritingSidecar), "libx264");

        let outcome = executor
            .execute(job, tx, CancellationToken::new())
            .await
            .unwrap();

        assert!(matches!(outcome, JobOutcome::Completed { .. }));
        assert!(output_path.exists());
    }
}
