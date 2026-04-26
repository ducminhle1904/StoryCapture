//! Keyframe expansion: pan → scale → hold, **never combined**.
//!
//! Turning one [`super::cluster::ZoomCluster`] into keyframes produces four
//! points:
//!
//! ```text
//! t0             pan_end        scale_end      cluster.t_end_ms
//! │───────────────│──────────────│──────────────│
//! │  (hold prev)  │   PAN phase  │ SCALE phase  │   HOLD phase
//! │ prev_center   │ prev_center  │ cluster.c    │ cluster.c
//! │ prev_scale    │ prev_scale   │ prev_scale → │ target_scale
//! │               │              │  target      │
//! ```
//!
//! Pan and scale durations come from the preset. `pan_only` presets skip the
//! SCALE phase entirely (scale stays at `prev_scale`).

use crate::ast::types::{EasingKind as AstEasingKind, Vec2};
use crate::ast::video::ZoomKeyframe;

use super::cluster::ZoomCluster;
use super::presets::ZoomPreset;

/// Expand a list of clusters into an ordered keyframe sequence.
///
/// The first keyframe is always `(t=0, viewport_center, scale=1.0)` so the
/// zoompan expression has a valid starting sample even before the first
/// cluster's pan begins.
pub fn build_keyframes(
    clusters: &[ZoomCluster],
    preset: &ZoomPreset,
    viewport_w: u32,
    viewport_h: u32,
) -> Vec<ZoomKeyframe> {
    let mut out = Vec::with_capacity(clusters.len() * 4 + 1);

    let mut prev_center = Vec2::new(viewport_w as f32 / 2.0, viewport_h as f32 / 2.0);
    let mut prev_scale: f32 = 1.0;

    // Initial hold at identity.
    out.push(ZoomKeyframe {
        t_ms: 0,
        center: prev_center,
        scale: 1.0,
        easing: AstEasingKind::Linear,
    });

    for cluster in clusters {
        // Determine pan start. Pan + scale must fit within the time available
        // between the previous cluster and cluster.t_start_ms. We place the
        // pan+scale so the scale phase ends exactly at cluster.t_start_ms (so
        // the subject is fully zoomed before dwell begins) when the gap
        // allows; otherwise we start from the last keyframe's time and let
        // the gap flex.
        let last_t = out.last().map(|k| k.t_ms).unwrap_or(0);
        let pan_ms = preset.pan_duration_ms as u64;
        let scale_ms = if preset.pan_only {
            0
        } else {
            preset.scale_duration_ms as u64
        };
        let needed = pan_ms + scale_ms;

        let pan_start = if cluster.t_start_ms >= last_t + needed {
            cluster.t_start_ms - needed
        } else {
            last_t
        };

        // --- PAN phase: hold scale, move center from prev → cluster.center ---
        // Anchor at pan_start (previous state).
        out.push(ZoomKeyframe {
            t_ms: pan_start,
            center: prev_center,
            scale: prev_scale,
            easing: AstEasingKind::EaseInOut,
        });
        let pan_end = pan_start + pan_ms;
        out.push(ZoomKeyframe {
            t_ms: pan_end,
            center: cluster.center,
            scale: prev_scale,
            easing: AstEasingKind::EaseInOut,
        });

        // --- SCALE phase (skipped if pan_only) ---
        let target_scale = if preset.pan_only {
            prev_scale
        } else {
            cluster.scale.clamp(1.0, preset.max_zoom)
        };
        let scale_end = if preset.pan_only {
            pan_end
        } else {
            let e = pan_end + scale_ms;
            out.push(ZoomKeyframe {
                t_ms: e,
                center: cluster.center,
                scale: target_scale,
                easing: AstEasingKind::EaseInOut,
            });
            e
        };

        // --- HOLD phase to cluster.t_end_ms ---
        let hold_end = cluster.t_end_ms.max(scale_end);
        out.push(ZoomKeyframe {
            t_ms: hold_end,
            center: cluster.center,
            scale: target_scale,
            easing: AstEasingKind::Linear,
        });

        prev_center = cluster.center;
        prev_scale = target_scale;
    }

    out
}
