//! Deterministic 2D Perlin noise used for sub-pixel cursor jitter (D-08).
//!
//! Output range: `[-1.0, 1.0]`. Callers scale by the desired jitter amplitude
//! (Research §3 recommends 0.5-1.5 px at ~2 Hz for natural cursor micromotion).
//!
//! ## Determinism
//! The permutation table is derived from the `seed: u64` via a small LCG, so
//! `PerlinNoise2D::new(seed).sample(x, y)` returns byte-identical outputs for
//! identical inputs **on the same host**. Threat T-02-05 accepts that
//! bit-for-bit identity across x86-64 and aarch64 is not guaranteed (f32
//! rounding differs on `fma`-capable targets) — downstream snapshot tests use
//! 1e-5 tolerance.

pub struct PerlinNoise2D {
    perm: [u8; 512],
}

impl PerlinNoise2D {
    /// Build a seeded permutation table.
    ///
    /// Algorithm: init `[0..=255]`, shuffle using a small LCG seeded from `seed`,
    /// then duplicate into the upper half of `perm` so `perm[i & 0xFF ... +255]`
    /// wraps naturally without bounds checks in [`Self::sample`].
    pub fn new(seed: u64) -> Self {
        let mut base: [u8; 256] = [0; 256];
        for (i, b) in base.iter_mut().enumerate() {
            *b = i as u8;
        }
        // Xorshift64* — deterministic across platforms.
        let mut state = if seed == 0 {
            0x9E3779B97F4A7C15u64
        } else {
            seed
        };
        let mut next = || {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            state
        };
        // Fisher-Yates shuffle (deterministic given `state`).
        for i in (1..256).rev() {
            let r = (next() % (i as u64 + 1)) as usize;
            base.swap(i, r);
        }
        let mut perm = [0u8; 512];
        for i in 0..256 {
            perm[i] = base[i];
            perm[i + 256] = base[i];
        }
        Self { perm }
    }

    /// Sample the noise field at `(x, y)`. Returns a value in `[-1, 1]`.
    pub fn sample(&self, x: f32, y: f32) -> f32 {
        let xi = (x.floor() as i32) & 0xFF;
        let yi = (y.floor() as i32) & 0xFF;
        let xf = x - x.floor();
        let yf = y - y.floor();

        let u = fade(xf);
        let v = fade(yf);

        let p = |i: i32| self.perm[(i & 0xFF) as usize] as i32;

        let aa = p(p(xi) + yi);
        let ab = p(p(xi) + yi + 1);
        let ba = p(p(xi + 1) + yi);
        let bb = p(p(xi + 1) + yi + 1);

        let x1 = lerp(u, grad(aa, xf, yf), grad(ba, xf - 1.0, yf));
        let x2 = lerp(u, grad(ab, xf, yf - 1.0), grad(bb, xf - 1.0, yf - 1.0));
        // Classic Perlin output is roughly in [-sqrt(2)/2, sqrt(2)/2]; normalise
        // to a safer envelope. Clamp guards against the rare corner case where
        // the gradient math exceeds ±1 by a hair on unusual inputs.
        lerp(v, x1, x2).clamp(-1.0, 1.0)
    }
}

/// 6t⁵ − 15t⁴ + 10t³ — Perlin's improved fade curve (Siggraph 2002).
#[inline]
fn fade(t: f32) -> f32 {
    t * t * t * (t * (t * 6.0 - 15.0) + 10.0)
}

#[inline]
fn lerp(t: f32, a: f32, b: f32) -> f32 {
    a + t * (b - a)
}

/// Gradient selection: the low 4 bits of `hash` pick one of 8 canonical
/// 2-D gradients (±1, ±1) or axis-aligned, then dot with `(x, y)`.
#[inline]
fn grad(hash: i32, x: f32, y: f32) -> f32 {
    match hash & 7 {
        0 => x + y,
        1 => -x + y,
        2 => x - y,
        3 => -x - y,
        4 => x,
        5 => -x,
        6 => y,
        _ => -y,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn perlin_reproducible_same_call() {
        let p = PerlinNoise2D::new(42);
        let a = p.sample(1.5, 2.3);
        let b = p.sample(1.5, 2.3);
        assert_eq!(a.to_bits(), b.to_bits(), "same input must give same bits");
    }

    #[test]
    fn perlin_reproducible_across_instances() {
        let p1 = PerlinNoise2D::new(42);
        let p2 = PerlinNoise2D::new(42);
        for i in 0..20 {
            for j in 0..20 {
                let x = i as f32 * 0.37;
                let y = j as f32 * 0.29;
                assert_eq!(
                    p1.sample(x, y).to_bits(),
                    p2.sample(x, y).to_bits(),
                    "seeded instances must match at ({x},{y})"
                );
            }
        }
    }

    #[test]
    fn perlin_amplitude_bounded() {
        let p = PerlinNoise2D::new(7);
        for i in 0..100 {
            for j in 0..100 {
                let x = i as f32 * 0.13;
                let y = j as f32 * 0.19;
                let v = p.sample(x, y);
                assert!(
                    v >= -1.0 && v <= 1.0,
                    "sample out of [-1,1] at ({x},{y}): {v}"
                );
            }
        }
    }

    #[test]
    fn perlin_at_lattice_points_is_zero() {
        // Classic Perlin: value at integer lattice points is 0 (all gradient
        // dot products use zero offsets).
        let p = PerlinNoise2D::new(12345);
        for i in 0..10 {
            for j in 0..10 {
                let v = p.sample(i as f32, j as f32);
                assert!(v.abs() < 1e-5, "lattice point ({i},{j}) = {v}, expected 0");
            }
        }
    }

    #[test]
    fn perlin_different_seeds_differ() {
        let p1 = PerlinNoise2D::new(1);
        let p2 = PerlinNoise2D::new(2);
        // Sample at a non-lattice point.
        let a = p1.sample(1.25, 3.75);
        let b = p2.sample(1.25, 3.75);
        assert_ne!(a, b, "different seeds should produce different samples");
    }
}
