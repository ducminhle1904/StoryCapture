//! Minimum-jerk trajectory sampler (Flash & Hogan 1985).
//!
//! The 5th-order minimum-jerk polynomial
//!
//! ```text
//! s(τ) = 10 τ³ − 15 τ⁴ + 6 τ⁵    with τ = t / duration ∈ [0, 1]
//! ```
//!
//! produces human-like motion with zero velocity and zero acceleration at both
//! endpoints. It is the canonical model for realistic cursor paths (Research §3).
//! Positions are interpolated linearly between `p0` and `p1` by `s(τ)`.
//!
//! ## Responsibilities
//! - [`min_jerk_sample`] — one sample of a single segment
//! - [`sample_path`] — resample a waypoint list at a fixed `fps`
//! - [`detect_reversals`] — flag sharp direction changes (Research §3: >135°)
//! - [`peak_velocity`] — closed-form peak velocity at `τ=0.5` (1.875 × Δ / T)
//!
//! ## Caller responsibilities / DoS note (T-02-04)
//! `sample_path` is O(fps × duration_sec). The caller (Plan 05/06) is responsible
//! for clamping extreme `fps` or waypoint durations; practical upper bound is
//! ~600s × 120fps = 72 000 samples.

use crate::ast::types::Vec2;
use crate::math::vec2::Vec2Ops;

use serde::{Deserialize, Serialize};

#[cfg(feature = "ts-export")]
use ts_rs::TS;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-export", derive(TS))]
#[cfg_attr(
    feature = "ts-export",
    ts(
        export,
        export_to = "../../../packages/shared-types/src/generated/effects.ts"
    )
)]
#[serde(rename_all = "kebab-case")]
pub enum WaypointKind {
    Click,
    Hover,
    Scroll,
    Type,
    Drag,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-export", derive(TS))]
#[cfg_attr(
    feature = "ts-export",
    ts(
        export,
        export_to = "../../../packages/shared-types/src/generated/effects.ts"
    )
)]
pub struct Waypoint {
    pub t_ms: u64,
    pub pos: Vec2,
    pub kind: WaypointKind,
}

/// Sample one minimum-jerk segment from `p0` to `p1` at time `t_sec` within a
/// total `duration_sec`. `t_sec` is clamped to `[0, duration_sec]`.
///
/// Endpoints: `t=0 -> p0`, `t=duration -> p1`, with zero velocity at both.
pub fn min_jerk_sample(p0: Vec2, p1: Vec2, t_sec: f32, duration_sec: f32) -> Vec2 {
    let tau = if duration_sec <= 0.0 {
        1.0
    } else {
        (t_sec / duration_sec).clamp(0.0, 1.0)
    };
    // s(tau) = 10*tau^3 - 15*tau^4 + 6*tau^5   (Flash & Hogan 1985, Research §3)
    let s = 10.0 * tau.powi(3) - 15.0 * tau.powi(4) + 6.0 * tau.powi(5);
    p0.add(p1.sub(p0).scale(s))
}

/// Resample an ordered waypoint list at a fixed frame rate.
///
/// For each consecutive pair `(w[i], w[i+1])`:
///   segment duration = `(w[i+1].t_ms - w[i].t_ms) / 1000`
///   emit `ceil(seg_sec * fps)` samples via [`min_jerk_sample`].
///
/// The final waypoint position is appended once at the end so the last sample
/// lands exactly on `w[last].pos`.
///
/// Returns an empty Vec if fewer than 2 waypoints are provided, or if `fps == 0`.
pub fn sample_path(waypoints: &[Waypoint], fps: u32) -> Vec<Vec2> {
    if waypoints.len() < 2 || fps == 0 {
        return Vec::new();
    }
    let dt = 1.0 / fps as f32;
    let mut out = Vec::new();
    for pair in waypoints.windows(2) {
        let w0 = pair[0];
        let w1 = pair[1];
        if w1.t_ms <= w0.t_ms {
            // Degenerate segment — skip.
            continue;
        }
        let seg_sec = (w1.t_ms - w0.t_ms) as f32 / 1000.0;
        let n = (seg_sec * fps as f32).round() as u32;
        for i in 0..n {
            let t_sec = i as f32 * dt;
            out.push(min_jerk_sample(w0.pos, w1.pos, t_sec, seg_sec));
        }
    }
    // Ensure the final waypoint lands exactly.
    if let Some(last) = waypoints.last() {
        out.push(last.pos);
    }
    out
}

/// Indices of waypoints whose incoming→outgoing direction change exceeds
/// `threshold_deg` (Research §3 uses 135°).
///
/// For each interior waypoint `b` with neighbours `a`, `c`:
///   angle = angle_between_deg(b-a, c-b)
///   if angle > threshold_deg → reversal
///
/// Returned indices are into the input slice, always in `[1, len-2]`.
pub fn detect_reversals(waypoints: &[Waypoint], threshold_deg: f32) -> Vec<usize> {
    let mut out = Vec::new();
    if waypoints.len() < 3 {
        return out;
    }
    for i in 1..waypoints.len() - 1 {
        let a = waypoints[i - 1].pos;
        let b = waypoints[i].pos;
        let c = waypoints[i + 1].pos;
        let incoming = b.sub(a);
        let outgoing = c.sub(b);
        if incoming.angle_between_deg(outgoing) > threshold_deg {
            out.push(i);
        }
    }
    out
}

/// Closed-form peak velocity (px/s) of a minimum-jerk segment.
///
/// `s'(τ) = 30τ² - 60τ³ + 30τ⁴`; maximum is at `τ=0.5` where
/// `s'(0.5) = 7.5 - 7.5 + 1.875 = 1.875`. Converting τ to seconds:
/// `peak_vel = ‖p1 - p0‖ * 1.875 / duration_sec`.
///
/// Returns `f32::INFINITY` for non-positive durations.
pub fn peak_velocity(p0: Vec2, p1: Vec2, duration_sec: f32) -> f32 {
    if duration_sec <= 0.0 {
        return f32::INFINITY;
    }
    p1.sub(p0).length() * 1.875 / duration_sec
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wp(t_ms: u64, x: f32, y: f32) -> Waypoint {
        Waypoint {
            t_ms,
            pos: Vec2::new(x, y),
            kind: WaypointKind::Hover,
        }
    }

    #[test]
    fn min_jerk_endpoints() {
        let p0 = Vec2::new(0.0, 0.0);
        let p1 = Vec2::new(100.0, 0.0);
        let s0 = min_jerk_sample(p0, p1, 0.0, 1.0);
        let s1 = min_jerk_sample(p0, p1, 1.0, 1.0);
        assert!((s0.x - 0.0).abs() < 1e-3);
        assert!((s0.y - 0.0).abs() < 1e-3);
        assert!((s1.x - 100.0).abs() < 1e-3);
        assert!((s1.y - 0.0).abs() < 1e-3);
    }

    #[test]
    fn min_jerk_midpoint() {
        let p0 = Vec2::new(0.0, 0.0);
        let p1 = Vec2::new(100.0, 0.0);
        let s = min_jerk_sample(p0, p1, 0.5, 1.0);
        // s(0.5) = 10*0.125 - 15*0.0625 + 6*0.03125 = 1.25 - 0.9375 + 0.1875 = 0.5
        assert!(
            (s.x - 50.0).abs() < 1e-3,
            "expected 50.0 at midpoint, got {}",
            s.x
        );
    }

    #[test]
    fn min_jerk_zero_velocity_at_endpoints() {
        let p0 = Vec2::new(0.0, 0.0);
        let p1 = Vec2::new(100.0, 0.0);
        // numerical derivative near 0
        let s0 = min_jerk_sample(p0, p1, 0.0, 1.0);
        let s_eps = min_jerk_sample(p0, p1, 0.001, 1.0);
        let v0 = (s_eps.x - s0.x) / 0.001;
        assert!(
            v0.abs() < 0.5,
            "initial velocity should be near zero, got {v0}"
        );
        // numerical derivative near 1
        let s1 = min_jerk_sample(p0, p1, 1.0, 1.0);
        let s_pre = min_jerk_sample(p0, p1, 0.999, 1.0);
        let v1 = (s1.x - s_pre.x) / 0.001;
        assert!(
            v1.abs() < 0.5,
            "final velocity should be near zero, got {v1}"
        );
    }

    #[test]
    fn sample_path_length() {
        let samples = sample_path(&[wp(0, 0.0, 0.0), wp(1000, 100.0, 0.0)], 60);
        // 60 intra-segment samples + 1 final endpoint = 61
        assert!(
            (samples.len() as i64 - 60).abs() <= 2,
            "expected ~60 samples, got {}",
            samples.len()
        );
        // first sample at origin, last sample at endpoint
        assert!((samples.first().unwrap().x - 0.0).abs() < 1e-3);
        assert!((samples.last().unwrap().x - 100.0).abs() < 1e-3);
    }

    #[test]
    fn sample_path_empty_for_single_waypoint() {
        assert!(sample_path(&[wp(0, 0.0, 0.0)], 60).is_empty());
    }

    #[test]
    fn detect_reversals_180deg() {
        // Three waypoints forming a U-turn: right, then back left.
        let wps = [wp(0, 0.0, 0.0), wp(500, 100.0, 0.0), wp(1000, 0.0, 0.0)];
        let rev = detect_reversals(&wps, 135.0);
        assert_eq!(rev, vec![1], "middle waypoint should flag a reversal");
    }

    #[test]
    fn detect_reversals_straight_no_reversal() {
        let wps = [wp(0, 0.0, 0.0), wp(500, 50.0, 0.0), wp(1000, 100.0, 0.0)];
        assert!(detect_reversals(&wps, 135.0).is_empty());
    }

    #[test]
    fn peak_velocity_closed_form() {
        // 100px over 1s → peak = 187.5 px/s
        let v = peak_velocity(Vec2::ZERO, Vec2::new(100.0, 0.0), 1.0);
        assert!((v - 187.5).abs() < 1e-3, "expected 187.5, got {v}");
    }

    #[test]
    fn peak_velocity_triggers_clamp_at_2500() {
        // 2000px in 0.5s → peak = 2000 * 1.875 / 0.5 = 7500 px/s (would exceed 2500 cap)
        let v = peak_velocity(Vec2::ZERO, Vec2::new(2000.0, 0.0), 0.5);
        assert!(v > 2500.0, "caller should clamp; got {v}");
    }
}
