//! Drop shadow emitter (POST-04). Produces an offset, blurred, tinted copy of
//! the input's alpha channel that is composited under the foreground video
//! by the caller (`background::compositor`).

use crate::ast::types::{Rgba, Vec2};

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ShadowParams {
    pub blur_px: f32,
    pub offset: Vec2,
    pub color: Rgba,
}

impl ShadowParams {
    /// Material Design-ish default: 16 px blur, (0, 8) offset, 40%-alpha black.
    pub fn soft_default() -> Self {
        Self {
            blur_px: 16.0,
            offset: Vec2::new(0.0, 8.0),
            color: Rgba::new(0, 0, 0, 102),
        }
    }
}

/// Emit a shadow-generation chain. Consumes `input_label` (the rounded video
/// stream), splits it, tints + blurs one copy, and exposes the blurred shadow
/// at `output_label`. The compositor then overlays the original video ON TOP
/// of this shadow at the appropriate offset.
///
/// The returned filter produces a plate the same size as the input; offset
/// positioning is applied at overlay time by the compositor so that the
/// shadow bleeds beyond the frame edges.
pub fn emit_drop_shadow(p: &ShadowParams, input_label: &str, output_label: &str) -> String {
    let blur = p.blur_px.round().max(1.0) as u32;
    let a = (p.color.a as f32) / 255.0;
    // Replace RGB with the shadow tint while preserving the alpha channel,
    // then box-blur. `boxblur={radius}:1` applies a 1-pass blur of the given
    // radius on the luma+chroma+alpha planes.
    format!(
        "{input_label}format=rgba,geq=r='{r}':g='{g}':b='{b}':a='alpha(X,Y)*{a:.3}',boxblur={blur}:1{output_label}",
        input_label = input_label,
        output_label = output_label,
        r = p.color.r,
        g = p.color.g,
        b = p.color.b,
        a = a,
        blur = blur,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn emits_boxblur_and_tint() {
        let out = emit_drop_shadow(
            &ShadowParams {
                blur_px: 32.0,
                offset: Vec2::new(0.0, 8.0),
                color: Rgba::new(0, 0, 0, 128),
            },
            "[frame]",
            "[shadow]",
        );
        assert!(out.contains("boxblur=32:1"));
        assert!(out.contains("geq=r='0'"));
        assert!(out.starts_with("[frame]"));
        assert!(out.ends_with("[shadow]"));
    }

    #[test]
    fn soft_default_is_sane() {
        let p = ShadowParams::soft_default();
        assert_eq!(p.blur_px, 16.0);
        assert_eq!(p.offset.y, 8.0);
    }
}
