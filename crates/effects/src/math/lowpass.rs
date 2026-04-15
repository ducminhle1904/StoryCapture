//! Spring-based low-pass filter for keyframe smoothing.
//!
//! Instead of a classical IIR or moving-average filter, we drive a
//! critically-damped [`Spring`] toward each successive target value. This has
//! two advantages for our use case (Plan 05 zoom keyframes):
//!
//! 1. **No overshoot** — critical damping guarantees the smoothed signal does
//!    not overshoot keyframe values, which matters when those values are
//!    viewport bounds (overshooting would crop the intended subject).
//! 2. **Framerate-aware** — passing the render `dt` gives time-consistent
//!    smoothing across arbitrary sample rates.
//!
//! Tune `omega` via `2π / time_to_settle`; see [`Spring`] docs.

use super::spring::Spring;

/// Low-pass a sequence of target values through a critically-damped spring,
/// returning the smoothed sample per input step.
///
/// One simulation step is taken per input value using the provided `dt`.
pub fn low_pass_1d(targets: &[f32], omega: f32, dt: f32, initial: f32) -> Vec<f32> {
    let mut s = Spring::new(initial, omega);
    targets
        .iter()
        .map(|&t| {
            s.target = t;
            s.step(dt);
            s.pos
        })
        .collect()
}

/// Smooth a list of keyframes by extracting one scalar dimension, spring-filtering
/// it, then patching the smoothed value back into a clone of each keyframe.
///
/// Callers wire up `extract`/`patch` for the field that needs smoothing (e.g.
/// `ZoomKeyframe.scale`) while leaving the rest of the struct untouched.
pub fn smooth_keyframes<T, F, G>(
    keyframes: &[T],
    extract: F,
    patch: G,
    omega: f32,
    dt: f32,
) -> Vec<T>
where
    T: Clone,
    F: Fn(&T) -> f32,
    G: Fn(&mut T, f32),
{
    let raw: Vec<f32> = keyframes.iter().map(&extract).collect();
    let initial = raw.first().copied().unwrap_or(0.0);
    let smoothed = low_pass_1d(&raw, omega, dt, initial);
    keyframes
        .iter()
        .zip(smoothed)
        .map(|(k, v)| {
            let mut k = k.clone();
            patch(&mut k, v);
            k
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn low_pass_step_function_rises_monotone() {
        // 10 frames at 0, then 10 frames at 1.
        let mut targets = vec![0.0; 10];
        targets.extend(vec![1.0; 10]);
        let smoothed = low_pass_1d(&targets, 12.0, 1.0 / 60.0, 0.0);
        // After the step, samples should rise monotonically and reach ≥0.5 by the end
        // (exact 0.95 requires a stronger omega; 12 Hz over 10 frames at 60fps is
        // ~0.17s of settling — picks up most of the step).
        let tail = &smoothed[10..];
        for w in tail.windows(2) {
            assert!(
                w[1] >= w[0] - 1e-6,
                "smoothed signal must be non-decreasing across step: {w:?}"
            );
        }
        assert!(
            *tail.last().unwrap() >= 0.5,
            "smoothed signal should recover ≥0.5 by end, got {}",
            tail.last().unwrap()
        );
    }

    #[test]
    fn smooth_keyframes_patches_scalar() {
        #[derive(Clone, Debug, PartialEq)]
        struct K {
            t: u64,
            v: f32,
        }
        let raw = vec![
            K { t: 0, v: 0.0 },
            K { t: 1, v: 1.0 },
            K { t: 2, v: 1.0 },
            K { t: 3, v: 1.0 },
        ];
        let out = smooth_keyframes(&raw, |k| k.v, |k, v| k.v = v, 10.0, 1.0 / 60.0);
        assert_eq!(out.len(), raw.len());
        // Timestamps preserved
        for (a, b) in raw.iter().zip(&out) {
            assert_eq!(a.t, b.t);
        }
        // Smoothed values cannot exceed the max target (no overshoot)
        for k in &out {
            assert!(
                k.v <= 1.0 + 1e-4,
                "smoothed value must not overshoot target, got {}",
                k.v
            );
        }
    }
}
