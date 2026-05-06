//! Hidden post-production compositor export boundary.
//!
//! The GPU/offscreen renderer is intentionally not implemented here yet. This
//! module defines the contract and backend policy so the render queue has one
//! clear decision point while FFmpeg remains the default production path.

use std::path::PathBuf;

use bytes::Bytes;
use effects::ast::VideoNode;
use tokio_util::sync::CancellationToken;

use crate::error::{EncoderError, Result};
use crate::fanout::{ExportEncodeOptions, IntermediateProgress};
use crate::probe::HardwareEncoder;
use crate::sidecar::SidecarCommand;

pub const EXPORT_BACKEND_ENV: &str = "STORYCAPTURE_POSTPROD_EXPORT_BACKEND";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExportRenderBackend {
    FfmpegFilterGraph,
    GpuCompositor,
}

impl ExportRenderBackend {
    pub fn as_log_value(self) -> &'static str {
        match self {
            ExportRenderBackend::FfmpegFilterGraph => "ffmpeg_filter_graph",
            ExportRenderBackend::GpuCompositor => "gpu_compositor",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExportBackendPreference {
    Auto,
    ForceFfmpeg,
    ForceGpu,
}

impl ExportBackendPreference {
    pub fn from_env() -> Self {
        match std::env::var(EXPORT_BACKEND_ENV) {
            Ok(value) if value.eq_ignore_ascii_case("gpu") => Self::ForceGpu,
            Ok(value) if value.eq_ignore_ascii_case("ffmpeg") => Self::ForceFfmpeg,
            _ => Self::Auto,
        }
    }

    pub fn as_log_value(self) -> &'static str {
        match self {
            ExportBackendPreference::Auto => "auto",
            ExportBackendPreference::ForceFfmpeg => "ffmpeg",
            ExportBackendPreference::ForceGpu => "gpu",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExportBackendDecision {
    pub backend: ExportRenderBackend,
    pub preference: ExportBackendPreference,
    pub reason: String,
    pub unsupported_features: Vec<CompositorGraphFeature>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CompositorGraphFeature {
    SourceVideo,
    Background,
    Zoom,
    CursorOverlay,
    TextOverlay,
    RippleOverlay,
    HighlightOverlay,
    Transition,
    Audio,
}

impl CompositorGraphFeature {
    pub fn as_log_value(self) -> &'static str {
        match self {
            CompositorGraphFeature::SourceVideo => "source_video",
            CompositorGraphFeature::Background => "background",
            CompositorGraphFeature::Zoom => "zoom",
            CompositorGraphFeature::CursorOverlay => "cursor_overlay",
            CompositorGraphFeature::TextOverlay => "text_overlay",
            CompositorGraphFeature::RippleOverlay => "ripple_overlay",
            CompositorGraphFeature::HighlightOverlay => "highlight_overlay",
            CompositorGraphFeature::Transition => "transition",
            CompositorGraphFeature::Audio => "audio",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompositorCapability {
    pub features: Vec<CompositorGraphFeature>,
    pub unsupported_features: Vec<CompositorGraphFeature>,
}

impl CompositorCapability {
    pub fn graph_is_supported(&self) -> bool {
        self.unsupported_features.is_empty()
    }
}

#[derive(Debug, Clone)]
pub struct CompositorExportRequest {
    pub graph: effects::Graph,
    pub output_width: u32,
    pub output_height: u32,
    pub fps: u32,
    pub duration_ms: u64,
    pub source_inputs: Vec<SourceInput>,
    pub output_path: PathBuf,
    pub encoder: HardwareEncoder,
    pub encode_options: ExportEncodeOptions,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceInput {
    pub path: PathBuf,
    pub pts_offset_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CompositorPixelFormat {
    Nv12,
    Rgba,
}

#[derive(Debug, Clone)]
pub struct CompositorFrame {
    pub frame_number: u64,
    pub pts_ms: u64,
    pub width: u32,
    pub height: u32,
    pub format: CompositorPixelFormat,
    pub data: Bytes,
    pub stride: u32,
}

pub fn choose_export_render_backend(graph: &effects::Graph) -> ExportBackendDecision {
    choose_export_render_backend_with_preference(graph, ExportBackendPreference::from_env())
}

pub fn choose_export_render_backend_with_preference(
    graph: &effects::Graph,
    preference: ExportBackendPreference,
) -> ExportBackendDecision {
    let capability = detect_compositor_capability(graph);
    match preference {
        ExportBackendPreference::ForceFfmpeg => ExportBackendDecision {
            backend: ExportRenderBackend::FfmpegFilterGraph,
            preference,
            reason: "ffmpeg forced by export backend preference".into(),
            unsupported_features: capability.unsupported_features,
        },
        ExportBackendPreference::ForceGpu if capability.graph_is_supported() => {
            ExportBackendDecision {
                backend: ExportRenderBackend::GpuCompositor,
                preference,
                reason: "gpu compositor forced by export backend preference".into(),
                unsupported_features: Vec::new(),
            }
        }
        ExportBackendPreference::ForceGpu => ExportBackendDecision {
            backend: ExportRenderBackend::FfmpegFilterGraph,
            preference,
            reason: "gpu compositor forced but graph has unsupported features".into(),
            unsupported_features: capability.unsupported_features,
        },
        ExportBackendPreference::Auto => ExportBackendDecision {
            backend: ExportRenderBackend::FfmpegFilterGraph,
            preference,
            reason: "gpu compositor is hidden until MVP export parity is verified".into(),
            unsupported_features: capability.unsupported_features,
        },
    }
}

pub fn detect_compositor_capability(graph: &effects::Graph) -> CompositorCapability {
    let mut features = Vec::new();
    let mut unsupported_features = Vec::new();
    for node in &graph.video {
        match node {
            VideoNode::Source { .. } => {
                push_unique(&mut features, CompositorGraphFeature::SourceVideo)
            }
            VideoNode::Background { .. } => {
                push_unique(&mut features, CompositorGraphFeature::Background)
            }
            VideoNode::ZoomPan { .. } => push_unique(&mut features, CompositorGraphFeature::Zoom),
            VideoNode::CursorOverlay { .. } => {
                push_unique(&mut features, CompositorGraphFeature::CursorOverlay)
            }
            VideoNode::TextOverlay { .. } => {
                push_unique(&mut features, CompositorGraphFeature::TextOverlay);
                push_unique(
                    &mut unsupported_features,
                    CompositorGraphFeature::TextOverlay,
                );
            }
            VideoNode::RippleOverlay { .. } => {
                push_unique(&mut features, CompositorGraphFeature::RippleOverlay);
                push_unique(
                    &mut unsupported_features,
                    CompositorGraphFeature::RippleOverlay,
                );
            }
            VideoNode::HighlightOverlay { .. } => {
                push_unique(&mut features, CompositorGraphFeature::HighlightOverlay);
                push_unique(
                    &mut unsupported_features,
                    CompositorGraphFeature::HighlightOverlay,
                );
            }
            VideoNode::Transition { .. } => {
                push_unique(&mut features, CompositorGraphFeature::Transition);
                push_unique(
                    &mut unsupported_features,
                    CompositorGraphFeature::Transition,
                );
            }
        }
    }
    if !graph.audio.is_empty() {
        push_unique(&mut features, CompositorGraphFeature::Audio);
        push_unique(&mut unsupported_features, CompositorGraphFeature::Audio);
    }
    CompositorCapability {
        features,
        unsupported_features,
    }
}

pub fn frame_count_for_duration(duration_ms: u64, fps: u32) -> u64 {
    if duration_ms == 0 || fps == 0 {
        return 0;
    }
    duration_ms.saturating_mul(u64::from(fps)).div_ceil(1000)
}

pub fn even_dimension(value: u32) -> u32 {
    value & !1
}

pub async fn render_compositor_direct_mp4(
    _request: CompositorExportRequest,
    _sidecar_cmd: &dyn SidecarCommand,
    _progress: Option<IntermediateProgress>,
    cancel: CancellationToken,
) -> Result<()> {
    if cancel.is_cancelled() {
        return Ok(());
    }
    Err(EncoderError::InvalidConfig(
        "gpu compositor export is not implemented yet".into(),
    ))
}

fn push_unique<T: PartialEq>(items: &mut Vec<T>, item: T) {
    if !items.contains(&item) {
        items.push(item);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use effects::ast::types::{NodeId, SCHEMA_VERSION};
    use effects::ast::{
        AudioNode, BackgroundKind, CursorMotionPreset, CursorSkin, TrajectoryRef, ZoomTarget,
    };
    use std::path::PathBuf;

    fn graph(video: Vec<VideoNode>) -> effects::Graph {
        effects::Graph {
            schema_version: SCHEMA_VERSION,
            output_width: 1280,
            output_height: 720,
            output_fps: 60,
            video,
            audio: Vec::new(),
        }
    }

    fn source() -> VideoNode {
        VideoNode::Source {
            id: NodeId::from_bytes([1; 16]),
            path: PathBuf::from("/tmp/source.mp4"),
            pts_offset_ms: 0,
        }
    }

    #[test]
    fn source_background_zoom_cursor_are_mvp_supported() {
        let graph = graph(vec![
            source(),
            VideoNode::Background {
                id: NodeId::from_bytes([2; 16]),
                kind: BackgroundKind::Solid {
                    color: effects::ast::Rgba::BLACK,
                },
                radius_px: 24.0,
                shadow: None,
                padding_px: 48,
            },
            VideoNode::ZoomPan {
                id: NodeId::from_bytes([3; 16]),
                target: ZoomTarget::FixedRegion {
                    top_left: effects::ast::Vec2::new(0.25, 0.25),
                    size: effects::ast::Vec2::new(0.5, 0.5),
                },
                keyframes: Vec::new(),
            },
            VideoNode::CursorOverlay {
                id: NodeId::from_bytes([4; 16]),
                skin: CursorSkin::MacDefault,
                size_scale: 1.0,
                motion_preset: CursorMotionPreset::Natural,
                color_tint: None,
                trajectory: TrajectoryRef {
                    png_sequence_dir: PathBuf::from("/tmp/cursor-pngs"),
                    fps: 60,
                    frame_count: 120,
                },
            },
        ]);

        let capability = detect_compositor_capability(&graph);

        assert!(capability.graph_is_supported());
        assert_eq!(
            capability.features,
            vec![
                CompositorGraphFeature::SourceVideo,
                CompositorGraphFeature::Background,
                CompositorGraphFeature::Zoom,
                CompositorGraphFeature::CursorOverlay,
            ]
        );
    }

    #[test]
    fn annotation_and_audio_features_fall_back_to_ffmpeg() {
        let mut graph = graph(vec![
            source(),
            VideoNode::TextOverlay {
                id: NodeId::from_bytes([2; 16]),
                boxes: Vec::new(),
            },
        ]);
        graph.audio.push(AudioNode::AudioSource {
            id: NodeId::from_bytes([3; 16]),
            path: PathBuf::from("/tmp/audio.wav"),
            pts_offset_ms: 0,
        });

        let decision =
            choose_export_render_backend_with_preference(&graph, ExportBackendPreference::ForceGpu);

        assert_eq!(decision.backend, ExportRenderBackend::FfmpegFilterGraph);
        assert_eq!(
            decision.unsupported_features,
            vec![
                CompositorGraphFeature::TextOverlay,
                CompositorGraphFeature::Audio
            ]
        );
    }

    #[test]
    fn auto_keeps_ffmpeg_as_default_even_for_supported_graphs() {
        let graph = graph(vec![source()]);

        let decision =
            choose_export_render_backend_with_preference(&graph, ExportBackendPreference::Auto);

        assert_eq!(decision.backend, ExportRenderBackend::FfmpegFilterGraph);
        assert!(decision.reason.contains("hidden"));
    }

    #[test]
    fn force_gpu_selects_compositor_for_supported_graphs() {
        let graph = graph(vec![source()]);

        let decision =
            choose_export_render_backend_with_preference(&graph, ExportBackendPreference::ForceGpu);

        assert_eq!(decision.backend, ExportRenderBackend::GpuCompositor);
        assert!(decision.unsupported_features.is_empty());
    }

    #[test]
    fn frame_count_is_exact_export_fps_ceil() {
        assert_eq!(frame_count_for_duration(2_000, 60), 120);
        assert_eq!(frame_count_for_duration(2_001, 60), 121);
        assert_eq!(frame_count_for_duration(0, 60), 0);
        assert_eq!(frame_count_for_duration(1_000, 0), 0);
    }

    #[test]
    fn h264_dimensions_are_even() {
        assert_eq!(even_dimension(1920), 1920);
        assert_eq!(even_dimension(1921), 1920);
    }
}
