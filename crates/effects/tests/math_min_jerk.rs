//! Integration tests for `effects::math::min_jerk`.
//!
//! Covers endpoint correctness, path resampling length, and U-turn reversal
//! detection — verifying the public surface the cursor engine imports.

use effects::ast::types::Vec2;
use effects::math::min_jerk::{
    detect_reversals, min_jerk_sample, peak_velocity, sample_path, Waypoint, WaypointKind,
};

fn wp(t_ms: u64, x: f32, y: f32) -> Waypoint {
    Waypoint {
        t_ms,
        pos: Vec2::new(x, y),
        kind: WaypointKind::Click,
    }
}

#[test]
fn endpoints_lock_p0_and_p1() {
    let p0 = Vec2::new(10.0, 20.0);
    let p1 = Vec2::new(110.0, 20.0);
    let s0 = min_jerk_sample(p0, p1, 0.0, 0.8);
    let s1 = min_jerk_sample(p0, p1, 0.8, 0.8);
    assert!((s0.x - p0.x).abs() < 1e-3 && (s0.y - p0.y).abs() < 1e-3);
    assert!((s1.x - p1.x).abs() < 1e-3 && (s1.y - p1.y).abs() < 1e-3);
}

#[test]
fn sample_path_length_matches_fps_times_duration() {
    let wps = [wp(0, 0.0, 0.0), wp(1000, 200.0, 0.0)];
    let samples = sample_path(&wps, 60);
    // 60 intra-segment samples + 1 final endpoint = 61
    assert!(
        samples.len() >= 58 && samples.len() <= 62,
        "expected ~60 samples, got {}",
        samples.len()
    );
    assert!((samples.first().unwrap().x - 0.0).abs() < 1e-3);
    assert!((samples.last().unwrap().x - 200.0).abs() < 1e-3);
}

#[test]
fn detect_reversals_u_turn() {
    // Synthetic U-turn: out-and-back.
    let wps = [wp(0, 0.0, 0.0), wp(500, 200.0, 0.0), wp(1000, 0.0, 0.0)];
    let rev = detect_reversals(&wps, 135.0);
    assert_eq!(rev, vec![1]);
}

#[test]
fn peak_velocity_matches_closed_form() {
    let v = peak_velocity(Vec2::new(0.0, 0.0), Vec2::new(400.0, 0.0), 2.0);
    // 400 * 1.875 / 2 = 375
    assert!((v - 375.0).abs() < 1e-3, "expected 375, got {v}");
}
