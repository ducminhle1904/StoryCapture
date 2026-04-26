//! Extension trait adding vector arithmetic to [`crate::ast::types::Vec2`].
//!
//! We deliberately do NOT redefine `Vec2` here — the AST already owns the
//! type and its serde/ts-rs wiring. `Vec2Ops` adds the math operations
//! needed by
//! [`super::min_jerk`] and the cursor/zoom pipelines without duplicating the
//! data layout or the TS export.

use crate::ast::types::Vec2;

pub trait Vec2Ops: Sized + Copy {
    fn add(self, other: Vec2) -> Vec2;
    fn sub(self, other: Vec2) -> Vec2;
    fn scale(self, k: f32) -> Vec2;
    fn length(self) -> f32;
    /// Angle between two vectors, in degrees, in `[0, 180]`.
    ///
    /// Returns `0.0` if either vector is zero-length (convention: no reversal).
    fn angle_between_deg(self, other: Vec2) -> f32;
}

impl Vec2Ops for Vec2 {
    #[inline]
    fn add(self, other: Vec2) -> Vec2 {
        Vec2::new(self.x + other.x, self.y + other.y)
    }

    #[inline]
    fn sub(self, other: Vec2) -> Vec2 {
        Vec2::new(self.x - other.x, self.y - other.y)
    }

    #[inline]
    fn scale(self, k: f32) -> Vec2 {
        Vec2::new(self.x * k, self.y * k)
    }

    #[inline]
    fn length(self) -> f32 {
        (self.x * self.x + self.y * self.y).sqrt()
    }

    fn angle_between_deg(self, other: Vec2) -> f32 {
        let la = self.length();
        let lb = other.length();
        if la <= f32::EPSILON || lb <= f32::EPSILON {
            return 0.0;
        }
        let dot = self.x * other.x + self.y * other.y;
        let cos = (dot / (la * lb)).clamp(-1.0, 1.0);
        cos.acos().to_degrees()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn add_sub_scale() {
        let a = Vec2::new(3.0, 4.0);
        let b = Vec2::new(1.0, 2.0);
        assert_eq!(a.add(b), Vec2::new(4.0, 6.0));
        assert_eq!(a.sub(b), Vec2::new(2.0, 2.0));
        assert_eq!(a.scale(2.0), Vec2::new(6.0, 8.0));
    }

    #[test]
    fn length_is_euclidean() {
        let v = Vec2::new(3.0, 4.0);
        assert!((v.length() - 5.0).abs() < 1e-5);
        assert_eq!(Vec2::ZERO.length(), 0.0);
    }

    #[test]
    fn angle_between_deg_spans_0_180() {
        let right = Vec2::new(1.0, 0.0);
        let up = Vec2::new(0.0, 1.0);
        let left = Vec2::new(-1.0, 0.0);
        assert!((right.angle_between_deg(right) - 0.0).abs() < 1e-3);
        assert!((right.angle_between_deg(up) - 90.0).abs() < 1e-3);
        assert!((right.angle_between_deg(left) - 180.0).abs() < 1e-3);
    }

    #[test]
    fn angle_between_zero_vector_is_zero() {
        assert_eq!(Vec2::new(1.0, 0.0).angle_between_deg(Vec2::ZERO), 0.0);
        assert_eq!(Vec2::ZERO.angle_between_deg(Vec2::new(1.0, 0.0)), 0.0);
    }
}
