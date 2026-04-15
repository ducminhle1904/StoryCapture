//! AST → [`PreviewRenderPlan`] (JSON consumable by the WebGPU preview player).
//!
//! Like the FFmpeg emitter, this is the **shape** contract — Plan 05 refines
//! keyframe interpolation and Plan 06 fills cursor atlas generation. The
//! Plan-02-01 scope is to lock the JSON layout so the frontend inspector
//! can start building views against stable types.

use serde::{Deserialize, Serialize};

use crate::ast::video::{BackgroundKind, RippleEvent, TextBox, TrajectoryRef, VideoNode};
use crate::ast::{types::Vec2, Graph};

#[cfg(feature = "ts-export")]
use ts_rs::TS;

/// One frame sample of the zoom-pan curve. Plan 05 replaces the placeholder
/// sampler with true keyframe interpolation; the type is fixed now so the
/// frontend never reshapes.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-export", derive(TS))]
#[cfg_attr(
    feature = "ts-export",
    ts(
        export,
        export_to = "../../../packages/shared-types/src/generated/effects.ts"
    )
)]
pub struct ZoomMatrixFrame {
    pub t_ms: u64,
    pub center: Vec2,
    pub scale: f32,
}

/// JSON payload consumed by the WebGPU preview player.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-export", derive(TS))]
#[cfg_attr(
    feature = "ts-export",
    ts(
        export,
        export_to = "../../../packages/shared-types/src/generated/effects.ts"
    )
)]
pub struct PreviewRenderPlan {
    pub output_width: u32,
    pub output_height: u32,
    pub fps: u32,
    pub zoom_matrices: Vec<ZoomMatrixFrame>,
    pub cursor_atlas_ref: Option<TrajectoryRef>,
    pub ripples: Vec<RippleEvent>,
    pub text_boxes: Vec<TextBox>,
    pub background: Option<BackgroundKind>,
}

/// Namespace for the preview emitter.
pub struct PreviewEmit;

impl PreviewEmit {
    pub fn emit(g: &Graph) -> PreviewRenderPlan {
        emit_preview_plan(g)
    }
}

/// Build a [`PreviewRenderPlan`] from the AST.
pub fn emit_preview_plan(g: &Graph) -> PreviewRenderPlan {
    let mut zoom_matrices = Vec::new();
    let mut cursor_atlas_ref: Option<TrajectoryRef> = None;
    let mut ripples: Vec<RippleEvent> = Vec::new();
    let mut text_boxes: Vec<TextBox> = Vec::new();
    let mut background: Option<BackgroundKind> = None;

    for node in &g.video {
        match node {
            VideoNode::Source { .. } | VideoNode::Transition { .. } => {}
            VideoNode::ZoomPan { keyframes, .. } => {
                // Placeholder sampler: emit one ZoomMatrixFrame per keyframe.
                // Plan 05 replaces with full per-frame interpolation.
                for k in keyframes {
                    zoom_matrices.push(ZoomMatrixFrame {
                        t_ms: k.t_ms,
                        center: k.center,
                        scale: k.scale,
                    });
                }
            }
            VideoNode::Background { kind, .. } => {
                background = Some(kind.clone());
            }
            VideoNode::CursorOverlay { trajectory, .. } => {
                cursor_atlas_ref = Some(trajectory.clone());
            }
            VideoNode::RippleOverlay { events, .. } => {
                ripples.extend(events.iter().copied());
            }
            VideoNode::TextOverlay { boxes, .. } => {
                text_boxes.extend(boxes.iter().cloned());
            }
        }
    }

    PreviewRenderPlan {
        output_width: g.output_width,
        output_height: g.output_height,
        fps: g.output_fps,
        zoom_matrices,
        cursor_atlas_ref,
        ripples,
        text_boxes,
        background,
    }
}
