//! Tests for the POST-06 audio mixer (Plan 02-08 Task 1).
//!
//! Covers D-22 duck params, click-level gains, presence/absence of
//! `sidechaincompress`, per-event `adelay`, `alimiter` safety stage,
//! `normalize=0` and the full-mix snapshot.

use std::path::{Path, PathBuf};

use effects::audio::{
    click_gain, emit_audio_mix, AudioMixConfig, BgmParams, ClickEvent, ClickSfxLevel, DuckParams,
    WhooshEvent, DEFAULT_DUCK,
};

fn sound_root() -> PathBuf {
    // All tests use the in-repo bundled sound-library root (paths only — no
    // files are opened by the emitter).
    PathBuf::from("assets/sound-library")
}

#[test]
fn default_duck_params_exact() {
    assert_eq!(DEFAULT_DUCK.threshold, 0.08_f32, "D-22 threshold");
    assert_eq!(DEFAULT_DUCK.ratio, 8.0_f32, "D-22 ratio");
    assert_eq!(DEFAULT_DUCK.attack_ms, 80, "D-22 attack_ms");
    assert_eq!(DEFAULT_DUCK.release_ms, 400, "D-22 release_ms");
    assert_eq!(DEFAULT_DUCK.duck_db, -12.0_f32, "D-22 duck_db");
}

#[test]
fn click_level_gains() {
    assert_eq!(click_gain(ClickSfxLevel::Off), 0.0);
    assert_eq!(click_gain(ClickSfxLevel::Subtle), 0.3);
    assert_eq!(click_gain(ClickSfxLevel::Pronounced), 0.7);
}

#[test]
fn emit_ducking_no_voiceover() {
    let cfg = AudioMixConfig {
        main_audio: Some(PathBuf::from("/tmp/main.wav")),
        bgm: Some(BgmParams {
            file: "lofi-loop.ogg".into(),
            pre_duck_volume: 0.5,
            loop_enabled: true,
        }),
        voiceover_slot: None,
        ..Default::default()
    };
    let out = emit_audio_mix(&cfg, &sound_root()).expect("mix emit");
    assert!(
        !out.filter_complex_tail.contains("sidechaincompress"),
        "no sidechain when voiceover absent; got: {}",
        out.filter_complex_tail
    );
    // BGM level still pre-scaled.
    assert!(out.filter_complex_tail.contains("volume=0.500"));
}

#[test]
fn emit_ducking_with_voiceover() {
    let cfg = AudioMixConfig {
        main_audio: Some(PathBuf::from("/tmp/main.wav")),
        bgm: Some(BgmParams {
            file: "lofi-loop.ogg".into(),
            pre_duck_volume: 0.5,
            loop_enabled: true,
        }),
        voiceover_slot: Some(PathBuf::from("/tmp/vo.wav")),
        ..Default::default()
    };
    let out = emit_audio_mix(&cfg, &sound_root()).expect("mix emit");
    assert!(
        out.filter_complex_tail
            .contains("sidechaincompress=threshold=0.08:ratio=8:attack=80:release=400"),
        "D-22 sidechaincompress fragment absent; got: {}",
        out.filter_complex_tail
    );
    // And it must thread `[bgm_ducked]` into the final amix.
    assert!(out.filter_complex_tail.contains("[bgm_ducked]"));
}

#[test]
fn click_adelay_per_event() {
    let cfg = AudioMixConfig {
        main_audio: Some(PathBuf::from("/tmp/main.wav")),
        click_events: vec![
            ClickEvent {
                t_ms: 1000,
                sfx_file: "click.wav".into(),
            },
            ClickEvent {
                t_ms: 2000,
                sfx_file: "click.wav".into(),
            },
            ClickEvent {
                t_ms: 3000,
                sfx_file: "click.wav".into(),
            },
        ],
        click_level: ClickSfxLevel::Subtle,
        ..Default::default()
    };
    let out = emit_audio_mix(&cfg, &sound_root()).expect("mix emit");
    assert!(out.filter_complex_tail.contains("adelay=1000|1000"));
    assert!(out.filter_complex_tail.contains("adelay=2000|2000"));
    assert!(out.filter_complex_tail.contains("adelay=3000|3000"));
    // One extra input per event.
    assert_eq!(out.extra_inputs.len(), 3);
}

#[test]
fn click_level_off_emits_no_sfx() {
    let cfg = AudioMixConfig {
        main_audio: Some(PathBuf::from("/tmp/main.wav")),
        click_events: vec![ClickEvent {
            t_ms: 500,
            sfx_file: "click.wav".into(),
        }],
        click_level: ClickSfxLevel::Off,
        ..Default::default()
    };
    let out = emit_audio_mix(&cfg, &sound_root()).expect("mix emit");
    assert!(!out.filter_complex_tail.contains("adelay"));
    assert!(!out.filter_complex_tail.contains("[sfx_mix]"));
    assert!(out.extra_inputs.is_empty());
}

#[test]
fn transition_whooshes_also_spliced() {
    let cfg = AudioMixConfig {
        main_audio: Some(PathBuf::from("/tmp/main.wav")),
        transition_whooshes: vec![WhooshEvent {
            t_ms: 5000,
            sfx_file: "transition-whoosh-1.wav".into(),
        }],
        click_level: ClickSfxLevel::Pronounced,
        ..Default::default()
    };
    let out = emit_audio_mix(&cfg, &sound_root()).expect("mix emit");
    assert!(out.filter_complex_tail.contains("adelay=5000|5000"));
    assert!(out.filter_complex_tail.contains("[sfx_mix]"));
}

#[test]
fn alimiter_final_stage() {
    let cfg = AudioMixConfig {
        main_audio: Some(PathBuf::from("/tmp/main.wav")),
        ..Default::default()
    };
    let out = emit_audio_mix(&cfg, &sound_root()).expect("mix emit");
    assert!(
        out.filter_complex_tail.contains("alimiter=limit=0.95"),
        "Pitfall #9 safety limiter missing"
    );
    assert!(out.filter_complex_tail.ends_with("[aout]"));
}

#[test]
fn normalize_zero_set() {
    let cfg = AudioMixConfig {
        main_audio: Some(PathBuf::from("/tmp/main.wav")),
        bgm: Some(BgmParams {
            file: "lofi-loop.ogg".into(),
            pre_duck_volume: 0.4,
            loop_enabled: true,
        }),
        ..Default::default()
    };
    let out = emit_audio_mix(&cfg, &sound_root()).expect("mix emit");
    // Final amix normalize flag.
    assert!(
        out.filter_complex_tail
            .contains("amix=inputs=2:duration=longest:normalize=0"),
        "final amix must set normalize=0; got: {}",
        out.filter_complex_tail
    );
}

#[test]
fn custom_duck_params_still_render_threshold_and_ratio() {
    // Guardrail: even if a caller passes a custom DuckParams, the fragment
    // format must stay syntactically correct.
    use effects::audio::emit_ducking;
    let p = DuckParams {
        threshold: 0.1,
        ratio: 4.0,
        attack_ms: 50,
        release_ms: 200,
        duck_db: -10.0,
    };
    let s = emit_ducking(&p, "[a]", "[b]", "[c]");
    assert_eq!(
        s,
        "[a][b]sidechaincompress=threshold=0.1:ratio=4:attack=50:release=200[c]"
    );
}

#[test]
fn full_mix_snapshot() {
    // Full reference mix: main + BGM + 3 clicks + voiceover slot.
    let cfg = AudioMixConfig {
        main_audio: Some(PathBuf::from("/projects/demo/main.wav")),
        bgm: Some(BgmParams {
            file: "lofi-loop.ogg".into(),
            pre_duck_volume: 0.45,
            loop_enabled: true,
        }),
        click_events: vec![
            ClickEvent {
                t_ms: 1200,
                sfx_file: "click.wav".into(),
            },
            ClickEvent {
                t_ms: 2400,
                sfx_file: "click.wav".into(),
            },
            ClickEvent {
                t_ms: 3600,
                sfx_file: "click.wav".into(),
            },
        ],
        transition_whooshes: vec![],
        voiceover_slot: Some(PathBuf::from("/projects/demo/voiceover.wav")),
        click_level: ClickSfxLevel::Subtle,
        voiceover_gain: 1.0,
    };
    let out = emit_audio_mix(&cfg, Path::new("assets/sound-library")).expect("mix emit");

    insta::with_settings!({
        snapshot_path => "fixtures",
        prepend_module_to_snapshot => false,
        omit_expression => true,
    }, {
        insta::assert_snapshot!("audio_mixer.filter_complex", &out.filter_complex_tail);
    });

    // Cross-check counts: 1 BGM + 1 voiceover + 3 click SFX = 5 extra inputs.
    assert_eq!(out.extra_inputs.len(), 5);
}
