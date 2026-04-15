//! Easing functions used by the auto-zoom planner (Plan 05) for keyframe
//! interpolation (pan/scale phases) and by cursor micro-motions.
//!
//! Per Research §3 / §4 we only need three curves for v1:
//! - `Linear` — no easing, literal lerp
//! - `EaseInOutCubic` — cinematic pan start/stop, matches Runway/Loom zooms
//! - `EaseOutQuad` — quick settle for cursor-final-position nudges
//!
//! This module defines its own [`EasingKind`] distinct from the AST-level
//! [`crate::ast::types::EasingKind`] enum. The AST enum is the serialised
//! form stored in presets; this one is the numerical form consumed by the
//! zoom/cursor math. Plan 05 is responsible for mapping one to the other
//! (or consolidating them) when it wires `ZoomKeyframe.easing` into the
//! per-frame sampler.

use serde::{Deserialize, Serialize};

#[cfg(feature = "ts-export")]
use ts_rs::TS;

/// Three easing curves used by the numerical zoom/cursor path samplers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-export", derive(TS))]
#[cfg_attr(
    feature = "ts-export",
    ts(
        export,
        export_to = "../../../packages/shared-types/src/generated/effects.ts",
        rename = "MathEasingKind"
    )
)]
#[serde(rename_all = "kebab-case")]
pub enum EasingKind {
    Linear,
    EaseInOutCubic,
    EaseOutQuad,
}

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

/// Dispatch `kind` to the corresponding easing function.
#[inline]
pub fn apply(kind: EasingKind, t: f32) -> f32 {
    match kind {
        EasingKind::Linear => linear(t),
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
