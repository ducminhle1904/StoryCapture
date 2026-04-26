//! Background compositor integration tests.
//!
//! Builds a Graph with a Background node covering:
//!   - gradient preset kind
//!   - 24 px rounded corners
//!   - drop shadow (32 px blur, (0, 8) offset, 50% black)
//!   - 64 px padding
//!
//! Then asserts the emitted filter_complex contains the expected tokens
//! (boxblur, geq rounded mask, gradient-presets PNG path) and locks the
//! byte-for-byte emission via an insta snapshot.

use std::path::PathBuf;

use effects::ast::types::{NodeId, Rgba, Vec2};
use effects::ast::video::{BackgroundKind, Shadow};
use effects::background::compositor::{emit_background, ExtraInput};
use effects::emit::ffmpeg::collect_extra_inputs;
use effects::{FfmpegEmit, GraphBuilder};

fn fid(b: u8) -> NodeId {
    NodeId::from_bytes([b; 16])
}

fn build_bg_graph() -> effects::Graph {
    let mut b = GraphBuilder::new(1920, 1080, 60);
    b.source(fid(0x11), PathBuf::from("in.mp4"), 0)
        .background_with_padding(
            fid(0x33),
            BackgroundKind::Gradient {
                preset_id: "runway-dark".into(),
            },
            24.0,
            Some(Shadow {
                blur_px: 32.0,
                offset: Vec2::new(0.0, 8.0),
                color: Rgba::new(0, 0, 0, 128),
            }),
            64,
        );
    b.build().expect("bg graph must build")
}

#[test]
fn background_emits_geq_rounded_mask() {
    let g = build_bg_graph();
    let out = FfmpegEmit::emit(&g);
    assert!(
        out.contains("geq=r='r(X,Y)'"),
        "expected rounded-corner geq mask: {out}"
    );
    // Radius 24 appears in the corner-distance test.
    assert!(out.contains("pow(24-X,2)"));
}

#[test]
fn background_emits_boxblur_shadow() {
    let g = build_bg_graph();
    let out = FfmpegEmit::emit(&g);
    assert!(
        out.contains("boxblur=32:1"),
        "expected 32-px boxblur: {out}"
    );
}

#[test]
fn background_extra_inputs_point_at_gradient_png() {
    let g = build_bg_graph();
    let inputs = collect_extra_inputs(&g);
    assert_eq!(inputs.len(), 1);
    let ExtraInput {
        uri,
        loop_single_frame,
        lavfi,
    } = &inputs[0];
    assert!(*loop_single_frame, "gradient PNG must loop as single frame");
    assert!(!*lavfi, "gradient is a real PNG input, not lavfi");
    assert!(
        uri.contains("gradient-presets") && uri.ends_with("runway-dark.png"),
        "expected gradient-presets/runway-dark.png, got: {uri}"
    );
}

#[test]
fn unknown_gradient_preset_errors() {
    let mut b = GraphBuilder::new(1920, 1080, 60);
    b.source(fid(0x11), PathBuf::from("in.mp4"), 0)
        .background_with_padding(
            fid(0x33),
            BackgroundKind::Gradient {
                preset_id: "does-not-exist".into(),
            },
            0.0,
            None,
            0,
        );
    let g = b
        .build()
        .expect("graph builds; preset validated at emit time");
    // emit_background surfaces UnknownGradient.
    let node = g
        .video
        .iter()
        .find(|n| matches!(n, effects::ast::video::VideoNode::Background { .. }))
        .unwrap();
    let err = emit_background(node, "[in]", "[out]", &g, 1).expect_err("should error");
    let msg = format!("{err}");
    assert!(
        msg.contains("does-not-exist"),
        "expected preset id in err: {msg}"
    );
}

#[test]
fn background_gradient_filter_complex_snapshot() {
    let g = build_bg_graph();
    let out = FfmpegEmit::emit(&g);
    insta::with_settings!({
        snapshot_path => "fixtures",
        prepend_module_to_snapshot => false,
    }, {
        insta::assert_snapshot!("background_gradient.filter_complex", out);
    });
}
