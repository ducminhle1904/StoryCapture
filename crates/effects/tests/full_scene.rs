//! insta golden: full scene with all canonical stages present. Pins the
//! canonical filter token order (Source → zoompan → bg overlay → cursor
//! overlay → ripple passthrough → drawtext → xfade) so optimisations in later
//! optimisations cannot silently reorder nodes.

use std::path::PathBuf;

use effects::ast::audio::SidechainParams;
use effects::ast::types::NodeId;
use effects::ast::video::{
    BackgroundKind, CursorSkin, FontChoice, RippleEvent, TextAnim, TextBox, TrajectoryRef,
    XfadeKind, ZoomKeyframe, ZoomTarget,
};
use effects::ast::{EasingKind, Rgba, Vec2};
use effects::{FfmpegEmit, GraphBuilder, PreviewEmit};

fn fixed_id(b: u8) -> NodeId {
    NodeId::from_bytes([b; 16])
}

fn build_full() -> effects::Graph {
    GraphBuilder::new(1920, 1080, 60)
        .source(fixed_id(0x11), PathBuf::from("in.mp4"), 0)
        .zoom_pan(
            fixed_id(0x22),
            ZoomTarget::Cursor,
            vec![
                ZoomKeyframe {
                    t_ms: 0,
                    center: Vec2::new(960.0, 540.0),
                    scale: 1.0,
                    easing: EasingKind::Linear,
                },
                ZoomKeyframe {
                    t_ms: 1000,
                    center: Vec2::new(1200.0, 600.0),
                    scale: 1.5,
                    easing: EasingKind::EaseInOut,
                },
            ],
        )
        .background(
            fixed_id(0x33),
            BackgroundKind::Solid {
                color: Rgba::new(10, 10, 16, 255),
            },
            24.0,
            None,
        )
        .cursor(
            fixed_id(0x44),
            CursorSkin::MacDefault,
            1.0,
            None,
            TrajectoryRef {
                png_sequence_dir: PathBuf::from("/tmp/cursor/%04d.png"),
                fps: 60,
                frame_count: 180,
            },
        )
        .ripple(
            fixed_id(0x55),
            vec![RippleEvent::at_impact(500, Vec2::new(960.0, 540.0))],
        )
        .text(
            fixed_id(0x66),
            vec![TextBox {
                t_start_ms: 200,
                t_end_ms: 1800,
                // Includes an apostrophe + colon to exercise drawtext escaping (T-02-02).
                text: "It's 3:14 — hello".into(),
                pos: Vec2::new(100.0, 100.0),
                font: FontChoice::SystemDefault,
                size_pt: 36.0,
                color: Rgba::WHITE,
                box_style: None,
                anim_in: TextAnim::Fade,
                anim_out: TextAnim::Fade,
            }],
        )
        .transition(fixed_id(0x77), XfadeKind::Fade, 500, 1500)
        .audio_source(fixed_id(0x81), PathBuf::from("bgm.mp3"), 0)
        .audio_source(fixed_id(0x82), PathBuf::from("sfx.wav"), 250)
        .audio_sidechain(
            fixed_id(0x83),
            "a_8181",
            "a_8282",
            SidechainParams::default(),
        )
        .audio_mix(
            fixed_id(0x84),
            vec!["a_8383".into(), "a_8282".into()],
            false,
        )
        .audio_limiter(fixed_id(0x85), "a_8484", 0.97)
        .build()
        .expect("full scene must satisfy canonical order")
}

#[test]
fn full_scene_filter_complex_snapshot() {
    let g = build_full();
    let out = FfmpegEmit::emit(&g);

    // Shape sanity checks (insta holds the byte-for-byte lock).
    assert!(out.contains("zoompan"), "expected zoompan token");
    assert!(out.contains("xfade=transition=fade"), "expected xfade");
    assert!(
        out.contains("sidechaincompress"),
        "expected sidechain audio"
    );
    assert!(out.contains("[out_v]") && out.contains("[out_a]"));

    insta::with_settings!({
        snapshot_path => "fixtures",
        prepend_module_to_snapshot => false,
    }, {
        insta::assert_snapshot!("full_scene.filter_complex", out);
    });
}

#[test]
fn full_scene_preview_plan_is_populated() {
    let g = build_full();
    let plan = PreviewEmit::emit(&g);
    assert_eq!(plan.output_width, 1920);
    assert_eq!(plan.output_height, 1080);
    assert_eq!(plan.fps, 60);
    // Per-frame sampler at output_fps. Two keyframes at t=0 and
    // t=1000 ms at 60fps → ~61 samples. Accept a small ceil/round tolerance.
    assert!(
        plan.zoom_matrices.len() >= 60 && plan.zoom_matrices.len() <= 62,
        "per-frame zoom matrices expected ~61 samples, got {}",
        plan.zoom_matrices.len()
    );
    assert!(plan.cursor_atlas_ref.is_some());
    assert_eq!(plan.ripples.len(), 1);
    assert_eq!(plan.text_boxes.len(), 1);
    assert!(plan.background.is_some());
}

#[test]
fn full_scene_emission_is_deterministic() {
    let g = build_full();
    let a = FfmpegEmit::emit(&g);
    let b = FfmpegEmit::emit(&g);
    assert_eq!(a, b);
}

#[test]
fn full_scene_drawtext_escapes_colon_and_apostrophe() {
    let g = build_full();
    let out = FfmpegEmit::emit(&g);
    // `:` must be escaped as `\:` and `'` as `\'` (T-02-02).
    assert!(
        out.contains("3\\:14"),
        "colon must be escaped in drawtext: {out}"
    );
    assert!(out.contains("It\\'s"), "apostrophe must be escaped: {out}");
}
