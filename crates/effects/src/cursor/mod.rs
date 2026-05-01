//! Cursor overlay engine.
//!
//! Deterministic minimum-jerk trajectory sampling between DSL-known click
//! waypoints, sub-pixel Perlin jitter for humanisation, direction-reversal
//! pauses, velocity caps, click ripples with 60 ms anticipation, 5 bundled
//! cursor skins, and a PNG-sequence renderer that emits to a Rust-owned
//! temp dir consumed by FFmpeg's `overlay` filter.
//!
//! See `02-06-PLAN.md` and Research §3 for the algorithm.

pub mod compositor;
pub mod png_sequence;
pub mod ripple;
pub mod skins;
pub mod trajectory;

pub use compositor::compose_frame;
pub use png_sequence::{
    render_cursor_pngs, render_cursor_pngs_from_actions,
    render_cursor_pngs_from_actions_with_min_frame_count, render_png_sequence, PngSequenceResult,
    RenderedCursorPng,
};
pub use ripple::{build_ripples, ripple_alpha, ripple_radius, RippleOptions};
pub use skins::{apply_tint, load_skin, resize, skin_asset_path, SkinBitmap};
pub use trajectory::{sample_trajectory, CursorSample, TrajectoryOptions};
