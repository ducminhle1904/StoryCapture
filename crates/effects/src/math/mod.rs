//! Pure math primitives used by Plan 05 (auto-zoom planner) and Plan 06 (cursor engine).
//!
//! Every function in this module is:
//! - **pure** — no I/O, no globals, no randomness except from seeded generators
//! - **deterministic** — same inputs always produce the same outputs on a given host
//! - **rayon-friendly** — `Send + Sync`; safe to parallelise
//! - **AST-free** — only depends on [`crate::ast::types::Vec2`] and [`crate::ast::types::EasingKind`]
//!
//! See Research §3 (minimum-jerk trajectories) and §4 (critically-damped spring smoothing)
//! for the algorithmic derivations this module implements.

pub mod ease;
pub mod lowpass;
pub mod min_jerk;
pub mod perlin;
pub mod spring;
pub mod vec2;

pub use ease::{apply as ease_apply, ease_in_out_cubic, ease_out_quad, linear};
pub use lowpass::{low_pass_1d, smooth_keyframes};
pub use min_jerk::{
    detect_reversals, min_jerk_sample, peak_velocity, sample_path, Waypoint, WaypointKind,
};
pub use perlin::PerlinNoise2D;
pub use spring::Spring;
pub use vec2::Vec2Ops;
