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
use crate::export::compositor::{
    choose_export_render_backend, render_compositor_direct_mp4, CompositorExportRequest,
    ExportRenderBackend, SourceInput,
};
use crate::export::resolution::{resolve_label, validate_dimensions};
use crate::fanout::multi_encode::export_quality_to_preset;
use crate::fanout::{
    fanout_encode, render_direct_mp4, render_intermediate, resolution_height, resolution_width,
    screen_bitrate_retry_options, ExportEncodeOptions, ExportRateControl, FanoutPlan,
    IntermediateProgress, OutputFormat, OutputSpec, Quality, Resolution,
};
use crate::probe::{
    export_h264_software_fallback, pick_export_h264_encoder, EncoderProbe, HardwareEncoder,
};
use crate::progress::RenderProgress;
use crate::quality;
use crate::queue::job::{JobExecutor, JobOutcome};
use crate::sidecar::SidecarCommand;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ExportEncoderConfig {
    primary: HardwareEncoder,
    fallback: Option<HardwareEncoder>,
}

impl ExportEncoderConfig {
    pub fn new(primary: HardwareEncoder, fallback: Option<HardwareEncoder>) -> Self {
        Self { primary, fallback }
    }

    pub fn software_default() -> Self {
        Self {
            primary: HardwareEncoder::Libx264Software,
            fallback: None,
        }
    }

    pub fn from_probe(probe: &EncoderProbe) -> Self {
        let primary = pick_export_h264_encoder(probe);
        Self {
            primary,
            fallback: export_h264_software_fallback(probe, primary),
        }
    }

    pub fn primary(self) -> HardwareEncoder {
        self.primary
    }

    pub fn fallback(self) -> Option<HardwareEncoder> {
        self.fallback
    }
}

/// Production executor for post-production export jobs.
#[derive(Clone)]
pub struct FanoutJobExecutor {
    sidecar: Arc<dyn SidecarCommand>,
    encoder_config: ExportEncoderConfig,
}

impl FanoutJobExecutor {
    pub fn new(sidecar: Arc<dyn SidecarCommand>, encoder_config: ExportEncoderConfig) -> Self {
        Self {
            sidecar,
            encoder_config,
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
            resolution: parse_resolution(&job.resolution, job.output_width, job.output_height)?,
            fps: job.fps,
            quality: parse_quality(&job.quality)?,
            encoder_options: parse_encoder_options(job.encoder_options_json.as_deref())?,
            output_path: output_path.clone(),
        };

        if spec.format == OutputFormat::Mp4 {
            let result = self
                .render_mp4_with_fallback(
                    &graph,
                    &extra_inputs,
                    &spec,
                    selected_encoder_config(self.encoder_config, spec.encoder_options.as_ref()),
                    duration_ms,
                    job.id,
                    progress_tx.clone(),
                    &cancel,
                )
                .await;
            if result.is_err() {
                cleanup_export_temps(&cursor_temp_dir, None).await;
            }
            result?;
            if cancel.is_cancelled() {
                cleanup_export_temps(&cursor_temp_dir, None).await;
                return Ok(JobOutcome::Cancelled);
            }
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
            outputs: vec![spec.clone()],
        };
        let sidecar = self.sidecar.clone();
        let fanout_result = fanout_encode(
            &intermediate,
            &plan,
            move || sidecar.clone(),
            selected_encoder_config(self.encoder_config, spec.encoder_options.as_ref()).primary,
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

impl FanoutJobExecutor {
    async fn render_mp4_with_fallback(
        &self,
        graph: &effects::Graph,
        extra_inputs: &[Vec<String>],
        spec: &OutputSpec,
        encoder_config: ExportEncoderConfig,
        duration_ms: u64,
        job_id: uuid::Uuid,
        progress_tx: mpsc::Sender<RenderProgress>,
        cancel: &CancellationToken,
    ) -> Result<()> {
        let backend_decision = choose_export_render_backend(graph);
        log_export_backend_decision(
            job_id,
            graph,
            spec,
            encoder_config.primary,
            &backend_decision,
        );
        if backend_decision.backend == ExportRenderBackend::GpuCompositor {
            let compositor_result = render_compositor_direct_mp4(
                CompositorExportRequest {
                    graph: graph.clone(),
                    output_width: resolution_width(spec.resolution),
                    output_height: resolution_height(spec.resolution),
                    fps: spec.fps,
                    duration_ms,
                    source_inputs: source_inputs_from_graph(graph),
                    output_path: spec.output_path.clone(),
                    encoder: encoder_config.primary,
                    encode_options: spec.encoder_options.clone().unwrap_or_default(),
                },
                self.sidecar.as_ref(),
                Some(IntermediateProgress {
                    job_id,
                    tx: progress_tx.clone(),
                    start_pct: 1.0,
                    end_pct: 70.0,
                }),
                cancel.clone(),
            )
            .await;
            match compositor_result {
                Ok(()) => return Ok(()),
                Err(error) if !cancel.is_cancelled() => {
                    let _ = tokio::fs::remove_file(&spec.output_path).await;
                    tracing::warn!(
                        target: "storycapture::export",
                        %job_id,
                        output_path = %spec.output_path.display(),
                        error = %error,
                        fallback_backend = ExportRenderBackend::FfmpegFilterGraph.as_log_value(),
                        "gpu compositor export failed before commit; retrying with FFmpeg filter graph"
                    );
                }
                Err(_) => return Ok(()),
            }
        }

        let primary = encoder_config.primary;
        let primary_result = render_direct_mp4(
            graph,
            extra_inputs,
            spec,
            self.sidecar.as_ref(),
            primary,
            duration_ms,
            Some(IntermediateProgress {
                job_id,
                tx: progress_tx.clone(),
                start_pct: 1.0,
                end_pct: 100.0,
            }),
        )
        .await;

        let Err(primary_error) = primary_result else {
            if cancel.is_cancelled() {
                return Ok(());
            }
            return self
                .retry_low_bitrate_if_needed(
                    spec,
                    encoder_config,
                    graph,
                    extra_inputs,
                    duration_ms,
                    job_id,
                )
                .await;
        };

        let Some(fallback) = encoder_config.fallback else {
            return Err(primary_error);
        };
        if !primary.is_hardware() {
            return Err(primary_error);
        }
        if cancel.is_cancelled() {
            return Ok(());
        }

        tracing::warn!(
            target: "storycapture::export",
            %job_id,
            primary_encoder = primary.ffmpeg_codec_name(),
            fallback_encoder = fallback.ffmpeg_codec_name(),
            output_resolution = ?spec.resolution,
            fps = spec.fps,
            quality = ?spec.quality,
            error = %primary_error,
            "post-production hardware export failed; retrying with software encoder"
        );

        match render_direct_mp4(
            graph,
            extra_inputs,
            spec,
            self.sidecar.as_ref(),
            fallback,
            duration_ms,
            None,
        )
        .await
        {
            Ok(()) => {
                if cancel.is_cancelled() {
                    return Ok(());
                }
                self.retry_low_bitrate_if_needed(
                    spec,
                    ExportEncoderConfig::new(fallback, None),
                    graph,
                    extra_inputs,
                    duration_ms,
                    job_id,
                )
                .await
            }
            Err(fallback_error) => {
                tracing::error!(
                    target: "storycapture::export",
                    %job_id,
                    primary_encoder = primary.ffmpeg_codec_name(),
                    fallback_encoder = fallback.ffmpeg_codec_name(),
                    output_resolution = ?spec.resolution,
                    fps = spec.fps,
                    quality = ?spec.quality,
                    primary_error = %primary_error,
                    fallback_error = %fallback_error,
                    "post-production software fallback export failed"
                );
                Err(fallback_error)
            }
        }
    }

    async fn retry_low_bitrate_if_needed(
        &self,
        spec: &OutputSpec,
        encoder_config: ExportEncoderConfig,
        graph: &effects::Graph,
        extra_inputs: &[Vec<String>],
        duration_ms: u64,
        job_id: uuid::Uuid,
    ) -> Result<()> {
        if !should_retry_low_bitrate(spec, encoder_config) {
            return Ok(());
        }
        let width = resolution_width(spec.resolution);
        let height = resolution_height(spec.resolution);
        let floor = quality::screen_export_floor_kbps(
            export_quality_to_preset(spec.quality),
            width,
            height,
            spec.fps,
        );
        let Some(actual_kbps) = output_bitrate_kbps(spec, duration_ms).await? else {
            return Ok(());
        };
        if actual_kbps >= floor {
            tracing::info!(
                target: "storycapture::export",
                %job_id,
                output_path = %spec.output_path.display(),
                width,
                height,
                fps = spec.fps,
                quality = ?spec.quality,
                actual_kbps,
                floor_kbps = floor,
                retry = false,
                "post-production MP4 bitrate guardrail checked"
            );
            return Ok(());
        }

        let retry_spec = screen_bitrate_retry_options(spec, width, height);
        let target = quality::screen_export_target_kbps(
            export_quality_to_preset(spec.quality),
            width,
            height,
            spec.fps,
        );
        tracing::warn!(
            target: "storycapture::export",
            %job_id,
            output_path = %spec.output_path.display(),
            width,
            height,
            fps = spec.fps,
            quality = ?spec.quality,
            actual_kbps,
            floor_kbps = floor,
            target_kbps = target,
            "post-production MP4 bitrate below screen-content floor; retrying with libx264 bitrate policy"
        );
        render_direct_mp4(
            graph,
            extra_inputs,
            &retry_spec,
            self.sidecar.as_ref(),
            HardwareEncoder::Libx264Software,
            duration_ms,
            None,
        )
        .await?;
        let retry_kbps = output_bitrate_kbps(&retry_spec, duration_ms)
            .await?
            .ok_or_else(|| {
                EncoderError::ProbeFailed(format!(
                    "missing retry output metadata for {}",
                    retry_spec.output_path.display()
                ))
            })?;
        if retry_kbps < floor {
            return Err(EncoderError::ProbeFailed(format!(
                "post-production MP4 bitrate remained below screen-content floor after retry: actual={}kbps floor={}kbps output={}",
                retry_kbps,
                floor,
                retry_spec.output_path.display()
            )));
        }
        tracing::info!(
            target: "storycapture::export",
            %job_id,
            output_path = %retry_spec.output_path.display(),
            width,
            height,
            fps = spec.fps,
            quality = ?spec.quality,
            actual_kbps = retry_kbps,
            floor_kbps = floor,
            retry = true,
            "post-production MP4 bitrate guardrail passed after retry"
        );
        Ok(())
    }
}

fn source_inputs_from_graph(graph: &effects::Graph) -> Vec<SourceInput> {
    graph
        .video
        .iter()
        .filter_map(|node| match node {
            VideoNode::Source {
                path,
                pts_offset_ms,
                ..
            } => Some(SourceInput {
                path: path.clone(),
                pts_offset_ms: *pts_offset_ms,
            }),
            _ => None,
        })
        .collect()
}

fn log_export_backend_decision(
    job_id: uuid::Uuid,
    graph: &effects::Graph,
    spec: &OutputSpec,
    h264_encoder: HardwareEncoder,
    decision: &crate::export::compositor::ExportBackendDecision,
) {
    let unsupported_features = decision
        .unsupported_features
        .iter()
        .map(|feature| feature.as_log_value())
        .collect::<Vec<_>>()
        .join(",");
    tracing::info!(
        target: "storycapture::export",
        %job_id,
        selected_export_backend = decision.backend.as_log_value(),
        export_backend_preference = decision.preference.as_log_value(),
        reason = %decision.reason,
        unsupported_features,
        format = ?spec.format,
        output_path = %spec.output_path.display(),
        output_width = resolution_width(spec.resolution),
        output_height = resolution_height(spec.resolution),
        graph_output_width = graph.output_width,
        graph_output_height = graph.output_height,
        fps = spec.fps,
        graph_fps = graph.output_fps,
        video_nodes = graph.video.len(),
        audio_nodes = graph.audio.len(),
        h264_encoder = h264_encoder.ffmpeg_codec_name(),
        "selected post-production export backend"
    );
}

async fn output_bitrate_kbps(spec: &OutputSpec, duration_ms: u64) -> Result<Option<u32>> {
    if duration_ms == 0 {
        return Ok(None);
    }
    let metadata = tokio::fs::metadata(&spec.output_path).await.map_err(|e| {
        EncoderError::Io(format!(
            "output metadata {}: {e}",
            spec.output_path.display()
        ))
    })?;
    let average_kbps = ((metadata.len() as u128).saturating_mul(8) / duration_ms as u128)
        .min(u32::MAX as u128) as u32;
    Ok(Some(average_kbps))
}

fn should_retry_low_bitrate(spec: &OutputSpec, encoder_config: ExportEncoderConfig) -> bool {
    if spec.quality != Quality::High {
        return false;
    }
    let auto_policy = spec
        .encoder_options
        .as_ref()
        .map(|options| {
            options.encoder.is_none()
                && options.rate_control == ExportRateControl::Auto
                && options.quality_value.is_none()
        })
        .unwrap_or(true);
    auto_policy
        && (encoder_config.primary == HardwareEncoder::Libx264Software
            || encoder_config.fallback == Some(HardwareEncoder::Libx264Software))
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
                        normalize_graph_input_path(path),
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

fn normalize_graph_input_path(path: &std::path::Path) -> String {
    let raw = path.to_string_lossy();
    raw.strip_prefix("/@fs/")
        .map(|rest| format!("/{rest}"))
        .unwrap_or_else(|| raw.into_owned())
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
            VideoNode::HighlightOverlay { highlights, .. } => highlights
                .iter()
                .map(|h| h.t_start_ms + u64::from(h.duration_ms))
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

fn parse_resolution(value: &str, width: Option<u32>, height: Option<u32>) -> Result<Resolution> {
    let export_res = resolve_label(value, width, height)
        .map_err(|e| EncoderError::InvalidConfig(format!("render resolution: {e}")))?;
    let res = match export_res {
        crate::export::resolution::Resolution::MatchSource { width, height }
        | crate::export::resolution::Resolution::Custom { width, height } => {
            Resolution::Custom { width, height }
        }
        crate::export::resolution::Resolution::R720p => Resolution::R720p,
        crate::export::resolution::Resolution::R1080p => Resolution::R1080p,
        crate::export::resolution::Resolution::R4k => Resolution::R4k,
    };
    let (width, height) = (resolution_width(res), resolution_height(res));
    if !validate_dimensions(width, height) {
        return Err(EncoderError::InvalidConfig(format!(
            "render resolution dimensions out of bounds: {width}x{height}"
        )));
    }
    Ok(res)
}

fn parse_encoder_options(raw: Option<&str>) -> Result<Option<ExportEncodeOptions>> {
    raw.map(|json| {
        serde_json::from_str(json)
            .map_err(|e| EncoderError::InvalidConfig(format!("encoder_options_json: {e}")))
    })
    .transpose()
}

fn selected_encoder_config(
    auto_config: ExportEncoderConfig,
    options: Option<&ExportEncodeOptions>,
) -> ExportEncoderConfig {
    match options.and_then(|opts| opts.encoder) {
        Some(encoder) => ExportEncoderConfig::new(encoder, None),
        None => auto_config,
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
    use effects::ast::video::{FontChoice, TextAnim, TextBox};
    use effects::ast::{Rgba, Vec2};
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc as StdArc, Mutex};
    use storage::RenderJobStatus;

    struct WritingSidecar;

    #[async_trait]
    impl SidecarCommand for WritingSidecar {
        async fn spawn(&self, args: Vec<String>) -> Result<SidecarChild> {
            let out = args.last().expect("output arg").to_string();
            spawn_test_child(out, false)
        }

        async fn run(&self, args: Vec<String>) -> Result<()> {
            let out = args.last().expect("output arg");
            tokio::fs::write(out, b"video")
                .await
                .map_err(|e| EncoderError::Io(format!("write {out}: {e}")))
        }
    }

    struct FailsHardwareSidecar {
        calls: StdArc<Mutex<Vec<Vec<String>>>>,
    }

    #[async_trait]
    impl SidecarCommand for FailsHardwareSidecar {
        async fn spawn(&self, args: Vec<String>) -> Result<SidecarChild> {
            self.calls.lock().unwrap().push(args.clone());
            let out = args.last().expect("output arg").to_string();
            let fail_hardware = args.iter().any(|arg| arg == "h264_videotoolbox");
            spawn_test_child(out, fail_hardware)
        }
    }

    struct LowBitrateThenPassSidecar {
        calls: StdArc<Mutex<Vec<Vec<String>>>>,
        count: AtomicUsize,
    }

    #[async_trait]
    impl SidecarCommand for LowBitrateThenPassSidecar {
        async fn spawn(&self, args: Vec<String>) -> Result<SidecarChild> {
            self.calls.lock().unwrap().push(args.clone());
            let out = args.last().expect("output arg").to_string();
            let call = self.count.fetch_add(1, Ordering::SeqCst);
            spawn_sized_test_child(out, if call == 0 { 128 } else { 2_000_000 })
        }
    }

    fn spawn_test_child(out: String, fail: bool) -> Result<SidecarChild> {
        #[cfg(unix)]
        let mut cmd = {
            let mut cmd = tokio::process::Command::new("sh");
            if fail {
                cmd.arg("-c").arg("exit 1");
            } else {
                cmd.arg("-c")
                    .arg("printf video > \"$1\"")
                    .arg("sh")
                    .arg(out);
            }
            cmd
        };
        #[cfg(windows)]
        let mut cmd = {
            let mut cmd = tokio::process::Command::new("cmd");
            if fail {
                cmd.arg("/C").arg("exit 1");
            } else {
                cmd.arg("/C").arg(format!("echo video>{out}"));
            }
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

    fn spawn_sized_test_child(out: String, bytes: usize) -> Result<SidecarChild> {
        #[cfg(unix)]
        let mut cmd = {
            let mut cmd = tokio::process::Command::new("sh");
            cmd.arg("-c")
                .arg("dd if=/dev/zero of=\"$1\" bs=1 count=0 seek=\"$2\" 2>/dev/null")
                .arg("sh")
                .arg(out)
                .arg(bytes.to_string());
            cmd
        };
        #[cfg(windows)]
        let mut cmd = {
            let mut cmd = tokio::process::Command::new("cmd");
            cmd.arg("/C").arg(format!(
                "powershell -NoProfile -Command \"$f=[IO.File]::OpenWrite('{}');$f.SetLength({});$f.Close()\"",
                out.replace('\'', "''"),
                bytes
            ));
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
    fn graph_input_args_normalize_vite_fs_image_paths() {
        let graph = effects::Graph {
            schema_version: SCHEMA_VERSION,
            output_width: 1280,
            output_height: 720,
            output_fps: 30,
            video: vec![VideoNode::Background {
                id: NodeId::from_bytes([2; 16]),
                kind: BackgroundKind::Image {
                    path: PathBuf::from("/@fs/Users/example/project/assets/cosmic/1.jpg"),
                },
                radius_px: 24.0,
                shadow: None,
                padding_px: 64,
            }],
            audio: vec![],
        };

        let args = graph_input_args(&graph).unwrap();

        assert_eq!(args[0][0..3], ["-loop", "1", "-i"]);
        assert_eq!(args[0][3], "/Users/example/project/assets/cosmic/1.jpg");
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
            output_width: Some(1280),
            output_height: Some(720),
            fps: 30,
            quality: "med".into(),
            encoder_options_json: None,
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
        let executor = FanoutJobExecutor::new(
            Arc::new(WritingSidecar),
            ExportEncoderConfig::software_default(),
        );

        let outcome = executor
            .execute(job, tx, CancellationToken::new())
            .await
            .unwrap();

        assert!(matches!(outcome, JobOutcome::Completed { .. }));
        assert!(output_path.exists());
    }

    #[tokio::test]
    async fn fanout_executor_default_mp4_uses_ffmpeg_filter_graph() {
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
            output_width: Some(1280),
            output_height: Some(720),
            fps: 30,
            quality: "med".into(),
            encoder_options_json: None,
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
        let calls = StdArc::new(Mutex::new(Vec::<Vec<String>>::new()));
        let executor = FanoutJobExecutor::new(
            Arc::new(FailsHardwareSidecar {
                calls: calls.clone(),
            }),
            ExportEncoderConfig::software_default(),
        );
        let (tx, _rx) = mpsc::channel(8);

        let outcome = executor
            .execute(job, tx, CancellationToken::new())
            .await
            .unwrap();

        assert!(matches!(outcome, JobOutcome::Completed { .. }));
        let calls = calls.lock().unwrap();
        assert_eq!(calls.len(), 1);
        let joined = calls[0].join(" ");
        assert!(joined.contains("-filter_complex"), "{joined}");
        assert!(joined.contains("-c:v libx264"), "{joined}");
    }

    #[tokio::test]
    async fn fanout_executor_retries_hardware_mp4_with_software_fallback() {
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
            output_width: Some(1280),
            output_height: Some(720),
            fps: 30,
            quality: "med".into(),
            encoder_options_json: None,
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
        let calls = StdArc::new(Mutex::new(Vec::<Vec<String>>::new()));
        let executor = FanoutJobExecutor::new(
            Arc::new(FailsHardwareSidecar {
                calls: calls.clone(),
            }),
            ExportEncoderConfig::new(
                HardwareEncoder::VideoToolboxH264,
                Some(HardwareEncoder::Libx264Software),
            ),
        );
        let (tx, _rx) = mpsc::channel(8);

        let outcome = executor
            .execute(job, tx, CancellationToken::new())
            .await
            .unwrap();

        assert!(matches!(outcome, JobOutcome::Completed { .. }));
        assert!(output_path.exists());
        let calls = calls.lock().unwrap();
        assert_eq!(calls.len(), 2);
        assert!(calls[0].iter().any(|arg| arg == "h264_videotoolbox"));
        assert!(calls[1].iter().any(|arg| arg == "libx264"));
    }

    #[tokio::test]
    async fn fanout_executor_retries_auto_high_low_bitrate_with_libx264_budget() {
        let tmp = tempfile::tempdir().unwrap();
        let source = tmp.path().join("recording.mp4");
        tokio::fs::write(&source, b"source").await.unwrap();

        let batch_id = uuid::Uuid::now_v7().to_string();
        let graph = effects::Graph {
            schema_version: SCHEMA_VERSION,
            output_width: 1920,
            output_height: 1080,
            output_fps: 60,
            video: vec![
                VideoNode::Source {
                    id: NodeId::from_bytes([1; 16]),
                    path: source,
                    pts_offset_ms: 0,
                },
                VideoNode::TextOverlay {
                    id: NodeId::from_bytes([2; 16]),
                    boxes: vec![TextBox {
                        t_start_ms: 0,
                        t_end_ms: 1000,
                        text: "Readable UI text".into(),
                        pos: Vec2::new(100.0, 100.0),
                        font: FontChoice::SystemDefault,
                        size_pt: 24.0,
                        color: Rgba::WHITE,
                        box_style: None,
                        anim_in: TextAnim::None,
                        anim_out: TextAnim::None,
                    }],
                },
            ],
            audio: vec![],
        };
        let graph_path = tmp.path().join(format!(".export-graph-{batch_id}.json"));
        tokio::fs::write(&graph_path, serde_json::to_string(&graph).unwrap())
            .await
            .unwrap();

        let output_path = tmp.path().join("demo.match-source.60.mp4");
        let job = RenderJob {
            id: uuid::Uuid::now_v7(),
            story_id: "story".into(),
            preset_id: None,
            format: "mp4".into(),
            resolution: "match-source".into(),
            output_width: Some(1920),
            output_height: Some(1080),
            fps: 60,
            quality: "high".into(),
            encoder_options_json: Some(
                serde_json::to_string(&ExportEncodeOptions::default()).unwrap(),
            ),
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
        let calls = StdArc::new(Mutex::new(Vec::<Vec<String>>::new()));
        let executor = FanoutJobExecutor::new(
            Arc::new(LowBitrateThenPassSidecar {
                calls: calls.clone(),
                count: AtomicUsize::new(0),
            }),
            ExportEncoderConfig::software_default(),
        );
        let (tx, _rx) = mpsc::channel(8);

        let outcome = executor
            .execute(job, tx, CancellationToken::new())
            .await
            .unwrap();

        assert!(matches!(outcome, JobOutcome::Completed { .. }));
        let calls = calls.lock().unwrap();
        assert_eq!(calls.len(), 2);
        let retry = calls[1].join(" ");
        assert!(retry.contains("-c:v libx264"), "{retry}");
        assert!(retry.contains("-b:v 26M"), "{retry}");
        assert!(!retry.contains("-crf"), "{retry}");
    }
}
