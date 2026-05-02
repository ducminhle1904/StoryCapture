//! Text overlay engine.
//!
//! This module ships three annotation primitives plus a set of helpers
//! that all map back to the canonical `VideoNode::TextOverlay` node in
//! the AST:
//!
//! 1. **Text boxes** — plain text via FFmpeg `drawtext`, with proper
//!    `:`/`\`/`'`/`%` escaping and font-path resolution that sidesteps
//!    the Windows drawtext colon-in-path trap (Pitfall #8) by copying
//!    bundled TTFs into a guaranteed-space-free UUID dir and emitting
//!    forward-slash paths.
//! 2. **Callout boxes** — rounded-rect + optional arrow PNGs rendered
//!    by [`callout::render_callout_png`] and overlaid via FFmpeg
//!    `overlay`. `drawtext` cannot draw shapes; pre-rendering is the
//!    canonical 2026 path.
//! 3. **Highlight rings** — PNGs sized to a DOM/UI bounding box with
//!    a pulse-alpha overlay (`0.5+0.5*sin(2*PI*(t-TSTART)/period)`) for
//!    the "look here" affordance.
//!
//! Three animation presets (fade / slide-up / scale-in) are exposed via
//! [`animation`] and composed into the drawtext emission. Auto-annotate
//! from DSL metadata lives in [`auto_annotate`] and is **off by default**
//! (the user opts in explicitly).

pub mod animation;
pub mod auto_annotate;
pub mod callout;
pub mod drawtext;
pub mod fonts;
pub mod highlight_ring;

pub use animation::{
    anim_fade_params, anim_scale_in_params, anim_slide_up_params, compose_alpha_expr,
};
pub use auto_annotate::{auto_annotate_step, AutoAnnotateOptions, StepAstRef};
pub use callout::{emit_callout_overlay, render_callout_png, ArrowDir, CalloutSpec};
pub use drawtext::{bundled_filename_for, emit_drawtext, escape_drawtext_text, path_to_ffmpeg_arg};
pub use fonts::{
    ensure_fonts_extracted, font_filename_for, resolve_bundled_font_path,
    resolve_bundled_font_path_by_name, BundledFont, BUNDLED_FONT_FILES,
};
pub use highlight_ring::{
    emit_ring_overlay, pulse_alpha_expr, render_highlight_overlay_png, render_highlight_ring_png,
    HighlightRenderResult, RingSpec,
};
