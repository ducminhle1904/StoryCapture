//! Integration tests for `effects::math::spring`, `effects::math::lowpass`,
//! and `effects::math::perlin`. These are the numerical primitives the
//! auto-zoom planner depends on.

use effects::math::lowpass::low_pass_1d;
use effects::math::perlin::PerlinNoise2D;
use effects::math::spring::Spring;

#[test]
fn spring_converges_without_overshoot() {
    let mut s = Spring::new(0.0, 6.0);
    s.target = 1.0;
    let dt = 1.0 / 60.0;
    let mut peak = f32::MIN;
    for _ in 0..180 {
        s.step(dt);
        if s.pos > peak {
            peak = s.pos;
        }
    }
    assert!(
        s.pos >= 0.99 && s.pos <= 1.001,
        "expected convergence near 1.0, got {}",
        s.pos
    );
    assert!(
        peak <= 1.0 + 1e-4,
        "critical damping must not overshoot; peak={peak}"
    );
}

#[test]
fn spring_is_deterministic_across_runs() {
    let dt = 1.0 / 60.0;
    let run = || {
        let mut s = Spring::new(0.5, 8.0);
        let mut out = Vec::new();
        for i in 0..60 {
            s.target = if i < 30 { 1.0 } else { -0.5 };
            s.step(dt);
            out.push(s.pos.to_bits());
        }
        out
    };
    assert_eq!(run(), run(), "byte-identical sequences expected");
}

#[test]
fn low_pass_1d_smooths_step_function() {
    let mut targets = vec![0.0; 15];
    targets.extend(vec![1.0; 45]);
    let smoothed = low_pass_1d(&targets, 15.0, 1.0 / 60.0, 0.0);
    // After the step, smoothed output is monotone non-decreasing and
    // approaches the target.
    let tail = &smoothed[15..];
    for w in tail.windows(2) {
        assert!(w[1] >= w[0] - 1e-6, "non-decreasing violated: {w:?}");
    }
    assert!(
        *tail.last().unwrap() >= 0.95,
        "should reach ≥0.95 by end, got {}",
        tail.last().unwrap()
    );
}

#[test]
fn perlin_reproducible_across_instances() {
    let a = PerlinNoise2D::new(42);
    let b = PerlinNoise2D::new(42);
    assert_eq!(a.sample(1.5, 2.3).to_bits(), b.sample(1.5, 2.3).to_bits());
    assert_eq!(
        a.sample(10.2, -4.7).to_bits(),
        b.sample(10.2, -4.7).to_bits()
    );
}

#[test]
fn perlin_amplitude_bounded_on_dense_grid() {
    let p = PerlinNoise2D::new(1337);
    for i in 0..100 {
        for j in 0..100 {
            let x = i as f32 * 0.11;
            let y = j as f32 * 0.17;
            let v = p.sample(x, y);
            assert!(v >= -1.0 && v <= 1.0, "out of range at ({x},{y}): {v}");
        }
    }
}

#[test]
fn perlin_different_seeds_diverge() {
    let a = PerlinNoise2D::new(1);
    let b = PerlinNoise2D::new(2);
    assert_ne!(a.sample(2.5, 3.7), b.sample(2.5, 3.7));
}
