//! Integration tests for ripple factory + skin loader + PNG sequence renderer.

use std::path::Path;

use effects::ast::types::{Rgba, Vec2};
use effects::ast::video::CursorSkin;
use effects::cursor::{
    apply_tint, build_ripples, load_skin, render_png_sequence, ripple_alpha, ripple_radius,
    sample_trajectory, CursorSample, RippleOptions, TrajectoryOptions,
};
use effects::math::min_jerk::{Waypoint, WaypointKind};

fn wp(t_ms: u64, x: f32, y: f32, kind: WaypointKind) -> Waypoint {
    Waypoint { t_ms, pos: Vec2::new(x, y), kind }
}

#[test]
fn build_ripples_defaults() {
    let wps = [
        wp(1000, 100.0, 100.0, WaypointKind::Click),
        wp(2000, 200.0, 200.0, WaypointKind::Click),
        wp(3000, 300.0, 300.0, WaypointKind::Click),
    ];
    let out = build_ripples(&wps, &RippleOptions::default());
    assert_eq!(out.len(), 3);
    for (r, expected_t) in out.iter().zip([1000u64, 2000, 3000]) {
        assert_eq!(r.t_impact_ms, expected_t);
        assert_eq!(r.t_anticipate_ms, expected_t - 60);
        assert_eq!(r.duration_ms, 300);
        assert!((r.max_radius_px - 60.0).abs() < 1e-5);
        assert_eq!(r.color, Rgba { r: 255, g: 255, b: 255, a: 229 });
    }
}

#[test]
fn build_ripples_skips_non_clicks() {
    let wps = [
        wp(100, 0.0, 0.0, WaypointKind::Click),
        wp(200, 0.0, 0.0, WaypointKind::Hover),
        wp(300, 0.0, 0.0, WaypointKind::Hover),
        wp(400, 0.0, 0.0, WaypointKind::Hover),
        wp(500, 0.0, 0.0, WaypointKind::Scroll),
        wp(600, 0.0, 0.0, WaypointKind::Click),
    ];
    let out = build_ripples(&wps, &RippleOptions::default());
    assert_eq!(out.len(), 2);
}

#[test]
fn load_skin_all_five() {
    for kind in [
        CursorSkin::MacDefault,
        CursorSkin::WinDefault,
        CursorSkin::Dark,
        CursorSkin::Light,
        CursorSkin::BigArrow,
    ] {
        let skin = load_skin(kind).unwrap_or_else(|e| panic!("load_skin({:?}) failed: {e}", kind));
        assert!(skin.width > 0);
        assert!(skin.height > 0);
    }
}

#[test]
fn apply_tint_preserves_alpha() {
    let skin = load_skin(CursorSkin::MacDefault).expect("mac-default must load");
    let tinted = apply_tint(&skin, Rgba { r: 255, g: 0, b: 0, a: 255 });
    assert_eq!(tinted.width, skin.width);
    assert_eq!(tinted.height, skin.height);
    for (src, dst) in skin.pixels.pixels().zip(tinted.pixels.pixels()) {
        assert_eq!(src.0[3], dst.0[3], "alpha must be preserved");
    }
}

#[test]
fn render_png_sequence_creates_n_frames() {
    // 1 second trajectory at 60fps + 2 ripples → expect 60 PNGs.
    let wps = [
        wp(0, 50.0, 50.0, WaypointKind::Click),
        wp(500, 150.0, 100.0, WaypointKind::Hover),
        wp(1000, 250.0, 150.0, WaypointKind::Click),
    ];
    let traj = sample_trajectory(&wps, TrajectoryOptions::default());
    let ripples = build_ripples(&wps, &RippleOptions::default());
    assert_eq!(ripples.len(), 2);
    assert!(traj.len() >= 60, "trajectory should be ≥60 samples, got {}", traj.len());

    let skin = load_skin(CursorSkin::MacDefault).expect("skin");
    let tmp = tempfile::tempdir().expect("tmp");
    let result = render_png_sequence(&traj, &ripples, &skin, tmp.path(), 320, 240, 60)
        .expect("render");

    assert_eq!(result.frame_count as usize, traj.len());
    assert_eq!(result.fps, 60);
    // First and last PNGs exist with expected names.
    assert!(tmp.path().join("frame_00000.png").exists());
    let last = format!("frame_{:05}.png", traj.len() - 1);
    assert!(
        tmp.path().join(&last).exists(),
        "{last} should exist in {}",
        tmp.path().display()
    );
    // File count check: one PNG per sample.
    let png_count = std::fs::read_dir(tmp.path())
        .unwrap()
        .filter(|e| {
            e.as_ref()
                .map(|e| e.path().extension().and_then(|s| s.to_str()) == Some("png"))
                .unwrap_or(false)
        })
        .count();
    assert_eq!(png_count, traj.len());
}

#[test]
fn ripple_alpha_decay() {
    // At t = impact + 0.5 * duration, alpha ≈ 0.25 × base.
    let wps = [wp(1000, 100.0, 100.0, WaypointKind::Click)];
    let ripples = build_ripples(&wps, &RippleOptions::default());
    assert_eq!(ripples.len(), 1);
    let ev = ripples[0];
    let base = ev.color.a as f32 / 255.0;
    let half_t = ev.t_impact_ms + (ev.duration_ms as u64 / 2);
    let a = ripple_alpha(&ev, half_t);
    let expected = 0.25 * base;
    assert!(
        (a - expected).abs() < 1e-3,
        "expected {expected}, got {a}"
    );
    // Radius at half duration ≈ 0.5 * max_radius.
    let r = ripple_radius(&ev, half_t);
    assert!(
        (r - ev.max_radius_px * 0.5).abs() < 1e-3,
        "expected {}, got {r}",
        ev.max_radius_px * 0.5
    );
}

// Silence an unused-import warning when tests above don't reference
// `CursorSample` / `Path` directly in all compilation paths.
#[allow(dead_code)]
fn _unused(_: CursorSample, _: &Path) {}
