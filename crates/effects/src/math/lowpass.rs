//! Spring-based low-pass smoother — implemented in Task 2.

use super::spring::Spring;

/// 1D low-pass (placeholder; Task 2 implements full behaviour).
pub fn low_pass_1d(targets: &[f32], _omega: f32, _dt: f32, _initial: f32) -> Vec<f32> {
    targets.to_vec()
}

/// Keyframe smoother (placeholder; Task 2 implements full behaviour).
pub fn smooth_keyframes<T: Clone, F: Fn(&T) -> f32, G: Fn(&mut T, f32)>(
    keyframes: &[T],
    _extract: F,
    _patch: G,
    _omega: f32,
    _dt: f32,
) -> Vec<T> {
    keyframes.to_vec()
}

// Silence unused-import warning during Task 1.
#[allow(dead_code)]
fn _ensure_spring_linked(_s: &Spring) {}
