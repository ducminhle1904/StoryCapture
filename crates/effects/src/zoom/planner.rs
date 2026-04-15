//! Auto-zoom planner — produces smoothed [`ZoomKeyframe`] sequences.
//!
//! Filled in by Task 2. See module-level docs in [`super`].

use crate::ast::types::{EasingKind as AstEasingKind, Vec2};
use crate::ast::video::ZoomKeyframe;
use crate::math::lowpass::smooth_keyframes;
use crate::math::min_jerk::Waypoint;

use super::cluster::{cluster_waypoints, enforce_change_budget, merge_short_clusters};
use super::keyframe_builder::build_keyframes;
use super::presets::ZoomPreset;

/// Full Research §4 pipeline: cluster → merge short → enforce budget →
/// pan/scale/hold expansion → spring low-pass.
///
/// Returns `vec![ZoomKeyframe { t_ms: 0, center: viewport_center, scale: 1.0,
/// easing: Linear }]` when `waypoints` is empty, so callers can safely drop
/// the result into [`crate::ast::video::VideoNode::ZoomPan`] without a
/// conditional.
pub fn plan_zoom(
    waypoints: &[Waypoint],
    preset: &ZoomPreset,
    viewport_w: u32,
    viewport_h: u32,
) -> Vec<ZoomKeyframe> {
    if waypoints.is_empty() {
        return vec![ZoomKeyframe {
            t_ms: 0,
            center: Vec2::new(viewport_w as f32 / 2.0, viewport_h as f32 / 2.0),
            scale: 1.0,
            easing: AstEasingKind::Linear,
        }];
    }

    // 1. Cluster waypoints spatially + temporally.
    let mut clusters = cluster_waypoints(waypoints, preset, viewport_w, viewport_h);

    // 2. Merge sub-min_shot_ms clusters with their neighbours.
    merge_short_clusters(&mut clusters, preset.min_shot_ms);

    // 3. Drop lowest-weight clusters if we exceed max_changes_per_min.
    enforce_change_budget(&mut clusters, preset.max_changes_per_min);

    // 4. Expand clusters into (pan, scale, hold) keyframes per D-06.
    let raw = build_keyframes(&clusters, preset, viewport_w, viewport_h);

    // 5. Spring low-pass the scale field (pan already has its own easing).
    //    dt = 1/60s matches the 60 fps preview baseline.
    let dt = 1.0 / 60.0;
    let max_zoom = preset.max_zoom;
    smooth_keyframes(
        &raw,
        |k| k.scale,
        |k, v| k.scale = v.clamp(1.0, max_zoom),
        preset.low_pass_omega,
        dt,
    )
}
