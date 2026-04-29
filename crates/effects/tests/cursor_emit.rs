//! Snapshot + shape tests for the CursorOverlay + RippleOverlay FFmpeg
//! emitters and the PreviewRenderPlan expansion.

use std::path::PathBuf;

use effects::ast::types::{NodeId, Vec2};
use effects::ast::video::{CursorSkin, RippleEvent, TrajectoryRef};
use effects::{FfmpegEmit, GraphBuilder, PreviewEmit};

fn fixed_id(b: u8) -> NodeId {
    NodeId::from_bytes([b; 16])
}

fn build_cursor_graph() -> effects::Graph {
    GraphBuilder::new(1920, 1080, 60)
        .source(fixed_id(0x01), PathBuf::from("in.mp4"), 0)
        .cursor(
            fixed_id(0x0C),
            CursorSkin::MacDefault,
            1.0,
            None,
            TrajectoryRef {
                png_sequence_dir: PathBuf::from("/tmp/cursor/frame_%05d.png"),
                fps: 60,
                frame_count: 180,
            },
        )
        .ripple(
            fixed_id(0x0D),
            vec![
                RippleEvent::at_impact(1000, Vec2::new(400.0, 300.0)),
                RippleEvent::at_impact(2000, Vec2::new(800.0, 500.0)),
                RippleEvent::at_impact(3000, Vec2::new(1200.0, 700.0)),
            ],
        )
        .build()
        .expect("cursor graph must build")
}

#[test]
fn cursor_overlay_emits_overlay_with_eof_action_pass() {
    let g = build_cursor_graph();
    let out = FfmpegEmit::emit(&g);
    assert!(
        out.contains("overlay=eof_action=pass"),
        "expected overlay=eof_action=pass in: {out}"
    );
    assert!(out.contains("[out_v]"));
}

#[test]
fn cursor_overlay_accepts_png_sequence_directory() {
    let mut g = build_cursor_graph();
    if let Some(effects::ast::video::VideoNode::CursorOverlay { trajectory, .. }) = g
        .video
        .iter_mut()
        .find(|n| matches!(n, effects::ast::video::VideoNode::CursorOverlay { .. }))
    {
        trajectory.png_sequence_dir = PathBuf::from("/tmp/cursor-seq");
    }

    let out = FfmpegEmit::emit(&g);
    assert!(
        out.contains("/tmp/cursor-seq/frame_%05d.png"),
        "expected directory cursor ref to expand to frame pattern: {out}"
    );
}

#[test]
fn ripple_overlay_is_noop_passthrough() {
    // With 3 ripples, we still expect a `null` pass-through for the
    // RippleOverlay node (ripples are baked into the cursor PNG sequence).
    let g = build_cursor_graph();
    let out = FfmpegEmit::emit(&g);
    // Find the ripple node output label and verify a `null` filter sits on it.
    assert!(
        out.contains("null[v_"),
        "expected a null-passthrough segment for RippleOverlay: {out}"
    );
    // No drawbox primitives anymore (baked-into-PNG approach).
    assert!(
        !out.contains("drawbox"),
        "ripples should not emit drawbox anymore: {out}"
    );
}

#[test]
fn preview_plan_carries_cursor_and_ripples() {
    let g = build_cursor_graph();
    let plan = PreviewEmit::emit(&g);
    assert!(plan.cursor_atlas_ref.is_some());
    let tr = plan.cursor_atlas_ref.as_ref().unwrap();
    assert_eq!(tr.fps, 60);
    assert_eq!(tr.frame_count, 180);
    assert_eq!(plan.ripples.len(), 3);
    for (i, r) in plan.ripples.iter().enumerate() {
        assert_eq!(r.t_impact_ms, (i as u64 + 1) * 1000);
    }
}

#[test]
fn cursor_overlay_filter_complex_snapshot() {
    let g = build_cursor_graph();
    let out = FfmpegEmit::emit(&g);
    insta::with_settings!({
        snapshot_path => "fixtures",
        prepend_module_to_snapshot => false,
    }, {
        insta::assert_snapshot!("cursor_overlay.filter_complex", out);
    });
}
