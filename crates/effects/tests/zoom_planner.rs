//! Integration tests for the auto-zoom planner.
//!
//! Exercises the full pipeline: cluster → merge → budget → pan/scale/hold →
//! spring low-pass. Motion-sickness guards (Pitfall #2) are tested here as
//! plan-level invariants, not just unit-level helpers.

use effects::ast::types::Vec2;
use effects::ast::EasingKind;
use effects::math::min_jerk::{Waypoint, WaypointKind};
use effects::zoom::{plan_zoom, CALM, DYNAMIC, SUBTLE};

fn wp(t_ms: u64, x: f32, y: f32, kind: WaypointKind) -> Waypoint {
    Waypoint {
        t_ms,
        pos: Vec2::new(x, y),
        kind,
    }
}

#[test]
fn empty_waypoints_returns_single_identity_keyframe() {
    let kfs = plan_zoom(&[], &DYNAMIC, 1920, 1080);
    assert_eq!(kfs.len(), 1);
    assert_eq!(kfs[0].t_ms, 0);
    assert!((kfs[0].center.x - 960.0).abs() < 1e-3);
    assert!((kfs[0].center.y - 540.0).abs() < 1e-3);
    assert!((kfs[0].scale - 1.0).abs() < 1e-3);
    assert_eq!(kfs[0].easing, EasingKind::Linear);
}

/// Enforcement: pan and scale must NEVER be simultaneous. For any two
/// consecutive keyframes, at most one of (center, scale) may change.
#[test]
fn pan_scale_hold_separation() {
    // Two clusters separated in time AND space so they produce distinct
    // pan/scale phases.
    let wps = [
        wp(0, 100.0, 100.0, WaypointKind::Click),
        wp(2000, 500.0, 500.0, WaypointKind::Click),
        wp(4000, 500.0, 500.0, WaypointKind::Click),
    ];
    let kfs = plan_zoom(&wps, &DYNAMIC, 1920, 1080);
    assert!(kfs.len() >= 3);

    for w in kfs.windows(2) {
        let a = &w[0];
        let b = &w[1];
        let center_changed =
            (a.center.x - b.center.x).abs() > 0.5 || (a.center.y - b.center.y).abs() > 0.5;
        // Scale is low-pass smoothed so it creeps every frame. For the
        // simultaneity check we look at "significant" scale changes (> 1%).
        let scale_changed = (a.scale - b.scale).abs() > 0.01;
        assert!(
            !(center_changed && scale_changed),
            "D-06 violated: pan & scale simultaneous between keyframes {a:?} and {b:?}"
        );
    }
}

#[test]
fn max_changes_per_min_enforced() {
    // 30 click clusters in 60s, spaced far apart in time + space so each is
    // its own cluster. DYNAMIC.max_changes_per_min = 10.
    let wps: Vec<_> = (0..30)
        .map(|i| wp(i as u64 * 2000, i as f32 * 100.0, 0.0, WaypointKind::Click))
        .collect();
    let kfs = plan_zoom(&wps, &DYNAMIC, 1920, 1080);
    // Each cluster produces up to 4 keyframes (pan_start, pan_end, scale_end, hold).
    // With a 60s timeline, budget = 10 clusters → ≤ 4*10 + 1 = 41 keyframes.
    assert!(
        kfs.len() <= 4 * 10 + 2,
        "expected ≤ 42 keyframes after budget enforcement, got {}",
        kfs.len()
    );
}

#[test]
fn min_shot_length_merges_short_clusters() {
    // Cluster A at t=0..3000ms, cluster B duration 400ms at t=3200..3600ms
    // (far apart in space to produce two clusters). B is below DYNAMIC's
    // min_shot_ms=1200 → must merge with A.
    let wps = [
        wp(0, 100.0, 100.0, WaypointKind::Click),
        wp(3000, 100.0, 100.0, WaypointKind::Hover),
        wp(3200, 900.0, 900.0, WaypointKind::Click),
        wp(3600, 900.0, 900.0, WaypointKind::Hover),
    ];
    let dyn_kfs = plan_zoom(&wps, &DYNAMIC, 1920, 1080);
    // A single merged cluster ⇒ at most 4 cluster-keyframes + initial = 5.
    // (Contrast: two clusters would be ≥ 8 keyframes.)
    assert!(
        dyn_kfs.len() <= 6,
        "expected ≤6 keyframes after merge, got {}",
        dyn_kfs.len()
    );
}

#[test]
fn subtle_pan_only_forces_scale_1() {
    let wps = [
        wp(0, 100.0, 100.0, WaypointKind::Click),
        wp(3000, 900.0, 900.0, WaypointKind::Click),
    ];
    let kfs = plan_zoom(&wps, &SUBTLE, 1920, 1080);
    // Every keyframe must have scale ≤ 1.0 (Subtle is pan-only; max_zoom=1.0).
    for k in &kfs {
        assert!(
            (k.scale - 1.0).abs() < 1e-3,
            "Subtle preset must keep scale=1.0, got {}",
            k.scale
        );
    }
}

/// Low-pass smoothing must bound scale within `[~1.0, preset.max_zoom]` — no
/// overshoot (Pitfall #2).
#[test]
fn low_pass_keeps_scale_within_bounds() {
    let wps = [
        wp(0, 100.0, 100.0, WaypointKind::Click),
        wp(2000, 200.0, 100.0, WaypointKind::Click),
        wp(4000, 100.0, 100.0, WaypointKind::Click),
    ];
    let kfs = plan_zoom(&wps, &DYNAMIC, 1920, 1080);
    for k in &kfs {
        assert!(k.scale >= 1.0 - 1e-3, "scale dipped below 1.0: {}", k.scale);
        assert!(
            k.scale <= DYNAMIC.max_zoom + 1e-3,
            "scale exceeded max_zoom {}: got {}",
            DYNAMIC.max_zoom,
            k.scale
        );
    }
}

#[test]
fn calm_preset_respects_max_zoom() {
    // Two very close clicks → clustering → scale would be extreme without cap.
    let wps = [
        wp(0, 500.0, 500.0, WaypointKind::Click),
        wp(200, 510.0, 505.0, WaypointKind::Click),
    ];
    let kfs = plan_zoom(&wps, &CALM, 1920, 1080);
    for k in &kfs {
        assert!(
            k.scale <= CALM.max_zoom + 1e-3,
            "Calm scale must be ≤ {}: got {}",
            CALM.max_zoom,
            k.scale
        );
    }
}

#[test]
fn keyframes_are_time_ordered() {
    let wps = [
        wp(0, 100.0, 100.0, WaypointKind::Click),
        wp(2500, 800.0, 500.0, WaypointKind::Click),
        wp(5000, 400.0, 900.0, WaypointKind::Click),
    ];
    let kfs = plan_zoom(&wps, &DYNAMIC, 1920, 1080);
    for w in kfs.windows(2) {
        assert!(
            w[0].t_ms <= w[1].t_ms,
            "keyframes must be non-decreasing in t_ms: {:?} then {:?}",
            w[0],
            w[1]
        );
    }
}

#[test]
fn deterministic_output() {
    let wps = [
        wp(0, 100.0, 100.0, WaypointKind::Click),
        wp(1500, 700.0, 400.0, WaypointKind::Click),
        wp(3000, 100.0, 100.0, WaypointKind::Click),
    ];
    let a = plan_zoom(&wps, &DYNAMIC, 1920, 1080);
    let b = plan_zoom(&wps, &DYNAMIC, 1920, 1080);
    assert_eq!(a.len(), b.len());
    for (x, y) in a.iter().zip(b.iter()) {
        assert_eq!(x.t_ms, y.t_ms);
        assert_eq!(x.center.x.to_bits(), y.center.x.to_bits());
        assert_eq!(x.scale.to_bits(), y.scale.to_bits());
    }
}
