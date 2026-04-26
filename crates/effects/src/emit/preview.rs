//! AST → [`PreviewRenderPlan`] (JSON consumable by the WebGPU preview player).
//!
//! Like the FFmpeg emitter, this is the **shape** contract — downstream
//! work refines keyframe interpolation and cursor atlas generation. The
//! initial scope is to lock the JSON layout so the frontend inspector can
//! start building views against stable types.

use serde::{Deserialize, Serialize};

use crate::ast::video::{
    BackgroundKind, RippleEvent, TextBox, TrajectoryRef, VideoNode, ZoomKeyframe,
};
use crate::ast::{types::Vec2, Graph};

/// Linear-interpolate the keyframe list at time `t_ms`, returning
/// `(center, scale)`. Caller guarantees `!keyframes.is_empty()`.
///
/// Before the first keyframe, holds the first value; after the last, holds
/// the last value.
fn sample_keyframes_lerp(keyframes: &[ZoomKeyframe], t_ms: u64) -> (Vec2, f32) {
    debug_assert!(!keyframes.is_empty());
    if t_ms <= keyframes.first().unwrap().t_ms {
        let k = keyframes.first().unwrap();
        return (k.center, k.scale);
    }
    if t_ms >= keyframes.last().unwrap().t_ms {
        let k = keyframes.last().unwrap();
        return (k.center, k.scale);
    }
    // Find the bracketing pair.
    for pair in keyframes.windows(2) {
        let a = pair[0];
        let b = pair[1];
        if t_ms >= a.t_ms && t_ms <= b.t_ms {
            let span = (b.t_ms - a.t_ms) as f32;
            let u = if span > 0.0 {
                (t_ms - a.t_ms) as f32 / span
            } else {
                0.0
            };
            let cx = a.center.x + (b.center.x - a.center.x) * u;
            let cy = a.center.y + (b.center.y - a.center.y) * u;
            let sc = a.scale + (b.scale - a.scale) * u;
            return (Vec2::new(cx, cy), sc);
        }
    }
    // Unreachable for sorted keyframes.
    let k = keyframes.last().unwrap();
    (k.center, k.scale)
}

#[cfg(feature = "ts-export")]
use ts_rs::TS;

/// One frame sample of the zoom-pan curve. The placeholder sampler is
/// replaced with true keyframe interpolation; the type is fixed so the
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
                // Expand keyframes to per-frame samples at g.output_fps via
                // linear interpolation. Spring low-pass was already applied
                // at plan time so the frontend just lerps between samples.
                if keyframes.is_empty() {
                    // Nothing to emit.
                } else if keyframes.len() == 1 {
                    zoom_matrices.push(ZoomMatrixFrame {
                        t_ms: keyframes[0].t_ms,
                        center: keyframes[0].center,
                        scale: keyframes[0].scale,
                    });
                } else {
                    let fps = g.output_fps.max(1);
                    let frame_ms = 1000.0 / fps as f32;
                    let t_start = keyframes.first().unwrap().t_ms;
                    let t_end = keyframes.last().unwrap().t_ms;
                    let total_frames = (((t_end - t_start) as f32) / frame_ms).ceil() as u64 + 1;
                    for i in 0..total_frames {
                        let t_ms = t_start + (i as f32 * frame_ms).round() as u64;
                        let sample = sample_keyframes_lerp(keyframes, t_ms);
                        zoom_matrices.push(ZoomMatrixFrame {
                            t_ms,
                            center: sample.0,
                            scale: sample.1,
                        });
                    }
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
