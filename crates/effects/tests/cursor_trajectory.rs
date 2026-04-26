//! Integration tests for the cursor trajectory sampler.
//!
//! Covers: endpoint exactness, jitter bounds, determinism given seed,
//! reversal pauses, velocity-cap segment extension, post-click dwell.

use effects::ast::types::Vec2;
use effects::cursor::{sample_trajectory, TrajectoryOptions};
use effects::math::min_jerk::{Waypoint, WaypointKind};

fn wp(t_ms: u64, x: f32, y: f32, kind: WaypointKind) -> Waypoint {
    Waypoint {
        t_ms,
        pos: Vec2::new(x, y),
        kind,
    }
}

fn opts_no_jitter() -> TrajectoryOptions {
    TrajectoryOptions {
        jitter_amplitude_px: 0.0,
        ..Default::default()
    }
}

#[test]
fn sample_trajectory_endpoint_exact() {
    // With jitter disabled, first sample is w[0].pos and last is w[-1].pos.
    let wps = [
        wp(0, 100.0, 200.0, WaypointKind::Hover),
        wp(1000, 500.0, 400.0, WaypointKind::Hover),
    ];
    let samples = sample_trajectory(&wps, opts_no_jitter());
    assert!(samples.len() >= 60);
    assert!((samples.first().unwrap().pos.x - 100.0).abs() < 1e-2);
    assert!((samples.first().unwrap().pos.y - 200.0).abs() < 1e-2);
    assert!((samples.last().unwrap().pos.x - 500.0).abs() < 1e-2);
    assert!((samples.last().unwrap().pos.y - 400.0).abs() < 1e-2);
}

#[test]
fn jitter_bounded() {
    // Every sample is within 1.5 px of the un-jittered path.
    let wps = [
        wp(0, 100.0, 200.0, WaypointKind::Hover),
        wp(1000, 500.0, 400.0, WaypointKind::Hover),
    ];
    let with_jitter = sample_trajectory(
        &wps,
        TrajectoryOptions {
            jitter_amplitude_px: 1.0,
            ..Default::default()
        },
    );
    let without_jitter = sample_trajectory(&wps, opts_no_jitter());
    assert_eq!(with_jitter.len(), without_jitter.len());
    for (j, n) in with_jitter.iter().zip(without_jitter.iter()) {
        let dx = (j.pos.x - n.pos.x).abs();
        let dy = (j.pos.y - n.pos.y).abs();
        assert!(dx <= 1.5 + 1e-4, "x jitter {dx} > 1.5 at t={}", j.t_ms);
        assert!(dy <= 1.5 + 1e-4, "y jitter {dy} > 1.5 at t={}", j.t_ms);
    }
}

#[test]
fn deterministic_with_seed() {
    let wps = [
        wp(0, 100.0, 200.0, WaypointKind::Hover),
        wp(800, 400.0, 500.0, WaypointKind::Click),
        wp(1600, 700.0, 300.0, WaypointKind::Hover),
    ];
    let a = sample_trajectory(
        &wps,
        TrajectoryOptions {
            jitter_seed: 42,
            ..Default::default()
        },
    );
    let b = sample_trajectory(
        &wps,
        TrajectoryOptions {
            jitter_seed: 42,
            ..Default::default()
        },
    );
    assert_eq!(a.len(), b.len());
    for (x, y) in a.iter().zip(b.iter()) {
        assert_eq!(x.t_ms, y.t_ms);
        assert_eq!(
            x.pos.x.to_bits(),
            y.pos.x.to_bits(),
            "x bits differ at t={}",
            x.t_ms
        );
        assert_eq!(
            x.pos.y.to_bits(),
            y.pos.y.to_bits(),
            "y bits differ at t={}",
            x.t_ms
        );
    }
}

#[test]
fn reversal_pause_inserted() {
    // U-turn: A → B → A flags a reversal at B. Expect a run of samples at B
    // with near-zero inter-sample deltas for at least `reversal_pause_ms`.
    let wps = [
        wp(0, 0.0, 0.0, WaypointKind::Hover),
        wp(500, 400.0, 0.0, WaypointKind::Hover),
        wp(1000, 0.0, 0.0, WaypointKind::Hover),
    ];
    let opts = TrajectoryOptions {
        jitter_amplitude_px: 0.0,
        reversal_pause_ms: 100,
        ..Default::default()
    };
    let samples = sample_trajectory(&wps, opts);
    // Find a run of consecutive samples whose pos is within 0.5 px of (400, 0).
    let mut max_run = 0usize;
    let mut cur_run = 0usize;
    for s in &samples {
        let near_b = (s.pos.x - 400.0).abs() < 0.5 && s.pos.y.abs() < 0.5;
        if near_b {
            cur_run += 1;
            max_run = max_run.max(cur_run);
        } else {
            cur_run = 0;
        }
    }
    // 100ms at 60fps ≈ 6 frames.
    assert!(
        max_run >= 6,
        "expected ≥6 consecutive samples at pivot during pause, got {max_run}"
    );
}

#[test]
fn velocity_cap_lengthens_segment() {
    // 3000 px in 500 ms → peak ≈ 11,250 px/s ≫ 2500 cap. Segment must be
    // extended until peak ≤ 2500 px/s. Resulting trajectory has more than
    // fps * 0.5 (= 30) samples.
    let wps = [
        wp(0, 0.0, 0.0, WaypointKind::Hover),
        wp(500, 3000.0, 0.0, WaypointKind::Hover),
    ];
    let opts = TrajectoryOptions {
        jitter_amplitude_px: 0.0,
        ..Default::default()
    };
    let samples = sample_trajectory(&wps, opts);
    assert!(
        samples.len() > 30,
        "velocity cap should stretch segment; got only {} samples",
        samples.len()
    );
}

#[test]
fn post_click_dwell() {
    // Click at 1000ms, Hover at 2000ms. Samples in [1000, 1200] ms must hold
    // at the click position (no motion).
    let wps = [
        wp(0, 0.0, 0.0, WaypointKind::Hover),
        wp(1000, 300.0, 200.0, WaypointKind::Click),
        wp(2000, 600.0, 400.0, WaypointKind::Hover),
    ];
    let opts = TrajectoryOptions {
        jitter_amplitude_px: 0.0,
        post_click_dwell_ms: 200,
        ..Default::default()
    };
    let samples = sample_trajectory(&wps, opts);
    // Collect samples in the dwell window.
    let dwell: Vec<_> = samples
        .iter()
        .filter(|s| s.t_ms >= 1000 && s.t_ms <= 1200)
        .collect();
    assert!(
        dwell.len() >= 5,
        "expected several samples during dwell window; got {}",
        dwell.len()
    );
    for s in &dwell {
        assert!(
            (s.pos.x - 300.0).abs() < 0.5 && (s.pos.y - 200.0).abs() < 0.5,
            "sample at t={} drifted from click pos: {:?}",
            s.t_ms,
            s.pos
        );
    }
}
