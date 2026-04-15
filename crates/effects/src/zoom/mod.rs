//! Auto-zoom planner (POST-02).
//!
//! Converts Phase 1 click/hover/scroll/type waypoints into smooth pan-and-scale
//! keyframes following D-06 discipline: **pan first → scale in → hold, never
//! combine pan and scale simultaneously** (Pitfall #2 — motion sickness).
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
//!                    build_keyframes       (pan → scale → hold; D-06)
//!                             |
//!                             v
//!                    smooth_keyframes      (spring low-pass, omega=6 default)
//!                             |
//!                             v
//!                           Vec<ZoomKeyframe>
//! ```
//!
//! Three presets are shipped per Research §4 + D-05:
//! - [`DYNAMIC`] — default, max_zoom=3.0, dwell=500ms, 10 changes/min
//! - [`CALM`]    — gentler, max_zoom=2.2, dwell=800ms, 6 changes/min
//! - [`SUBTLE`]  — pan-only, max_zoom=1.0, no scale changes
//!
//! Keyframes produced by [`plan_zoom`] are consumed by
//! [`crate::emit::ffmpeg`]'s `zoompan` expression generator and
//! [`crate::emit::preview`]'s per-frame matrix expansion — preview and final
//! stay in sync (D-01).

pub mod cluster;
pub mod keyframe_builder;
pub mod planner;
pub mod presets;
pub mod waypoint_source;

pub use cluster::ZoomCluster;
pub use keyframe_builder::build_keyframes;
pub use planner::plan_zoom;
pub use presets::{ZoomPreset, ZoomPresetKind, CALM, DYNAMIC, SUBTLE};
pub use waypoint_source::WaypointSource;

#[cfg(feature = "sqlite")]
pub use waypoint_source::SqliteWaypointSource;
