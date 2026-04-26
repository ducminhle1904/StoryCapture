//! Easing functions used by the auto-zoom planner for keyframe
//! interpolation (pan/scale phases) and by cursor micro-motions.
//!
//! All easing variants now live on the canonical [`crate::ast::types::EasingKind`]
//! enum (previously split between an AST enum and this module's numerical
//! enum — consolidated per the /simplify review). The samplers below
//! dispatch on all variants; variants without a bespoke cubic/quad
//! implementation fall through to a reasonable numerical equivalent.

pub use crate::ast::types::EasingKind;

/// Linear (identity). `t` is clamped to `[0, 1]`.
#[inline]
pub fn linear(t: f32) -> f32 {
    t.clamp(0.0, 1.0)
}

/// Cubic ease-in-out. `s(0)=0, s(1)=1, s(0.5)=0.5`, symmetric around `t=0.5`.
#[inline]
pub fn ease_in_out_cubic(t: f32) -> f32 {
    let t = t.clamp(0.0, 1.0);
    if t < 0.5 {
        4.0 * t.powi(3)
    } else {
        1.0 - (-2.0 * t + 2.0).powi(3) / 2.0
    }
}

/// Quadratic ease-out. `s(0)=0, s(1)=1`, fast start, smooth settle.
#[inline]
pub fn ease_out_quad(t: f32) -> f32 {
    let t = t.clamp(0.0, 1.0);
    1.0 - (1.0 - t).powi(2)
}

/// Quadratic ease-in. `s(0)=0, s(1)=1`, slow start.
#[inline]
pub fn ease_in_quad(t: f32) -> f32 {
    let t = t.clamp(0.0, 1.0);
    t * t
}

/// Generic ease-in-out (cubic). Identical to [`ease_in_out_cubic`]; exposed
/// as a distinct name so the AST enum's `EaseInOut` variant has an explicit
/// numerical mapping (cubic is the "default" symmetric ease).
#[inline]
pub fn ease_in_out(t: f32) -> f32 {
    ease_in_out_cubic(t)
}

/// Dispatch `kind` to the corresponding easing function. All variants on
/// the unified [`EasingKind`] enum are handled:
///
/// | Variant           | Numerical form       |
/// |-------------------|----------------------|
/// | Linear            | `linear`             |
/// | EaseIn            | `ease_in_quad`       |
/// | EaseOut           | `ease_out_quad`      |
/// | EaseInOut         | `ease_in_out_cubic`  |
/// | EaseInOutCubic    | `ease_in_out_cubic`  |
/// | EaseOutQuad       | `ease_out_quad`      |
#[inline]
pub fn apply(kind: EasingKind, t: f32) -> f32 {
    match kind {
        EasingKind::Linear => linear(t),
        EasingKind::EaseIn => ease_in_quad(t),
        EasingKind::EaseOut => ease_out_quad(t),
        EasingKind::EaseInOut => ease_in_out_cubic(t),
        EasingKind::EaseInOutCubic => ease_in_out_cubic(t),
        EasingKind::EaseOutQuad => ease_out_quad(t),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn linear_endpoints() {
        assert_eq!(linear(0.0), 0.0);
        assert_eq!(linear(1.0), 1.0);
        assert_eq!(linear(-0.5), 0.0);
        assert_eq!(linear(1.5), 1.0);
    }

    #[test]
    fn ease_in_out_cubic_endpoints_and_midpoint() {
        assert!((ease_in_out_cubic(0.0) - 0.0).abs() < 1e-6);
        assert!((ease_in_out_cubic(1.0) - 1.0).abs() < 1e-6);
        assert!((ease_in_out_cubic(0.5) - 0.5).abs() < 1e-6);
    }

    #[test]
    fn ease_in_out_cubic_monotone() {
        let samples: Vec<f32> = [0.0, 0.25, 0.5, 0.75, 1.0]
            .iter()
            .map(|&t| ease_in_out_cubic(t))
            .collect();
        assert!((samples.first().copied().unwrap() - 0.0).abs() < 1e-6);
        assert!((samples.last().copied().unwrap() - 1.0).abs() < 1e-6);
        for w in samples.windows(2) {
            assert!(
                w[1] >= w[0] - 1e-6,
                "ease_in_out_cubic must be non-decreasing: {w:?}"
            );
        }
    }

    #[test]
    fn ease_out_quad_endpoints() {
        assert!((ease_out_quad(0.0) - 0.0).abs() < 1e-6);
        assert!((ease_out_quad(1.0) - 1.0).abs() < 1e-6);
        // Fast start: at t=0.25, should already exceed 0.4
        assert!(ease_out_quad(0.25) > 0.4);
    }

    #[test]
    fn apply_dispatches() {
        assert_eq!(apply(EasingKind::Linear, 0.3), 0.3);
        assert!((apply(EasingKind::EaseInOutCubic, 0.5) - 0.5).abs() < 1e-6);
        assert!((apply(EasingKind::EaseOutQuad, 1.0) - 1.0).abs() < 1e-6);
    }
}
