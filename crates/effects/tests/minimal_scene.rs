//! insta golden: minimal scene (Source + audio alimiter only). Pins the
//! shortest emittable filter_complex so downstream plans cannot accidentally
//! add noise to the base chain.

use std::path::PathBuf;

use effects::ast::types::NodeId;
use effects::{FfmpegEmit, GraphBuilder};

fn fixed_id(b: u8) -> NodeId {
    NodeId::from_bytes([b; 16])
}

#[test]
fn minimal_scene_filter_complex_snapshot() {
    let g = GraphBuilder::new(1920, 1080, 60)
        .source(fixed_id(0x01), PathBuf::from("in.mp4"), 0)
        .audio_source(fixed_id(0x02), PathBuf::from("in.mp4"), 0)
        .audio_limiter(fixed_id(0x03), "a_0202", 0.97)
        .build()
        .expect("build ok");

    let out = FfmpegEmit::emit(&g);

    insta::with_settings!({
        snapshot_path => "fixtures",
        prepend_module_to_snapshot => false,
    }, {
        insta::assert_snapshot!("minimal_scene.filter_complex", out);
    });
}

#[test]
fn minimal_scene_emission_is_deterministic() {
    let g = GraphBuilder::new(1920, 1080, 60)
        .source(fixed_id(0x01), PathBuf::from("in.mp4"), 0)
        .audio_source(fixed_id(0x02), PathBuf::from("in.mp4"), 0)
        .audio_limiter(fixed_id(0x03), "a_0202", 0.97)
        .build()
        .expect("build ok");

    let a = FfmpegEmit::emit(&g);
    let b = FfmpegEmit::emit(&g);
    assert_eq!(a, b, "emission must be deterministic");
}
