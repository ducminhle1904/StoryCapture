//! insta golden: audio-only graph (2 AudioSource + Volume + Sidechain +
//! Amix + Alimiter). Pins the audio chain shape ahead of sound-library
//! lookup wiring onto these nodes.

use std::path::PathBuf;

use effects::ast::audio::SidechainParams;
use effects::ast::types::NodeId;
use effects::{FfmpegEmit, GraphBuilder};

fn fixed_id(b: u8) -> NodeId {
    NodeId::from_bytes([b; 16])
}

#[test]
fn audio_mix_filter_complex_snapshot() {
    let g = GraphBuilder::new(1920, 1080, 60)
        .audio_source(fixed_id(0xA1), PathBuf::from("bgm.mp3"), 0)
        .audio_source(fixed_id(0xA2), PathBuf::from("sfx.wav"), 500)
        .audio_volume(fixed_id(0xA3), "a_a1a1", 0.4)
        .audio_sidechain(
            fixed_id(0xA4),
            "a_a3a3",
            "a_a2a2",
            SidechainParams::default(),
        )
        .audio_mix(
            fixed_id(0xA5),
            vec!["a_a4a4".into(), "a_a2a2".into()],
            false,
        )
        .audio_limiter(fixed_id(0xA6), "a_a5a5", 0.97)
        .build()
        .expect("audio-only graph is valid (video chain empty)");

    let out = FfmpegEmit::emit(&g);
    assert!(out.contains("sidechaincompress"));
    assert!(out.contains("amix=inputs=2"));
    assert!(out.contains("alimiter"));
    assert!(out.contains("[out_a]"));

    insta::with_settings!({
        snapshot_path => "fixtures",
        prepend_module_to_snapshot => false,
    }, {
        insta::assert_snapshot!("audio_mix.filter_complex", out);
    });
}
