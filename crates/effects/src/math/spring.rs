//! Critically-damped spring smoother (Research §4, Code Example 2).
//!
//! Models a 1-D value driven toward a target with a mass-spring-damper at
//! **critical damping** — the fastest convergence with **no overshoot**. Used
//! by the auto-zoom planner (Plan 05) to low-pass zoom keyframes and by the
//! cursor engine (Plan 06) to smooth small noise-driven path corrections.
//!
//! The integration step (semi-implicit Euler) is:
//!
//! ```text
//! F   = -2·ω·v − ω²·(x − target)
//! v  += F · dt
//! x  += v · dt
//! ```
//!
//! ## Tuning `omega`
//! `omega ≈ 2π / time_to_settle`. Concretely:
//! - `omega = 6.0` → settles in ~1 s
//! - `omega = 12.0` → settles in ~0.5 s
//! - `omega = 3.0` → settles in ~2 s
//!
//! For `dt` use `1.0 / fps` of the calling render context (typically 60 fps).
//! If `omega · dt` exceeds ~0.5, the semi-implicit integrator becomes numerically
//! noisy; cap `omega` accordingly in the caller.

pub struct Spring {
    pub pos: f32,
    pub vel: f32,
    pub target: f32,
    pub omega: f32,
}

impl Spring {
    pub fn new(initial: f32, omega: f32) -> Self {
        Self {
            pos: initial,
            vel: 0.0,
            target: initial,
            omega,
        }
    }

    pub fn with_target(initial: f32, target: f32, omega: f32) -> Self {
        Self {
            pos: initial,
            vel: 0.0,
            target,
            omega,
        }
    }

    /// Advance the simulation by `dt` seconds. Uses the critically-damped
    /// force law (Research §4, Code Example 2):
    pub fn step(&mut self, dt: f32) {
        let f = -2.0 * self.omega * self.vel - self.omega.powi(2) * (self.pos - self.target);
        self.vel += f * dt;
        self.pos += self.vel * dt;
    }

    /// Retarget and advance up to `max_steps` times, returning the final
    /// position. Convenience for offline smoothing.
    pub fn settle(&mut self, target: f32, dt: f32, max_steps: usize) -> f32 {
        self.target = target;
        for _ in 0..max_steps {
            self.step(dt);
        }
        self.pos
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spring_converges_no_overshoot() {
        let mut s = Spring::new(0.0, 6.0);
        s.target = 1.0;
        let dt = 1.0 / 60.0;
        let mut max_seen = f32::MIN;
        for _ in 0..180 {
            s.step(dt);
            if s.pos > max_seen {
                max_seen = s.pos;
            }
        }
        assert!(
            s.pos >= 0.99 && s.pos <= 1.001,
            "expected convergence near 1.0, got {}",
            s.pos
        );
        // Critical damping: no overshoot beyond target.
        assert!(
            max_seen <= 1.0 + 1e-4,
            "critical damping should not overshoot; max={max_seen}"
        );
    }

    #[test]
    fn spring_deterministic() {
        let mut a = Spring::new(0.0, 5.0);
        let mut b = Spring::new(0.0, 5.0);
        let dt = 1.0 / 60.0;
        let targets: [f32; 10] = [0.2, 0.4, 0.6, 0.6, 0.5, 1.0, 1.0, 0.0, 0.3, 0.8];
        let mut aa = Vec::new();
        let mut bb = Vec::new();
        for &t in &targets {
            a.target = t;
            b.target = t;
            for _ in 0..6 {
                a.step(dt);
                b.step(dt);
            }
            aa.push(a.pos.to_bits());
            bb.push(b.pos.to_bits());
        }
        assert_eq!(aa, bb, "identical schedules must produce identical bits");
    }

    #[test]
    fn settle_reaches_target() {
        let mut s = Spring::new(0.0, 10.0);
        let final_pos = s.settle(5.0, 1.0 / 60.0, 240);
        assert!(
            (final_pos - 5.0).abs() < 0.01,
            "settle should land near target, got {final_pos}"
        );
    }
}
