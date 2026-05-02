//! Root Graph type. Holds the list of [`VideoNode`]s and [`AudioNode`]s
//! that together describe one renderable scene.
//!
//! The Graph is the unit of serialisation for `.scpreset` files. Schema
//! evolution is managed by bumping [`types::SCHEMA_VERSION`].

pub mod audio;
pub mod types;
pub mod video;

pub use audio::{AmixParams, AudioNode, SidechainParams};
pub use types::{Duration, EasingKind, NodeId, Rgba, Vec2, SCHEMA_VERSION};
pub use video::{
    BackgroundKind, BoxStyle, CursorMotionPreset, CursorSkin, FontChoice, RippleEvent, Shadow,
    TextAnim, TextBox, TrajectoryRef, VideoNode, XfadeKind, ZoomKeyframe, ZoomTarget,
};

use serde::{Deserialize, Serialize};

#[cfg(feature = "ts-export")]
use ts_rs::TS;

/// Root of the filter-graph AST. One Graph == one renderable scene.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-export", derive(TS))]
#[cfg_attr(
    feature = "ts-export",
    ts(
        export,
        export_to = "../../../packages/shared-types/src/generated/effects.ts"
    )
)]
pub struct Graph {
    /// See [`types::SCHEMA_VERSION`]. Presets with a different version are
    /// migrated by the loader.
    pub schema_version: u32,
    pub output_width: u32,
    pub output_height: u32,
    pub output_fps: u32,
    pub video: Vec<VideoNode>,
    pub audio: Vec<AudioNode>,
}

impl Graph {
    pub fn new(output_width: u32, output_height: u32, output_fps: u32) -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            output_width,
            output_height,
            output_fps,
            video: Vec::new(),
            audio: Vec::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn graph_new_sets_schema_version() {
        let g = Graph::new(1920, 1080, 60);
        assert_eq!(g.schema_version, SCHEMA_VERSION);
        assert_eq!(
            SCHEMA_VERSION, 2,
            "schema version should track Phase 1 D-28 project.sqlite v2"
        );
        assert_eq!(g.output_width, 1920);
        assert_eq!(g.output_height, 1080);
        assert_eq!(g.output_fps, 60);
        assert!(g.video.is_empty() && g.audio.is_empty());
    }

    #[test]
    fn video_node_source_roundtrips_via_json() {
        let node = VideoNode::Source {
            id: NodeId::from_bytes([0x11; 16]),
            path: PathBuf::from("/tmp/in.mp4"),
            pts_offset_ms: 0,
        };
        let json = serde_json::to_string(&node).expect("serialise");
        let back: VideoNode = serde_json::from_str(&json).expect("deserialise");
        assert_eq!(node, back);
    }

    #[test]
    fn node_id_stable_label_is_deterministic() {
        let id = NodeId::from_bytes([0xAB, 0xCD, 0xEF, 0x01, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
        let a = id.stable_label("v");
        let b = id.stable_label("v");
        assert_eq!(a, b, "same UUID must yield same label");
        // Low 16 bits of little-endian u128 from UUID bytes start with EF01 ... but
        // Uuid stores bytes in big-endian order, so as_u128 preserves byte order.
        // We only require determinism + non-empty + prefix.
        assert!(a.starts_with("v_"), "label should start with prefix: {a}");
        // prefix("v") + "_" + 4 hex chars = 6
        assert_eq!(a.len(), 1 + 1 + 4, "label is `<prefix>_<4hex>`: {a}");
    }

    #[test]
    fn node_id_different_ids_often_differ() {
        let a = NodeId::from_bytes([0x11; 16]).stable_label("v");
        let b = NodeId::from_bytes([0x22; 16]).stable_label("v");
        assert_ne!(a, b);
    }

    #[test]
    fn graph_roundtrips_via_json() {
        let g = Graph::new(1280, 720, 30);
        let json = serde_json::to_string(&g).expect("serialise");
        let back: Graph = serde_json::from_str(&json).expect("deserialise");
        assert_eq!(g, back);
    }
}
