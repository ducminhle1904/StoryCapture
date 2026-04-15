//! Callout-box PNG rendering + FFmpeg overlay emission (Task 2).
//!
//! Filled in by Plan 09 Task 2. Task 1 only ships the type surface so
//! `crate::text` compiles as a whole.

use std::path::Path;

use crate::ast::types::{Rgba, Vec2};
use crate::ast::video::FontChoice;
use crate::error::Result;

/// Optional arrow direction on a callout box (points the viewer at the
/// element the callout is annotating).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArrowDir {
    Up,
    Down,
    Left,
    Right,
}

/// Static description of a callout — text, typography, fill, border,
/// corner radius and optional arrow. Rendered once to a PNG by
/// [`render_callout_png`] and composited via [`emit_callout_overlay`].
#[derive(Debug, Clone)]
pub struct CalloutSpec {
    pub text: String,
    pub size_pt: f32,
    pub font: FontChoice,
    pub fg: Rgba,
    pub bg: Rgba,
    pub border: Option<Rgba>,
    pub padding_px: u32,
    pub radius_px: u32,
    pub arrow: Option<ArrowDir>,
}

/// Render a callout to `out` as a PNG. Returns `(width, height)` of the
/// emitted bitmap. Task-2-scope (Plan 09).
pub fn render_callout_png(_spec: &CalloutSpec, _out: &Path) -> Result<(u32, u32)> {
    unimplemented!("render_callout_png: filled in by Plan 09 Task 2")
}

/// Emit the FFmpeg overlay stage for a callout PNG. `overlay_input_idx`
/// is the `[N:v]` stream index (i.e. which `-i` slot feeds the PNG).
pub fn emit_callout_overlay(
    _callout_png: &Path,
    pos: Vec2,
    t_start_ms: u64,
    t_end_ms: u64,
    in_label: &str,
    overlay_input_idx: usize,
    out_label: &str,
) -> String {
    format!(
        "{in_label}[{idx}:v]overlay=x={x}:y={y}:enable='between(t,{s:.3},{e:.3})'{out}",
        in_label = in_label,
        idx = overlay_input_idx,
        x = pos.x as i32,
        y = pos.y as i32,
        s = t_start_ms as f64 / 1000.0,
        e = t_end_ms as f64 / 1000.0,
        out = out_label,
    )
}
