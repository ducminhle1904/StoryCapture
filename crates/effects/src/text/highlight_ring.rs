//! Highlight-ring PNG rendering + pulse-alpha overlay (Task 2).
//!
//! Filled in by Plan 09 Task 2. Task 1 only ships the type surface.

use std::path::Path;

use crate::ast::types::{Rgba, Vec2};
use crate::error::Result;

#[derive(Debug, Clone, Copy)]
pub struct RingSpec {
    pub bbox_w: u32,
    pub bbox_h: u32,
    pub stroke_px: u32,
    pub color: Rgba,
    pub rounded_radius_px: u32,
}

/// Render a highlight ring to `out` as a transparent PNG with the
/// perimeter stroked. Returns `(width, height)` of the emitted bitmap.
pub fn render_highlight_ring_png(_spec: &RingSpec, _out: &Path) -> Result<(u32, u32)> {
    unimplemented!("render_highlight_ring_png: filled in by Plan 09 Task 2")
}

/// Produce the FFmpeg alpha expression that pulses between 0.0 and 1.0
/// with period `period_s`, centred on `t_start_s`.
pub fn pulse_alpha_expr(t_start_s: f64, period_s: f64) -> String {
    format!(
        "0.5+0.5*sin(2*PI*(t-{t_start:.3})/{period:.3})",
        t_start = t_start_s,
        period = period_s
    )
}

pub fn emit_ring_overlay(
    _ring_png: &Path,
    bbox_xy: Vec2,
    t_start_ms: u64,
    t_end_ms: u64,
    period_s: f64,
    in_label: &str,
    input_idx: usize,
    out_label: &str,
) -> String {
    let alpha = pulse_alpha_expr(t_start_ms as f64 / 1000.0, period_s);
    format!(
        "{in_label}[{idx}:v]overlay=x={x}:y={y}:alpha='{alpha}':enable='between(t,{s:.3},{e:.3})'{out}",
        in_label = in_label,
        idx = input_idx,
        x = bbox_xy.x as i32,
        y = bbox_xy.y as i32,
        alpha = alpha,
        s = t_start_ms as f64 / 1000.0,
        e = t_end_ms as f64 / 1000.0,
        out = out_label,
    )
}
