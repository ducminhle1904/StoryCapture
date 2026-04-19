//! Fluent [`GraphBuilder`] with runtime canonical-order validation.

pub mod order;

pub use order::{node_stage, validate_order, CanonicalStage};

use std::collections::HashSet;
use std::path::PathBuf;

use crate::ast::audio::{AudioNode, SidechainParams};
use crate::ast::types::{NodeId, Rgba};
use crate::ast::video::{
    BackgroundKind, CursorSkin, RippleEvent, Shadow, TextBox, TrajectoryRef, VideoNode, XfadeKind,
    ZoomKeyframe, ZoomTarget,
};
use crate::ast::Graph;
use crate::error::EffectsError;

/// Error alias exposed to builder consumers.
pub type BuilderError = EffectsError;

/// Fluent builder for a [`Graph`]. All inserts are O(1); canonical-order and
/// duplicate-id validation run once in [`GraphBuilder::build`].
pub struct GraphBuilder {
    graph: Graph,
    seen_ids: HashSet<NodeId>,
}

impl GraphBuilder {
    pub fn new(width: u32, height: u32, fps: u32) -> Self {
        Self {
            graph: Graph::new(width, height, fps),
            seen_ids: HashSet::new(),
        }
    }

    fn push_video(&mut self, node: VideoNode) -> &mut Self {
        self.graph.video.push(node);
        self
    }
    fn push_audio(&mut self, node: AudioNode) -> &mut Self {
        self.graph.audio.push(node);
        self
    }

    // ---- video stages ----

    pub fn source(
        &mut self,
        id: NodeId,
        path: impl Into<PathBuf>,
        pts_offset_ms: u64,
    ) -> &mut Self {
        self.push_video(VideoNode::Source {
            id,
            path: path.into(),
            pts_offset_ms,
        })
    }

    pub fn zoom_pan(
        &mut self,
        id: NodeId,
        target: ZoomTarget,
        keyframes: Vec<ZoomKeyframe>,
    ) -> &mut Self {
        self.push_video(VideoNode::ZoomPan {
            id,
            target,
            keyframes,
        })
    }

    pub fn background(
        &mut self,
        id: NodeId,
        kind: BackgroundKind,
        radius_px: f32,
        shadow: Option<Shadow>,
    ) -> &mut Self {
        self.background_with_padding(id, kind, radius_px, shadow, 0)
    }

    /// Full background constructor including `padding_px` (Plan 07 POST-04).
    pub fn background_with_padding(
        &mut self,
        id: NodeId,
        kind: BackgroundKind,
        radius_px: f32,
        shadow: Option<Shadow>,
        padding_px: u32,
    ) -> &mut Self {
        self.push_video(VideoNode::Background {
            id,
            kind,
            radius_px,
            shadow,
            padding_px,
        })
    }

    pub fn cursor(
        &mut self,
        id: NodeId,
        skin: CursorSkin,
        size_scale: f32,
        color_tint: Option<Rgba>,
        trajectory: TrajectoryRef,
    ) -> &mut Self {
        self.push_video(VideoNode::CursorOverlay {
            id,
            skin,
            size_scale,
            color_tint,
            trajectory,
        })
    }

    pub fn ripple(&mut self, id: NodeId, events: Vec<RippleEvent>) -> &mut Self {
        self.push_video(VideoNode::RippleOverlay { id, events })
    }

    pub fn text(&mut self, id: NodeId, boxes: Vec<TextBox>) -> &mut Self {
        self.push_video(VideoNode::TextOverlay { id, boxes })
    }

    pub fn transition(
        &mut self,
        id: NodeId,
        kind: XfadeKind,
        duration_ms: u32,
        offset_ms: u32,
    ) -> &mut Self {
        self.push_video(VideoNode::Transition {
            id,
            kind,
            duration_ms,
            offset_ms,
        })
    }

    // ---- audio stages ----

    pub fn audio_source(
        &mut self,
        id: NodeId,
        path: impl Into<PathBuf>,
        pts_offset_ms: u64,
    ) -> &mut Self {
        self.push_audio(AudioNode::AudioSource {
            id,
            path: path.into(),
            pts_offset_ms,
        })
    }

    pub fn audio_volume(
        &mut self,
        id: NodeId,
        input_label: impl Into<String>,
        volume: f32,
    ) -> &mut Self {
        self.push_audio(AudioNode::Volume {
            id,
            input_label: input_label.into(),
            volume,
        })
    }

    pub fn audio_sidechain(
        &mut self,
        id: NodeId,
        carrier: impl Into<String>,
        sidechain: impl Into<String>,
        params: SidechainParams,
    ) -> &mut Self {
        self.push_audio(AudioNode::Sidechain {
            id,
            carrier: carrier.into(),
            sidechain: sidechain.into(),
            params,
        })
    }

    pub fn audio_mix(&mut self, id: NodeId, inputs: Vec<String>, normalize: bool) -> &mut Self {
        self.push_audio(AudioNode::Amix {
            id,
            inputs,
            normalize,
        })
    }

    pub fn audio_limiter(&mut self, id: NodeId, input: impl Into<String>, limit: f32) -> &mut Self {
        self.push_audio(AudioNode::Alimiter {
            id,
            input: input.into(),
            limit,
        })
    }

    pub fn audio_delay(
        &mut self,
        id: NodeId,
        input_label: impl Into<String>,
        ms: u64,
    ) -> &mut Self {
        self.push_audio(AudioNode::Delay {
            id,
            input_label: input_label.into(),
            ms,
        })
    }

    /// Validate + consume. Performs:
    ///   1. duplicate-id detection across all video + audio nodes
    ///   2. canonical-order validation on the video chain (D-19)
    ///
    /// Takes `&mut self` (not `self`) so the builder composes cleanly with
    /// the `&mut Self` returning fluent methods — call sites read as one
    /// chain terminated by `.build()`.
    pub fn build(&mut self) -> Result<Graph, BuilderError> {
        self.seen_ids.clear();
        for n in &self.graph.video {
            if !self.seen_ids.insert(n.id()) {
                return Err(EffectsError::DuplicateNodeId);
            }
        }
        for n in &self.graph.audio {
            if !self.seen_ids.insert(n.id()) {
                return Err(EffectsError::DuplicateNodeId);
            }
        }
        validate_order(&self.graph.video)?;
        // Snapshot current graph state; caller can continue mutating the
        // builder after `build` (useful for preset-authoring flows).
        Ok(self.graph.clone())
    }
}
