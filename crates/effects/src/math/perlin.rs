//! Deterministic 2D Perlin noise — implemented in Task 2.
//!
//! Placeholder so the `math` module compiles during Task 1 TDD.

pub struct PerlinNoise2D {
    #[allow(dead_code)]
    perm: [u8; 512],
}

impl PerlinNoise2D {
    pub fn new(_seed: u64) -> Self {
        Self { perm: [0; 512] }
    }
    pub fn sample(&self, _x: f32, _y: f32) -> f32 {
        0.0
    }
}
