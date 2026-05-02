//! Auto-zoom planner.
//!
//! Converts click/hover/scroll/type waypoints into smooth pan-and-scale
//! keyframes following the discipline: **pan first → scale in → hold,
//! never combine pan and scale simultaneously** (motion sickness).
//!
//! ## Pipeline
//!
//! ```text
//! [Waypoint] --cluster--> [ZoomCluster]
//!                             |
//!                             v
//!                    merge_short_clusters  (enforce min_shot_ms)
//!                             |
//!                             v
//!                    enforce_change_budget (enforce max_changes_per_min)
//!                             |
//!                             v
//!                    build_keyframes       (pan → scale → hold)
//!                             |
//!                             v
//!                    smooth_keyframes      (spring low-pass, omega=6 default)
//!                             |
//!                             v
//!                           Vec<ZoomKeyframe>
//! ```
//!
//! Three presets are shipped:
//! - [`DYNAMIC`] — default, max_zoom=3.0, dwell=500ms, 10 changes/min
//! - [`CALM`]    — gentler, max_zoom=2.2, dwell=800ms, 6 changes/min
//! - [`SUBTLE`]  — pan-only, max_zoom=1.0, no scale changes
//!
//! Keyframes produced by [`plan_zoom`] are consumed by
//! [`crate::emit::ffmpeg`]'s `zoompan` expression generator and
//! [`crate::emit::preview`]'s per-frame matrix expansion — preview and final
//! stay in sync.

pub mod cluster;
pub mod keyframe_builder;
pub mod planner;
pub mod presets;
pub mod waypoint_source;

use crate::ast::types::Vec2;
use crate::ast::video::ZoomKeyframe;
use crate::math::ease;

pub use cluster::ZoomCluster;
pub use keyframe_builder::build_keyframes;
pub use planner::plan_zoom;
pub use presets::{ZoomPreset, ZoomPresetKind, CALM, DYNAMIC, SUBTLE};
pub use waypoint_source::WaypointSource;

#[cfg(feature = "sqlite")]
pub use waypoint_source::SqliteWaypointSource;

pub struct ZoomKeyframeSampler<'a> {
    keyframes: &'a [ZoomKeyframe],
    index: usize,
}

impl<'a> ZoomKeyframeSampler<'a> {
    pub fn new(keyframes: &'a [ZoomKeyframe]) -> Self {
        Self {
            keyframes,
            index: 0,
        }
    }

    pub fn sample(&mut self, t_ms: u64) -> (Vec2, f32) {
        sample_keyframes_from(&mut self.index, self.keyframes, t_ms)
    }
}

pub fn sample_keyframes(keyframes: &[ZoomKeyframe], t_ms: u64) -> (Vec2, f32) {
    let mut index = 0;
    sample_keyframes_from(&mut index, keyframes, t_ms)
}

fn sample_keyframes_from(index: &mut usize, keyframes: &[ZoomKeyframe], t_ms: u64) -> (Vec2, f32) {
    if keyframes.is_empty() {
        return (Vec2::new(0.5, 0.5), 1.0);
    }
    if t_ms <= keyframes.first().unwrap().t_ms {
        *index = 0;
        let k = keyframes.first().unwrap();
        return (k.center, k.scale.max(1.0));
    }
    if t_ms >= keyframes.last().unwrap().t_ms {
        *index = keyframes.len().saturating_sub(2);
        let k = keyframes.last().unwrap();
        return (k.center, k.scale.max(1.0));
    }

    if *index + 1 >= keyframes.len() || t_ms < keyframes[*index].t_ms {
        *index = 0;
    }
    while *index + 1 < keyframes.len() && t_ms > keyframes[*index + 1].t_ms {
        *index += 1;
    }

    let a = keyframes[*index];
    let b = keyframes[*index + 1];
    let span = (b.t_ms - a.t_ms) as f32;
    let u = if span > 0.0 {
        (t_ms - a.t_ms) as f32 / span
    } else {
        0.0
    };
    let eased = ease::apply(b.easing, u);
    (
        Vec2::new(
            a.center.x + (b.center.x - a.center.x) * eased,
            a.center.y + (b.center.y - a.center.y) * eased,
        ),
        (a.scale + (b.scale - a.scale) * eased).max(1.0),
    )
}
