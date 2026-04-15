//! Three FFmpeg drawtext animation presets from Research §7 table.
//!
//! Each preset returns the strings that `emit_drawtext` splices into the
//! filter's `alpha=`, `x=`, and `y=` expression slots. The compose
//! function [`compose_alpha_expr`] looks at a `TextBox`'s in/out anims
//! and returns a single alpha ramp covering both transitions.
//!
//! | Preset    | Alpha                                 | X (offset)               | Y (offset)               |
//! |-----------|----------------------------------------|--------------------------|--------------------------|
//! | `fade`    | 0→1 over in_ms, 1→0 over out_ms        | constant                 | constant                 |
//! | `slide-up`| identical to fade                      | constant                 | +40 → 0 over in_ms       |
//! | `scale-in`| identical to fade                      | constant                 | constant                 |
//!
//! `scale-in` is implemented at emit-time by wrapping the drawtext in a
//! `fontsize` expression `size*(0.8+0.2*min(1,(t-t0)/in_s))`; it does
//! not need a dedicated x/y builder because drawtext already centres
//! on `(x, y)` regardless of font size.

use crate::ast::video::{TextAnim, TextBox};

const DEFAULT_IN_MS: u64 = 300;
const DEFAULT_OUT_MS: u64 = 300;

/// Default animation durations.
pub const DEFAULT_ANIM_IN_MS: u64 = DEFAULT_IN_MS;
pub const DEFAULT_ANIM_OUT_MS: u64 = DEFAULT_OUT_MS;

/// Build a four-segment alpha ramp: 0 before `t_start`, linear in over
/// `in_ms`, hold at 1, linear out over `out_ms`, 0 after `t_end`.
pub fn anim_fade_params(t_start_ms: u64, t_end_ms: u64, in_ms: u64, out_ms: u64) -> String {
    let t0 = t_start_ms as f64 / 1000.0;
    let t1 = (t_start_ms + in_ms) as f64 / 1000.0;
    let span = t_end_ms.saturating_sub(t_start_ms);
    let effective_out = out_ms.min(span.saturating_sub(in_ms));
    let t3 = t_end_ms as f64 / 1000.0;
    let t2 = t3 - effective_out as f64 / 1000.0;
    let in_s = (in_ms as f64 / 1000.0).max(1e-6);
    let out_s = (effective_out as f64 / 1000.0).max(1e-6);

    format!(
        "if(lt(t,{t0:.3}),0,if(lt(t,{t1:.3}),(t-{t0:.3})/{in_s:.3},if(lt(t,{t2:.3}),1,if(lt(t,{t3:.3}),1-(t-{t2:.3})/{out_s:.3},0))))",
        t0 = t0, t1 = t1, t2 = t2, t3 = t3, in_s = in_s, out_s = out_s
    )
}

/// Return an `(alpha_expr, y_offset_expr)` pair for the slide-up preset.
pub fn anim_slide_up_params(
    t_start_ms: u64,
    t_end_ms: u64,
    in_ms: u64,
    out_ms: u64,
) -> (String, String) {
    let alpha = anim_fade_params(t_start_ms, t_end_ms, in_ms, out_ms);
    let t0 = t_start_ms as f64 / 1000.0;
    let t1 = (t_start_ms + in_ms) as f64 / 1000.0;
    let t3 = t_end_ms as f64 / 1000.0;
    let t2 = t3 - out_ms as f64 / 1000.0;
    let in_s = (in_ms as f64 / 1000.0).max(1e-6);
    let out_s = (out_ms as f64 / 1000.0).max(1e-6);
    let y_offset = format!(
        "if(lt(t,{t0:.3}),40,if(lt(t,{t1:.3}),40-40*(t-{t0:.3})/{in_s:.3},if(lt(t,{t2:.3}),0,if(lt(t,{t3:.3}),-40*(t-{t2:.3})/{out_s:.3},-40))))",
        t0 = t0, t1 = t1, t2 = t2, t3 = t3, in_s = in_s, out_s = out_s
    );
    (alpha, y_offset)
}

/// Return an `(alpha_expr, fontsize_scale_expr)` pair for the scale-in preset.
pub fn anim_scale_in_params(
    t_start_ms: u64,
    t_end_ms: u64,
    in_ms: u64,
    out_ms: u64,
) -> (String, String) {
    let alpha = anim_fade_params(t_start_ms, t_end_ms, in_ms, out_ms);
    let t0 = t_start_ms as f64 / 1000.0;
    let t1 = (t_start_ms + in_ms) as f64 / 1000.0;
    let in_s = (in_ms as f64 / 1000.0).max(1e-6);
    let scale = format!(
        "if(lt(t,{t0:.3}),0.8,if(lt(t,{t1:.3}),0.8+0.2*(t-{t0:.3})/{in_s:.3},1.0))",
        t0 = t0, t1 = t1, in_s = in_s
    );
    (alpha, scale)
}

/// Pick an alpha expression from the box's `anim_in` / `anim_out`.
pub fn compose_alpha_expr(tb: &TextBox) -> String {
    let needs_in = !matches!(tb.anim_in, TextAnim::None);
    let needs_out = !matches!(tb.anim_out, TextAnim::None);
    if !needs_in && !needs_out {
        return "1".to_string();
    }
    let in_ms = if needs_in { DEFAULT_IN_MS } else { 0 };
    let out_ms = if needs_out { DEFAULT_OUT_MS } else { 0 };
    anim_fade_params(tb.t_start_ms, tb.t_end_ms, in_ms, out_ms)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fade_expr_contains_all_segment_times() {
        let e = anim_fade_params(5_000, 10_000, 300, 300);
        assert!(e.contains("5.000"));
        assert!(e.contains("5.300"));
        assert!(e.contains("9.700"));
        assert!(e.contains("10.000"));
    }

    #[test]
    fn slide_up_mentions_amplitude() {
        let (_a, y) = anim_slide_up_params(1_000, 2_000, 300, 300);
        assert!(y.contains("40"));
    }

    #[test]
    fn scale_in_mentions_range() {
        let (_a, s) = anim_scale_in_params(1_000, 2_000, 300, 300);
        assert!(s.contains("0.8") && s.contains("0.2"));
    }

    #[test]
    fn compose_alpha_constant_when_no_anim() {
        let tb = crate::ast::video::TextBox {
            t_start_ms: 0,
            t_end_ms: 1_000,
            text: "x".into(),
            pos: crate::ast::types::Vec2::new(0.0, 0.0),
            font: crate::ast::video::FontChoice::SystemDefault,
            size_pt: 12.0,
            color: crate::ast::types::Rgba::new(255, 255, 255, 255),
            box_style: None,
            anim_in: TextAnim::None,
            anim_out: TextAnim::None,
        };
        assert_eq!(compose_alpha_expr(&tb), "1");
    }

    #[test]
    fn alpha_edges_present() {
        let expr = anim_fade_params(1_000, 2_000, 100, 100);
        assert!(expr.contains("1.000"));
        assert!(expr.contains("2.000"));
    }
}
