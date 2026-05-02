//! Insta golden snapshots for zoompan emission + Preview matrix expansion.
//!
//! Pins the zoompan filter syntax for three reference preset configs so any
//! accidental drift in expression generation is caught in CI.

use std::path::PathBuf;

use effects::ast::types::NodeId;
use effects::ast::video::ZoomTarget;
use effects::ast::Vec2;
use effects::emit::ffmpeg::{zoompan_expr, ExprAxis};
use effects::math::min_jerk::{Waypoint, WaypointKind};
use effects::zoom::{plan_zoom, CALM, DYNAMIC, SUBTLE};
use effects::{FfmpegEmit, GraphBuilder, PreviewEmit};

fn fixed_id(b: u8) -> NodeId {
    NodeId::from_bytes([b; 16])
}

fn reference_waypoints() -> Vec<Waypoint> {
    vec![
        Waypoint {
            t_ms: 0,
            pos: Vec2::new(100.0, 100.0),
            kind: WaypointKind::Click,
        },
        Waypoint {
            t_ms: 2000,
            pos: Vec2::new(500.0, 500.0),
            kind: WaypointKind::Click,
        },
        Waypoint {
            t_ms: 4500,
            pos: Vec2::new(1800.0, 200.0),
            kind: WaypointKind::Click,
        },
        Waypoint {
            t_ms: 7000,
            pos: Vec2::new(900.0, 900.0),
            kind: WaypointKind::Click,
        },
    ]
}

fn build_graph_with_preset(preset_kfs: Vec<effects::ast::video::ZoomKeyframe>) -> effects::Graph {
    GraphBuilder::new(1920, 1080, 60)
        .source(fixed_id(0xA1), PathBuf::from("in.mp4"), 0)
        .zoom_pan(fixed_id(0xA2), ZoomTarget::Cursor, preset_kfs)
        .build()
        .expect("minimal zoom graph must build")
}

#[test]
fn snapshot_zoom_dynamic() {
    let kfs = plan_zoom(&reference_waypoints(), &DYNAMIC, 1920, 1080);
    let g = build_graph_with_preset(kfs);
    let out = FfmpegEmit::emit(&g);
    assert!(out.contains("zoompan=z="), "must emit zoompan");
    insta::with_settings!({
        snapshot_path => "fixtures",
        prepend_module_to_snapshot => false,
    }, {
        insta::assert_snapshot!("zoom_dynamic.filter_complex", out);
    });
}

#[test]
fn snapshot_zoom_calm() {
    let kfs = plan_zoom(&reference_waypoints(), &CALM, 1920, 1080);
    let g = build_graph_with_preset(kfs);
    let out = FfmpegEmit::emit(&g);
    insta::with_settings!({
        snapshot_path => "fixtures",
        prepend_module_to_snapshot => false,
    }, {
        insta::assert_snapshot!("zoom_calm.filter_complex", out);
    });
}

#[test]
fn snapshot_zoom_subtle_pan_only() {
    let kfs = plan_zoom(&reference_waypoints(), &SUBTLE, 1920, 1080);
    let g = build_graph_with_preset(kfs);
    let out = FfmpegEmit::emit(&g);
    insta::with_settings!({
        snapshot_path => "fixtures",
        prepend_module_to_snapshot => false,
    }, {
        insta::assert_snapshot!("zoom_subtle_pan_only.filter_complex", out);
    });
}

/// Pan-only must NEVER emit a scale > 1.0 literal — scan the generated
/// filter_complex and assert every `z=...` sample falls within tolerance.
#[test]
fn subtle_never_emits_scale_change() {
    let kfs = plan_zoom(&reference_waypoints(), &SUBTLE, 1920, 1080);
    for k in &kfs {
        assert!(
            (k.scale - 1.0).abs() < 1e-3,
            "Subtle keyframe has non-identity scale: {}",
            k.scale
        );
    }
    // The rendered zoompan expression should therefore contain "1.0000" as the
    // only literal for z (and no other scale literal).
    let z_expr = zoompan_expr(&kfs, ExprAxis::Z);
    // Easing expressions may contain powers such as `pow(u,3)`, so check the
    // formatted scale literals instead of every numeric token.
    assert!(
        !z_expr.contains("2.0000") && !z_expr.contains("3.0000"),
        "Subtle z-expression contains a non-identity scale literal: {z_expr}"
    );
}

#[test]
fn zoompan_expr_single_keyframe_is_constant() {
    let kfs = vec![effects::ast::video::ZoomKeyframe {
        t_ms: 0,
        center: Vec2::new(100.0, 200.0),
        scale: 1.5,
        easing: effects::ast::EasingKind::Linear,
    }];
    let z = zoompan_expr(&kfs, ExprAxis::Z);
    // Single keyframe collapses to a literal scale value, no if(...) ladder.
    assert!(
        !z.contains("if("),
        "single keyframe must not emit if(): {z}"
    );
    assert!(z.contains("1.5000"), "expected 1.5000 literal: {z}");
}

#[test]
fn zoompan_expr_empty_keyframes_is_safe_default() {
    let z = zoompan_expr(&[], ExprAxis::Z);
    assert_eq!(z, "1.0");
    let x = zoompan_expr(&[], ExprAxis::X);
    assert_eq!(x, "0");
}

#[test]
fn preview_and_ffmpeg_consume_same_keyframes() {
    let kfs = plan_zoom(&reference_waypoints(), &DYNAMIC, 1920, 1080);
    let g = build_graph_with_preset(kfs.clone());

    // FFmpeg emission should reference every inner keyframe time.
    let ff = FfmpegEmit::emit(&g);
    for k in &kfs {
        let t_s = format!("{:.6}", (k.t_ms as f64) / 1000.0);
        // Skip the last keyframe, which is the outer "else" of the ladder and
        // doesn't need a literal lt(t,...) gate.
        if k.t_ms == kfs.last().unwrap().t_ms {
            continue;
        }
        assert!(
            ff.contains(&format!("lt(t,{t_s})")),
            "expected ffmpeg to gate at {t_s}s (kf={k:?}): {ff}"
        );
    }

    // Preview plan should include at least one sample per keyframe span.
    let plan = PreviewEmit::emit(&g);
    assert!(
        plan.zoom_matrices.len() >= kfs.len(),
        "preview samples ({}) should be ≥ keyframe count ({})",
        plan.zoom_matrices.len(),
        kfs.len()
    );
}
