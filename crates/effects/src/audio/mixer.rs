//! Top-level audio mixer for main audio, BGM, SFX, and voiceover.
//!
//! Returns the audio filter tail plus any extra FFmpeg inputs.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::bgm::{emit_bgm_chain, BgmParams};
use super::click_sfx::{emit_click_sfx, ClickEvent, ClickSfxLevel, WhooshEvent};
use super::ducking::{emit_ducking, DEFAULT_DUCK};
use crate::error::EffectsError;

/// Kind of FFmpeg input.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum InputKind {
    AudioFile,
    VideoFile,
}

/// An additional `-i` input for the audio graph.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ExtraInput {
    pub path: PathBuf,
    pub kind: InputKind,
    /// Prepend `-stream_loop -1` before the input.
    pub stream_loop: bool,
}

impl ExtraInput {
    /// `ExtraInput` for a bundled audio file.
    pub fn audio_file(path: impl Into<PathBuf>) -> Self {
        Self {
            path: path.into(),
            kind: InputKind::AudioFile,
            stream_loop: false,
        }
    }
}

/// Top-level config for [`emit_audio_mix`].
#[derive(Debug, Clone, PartialEq)]
pub struct AudioMixConfig {
    /// Captured main audio track, or `None` for `anullsrc`.
    pub main_audio: Option<PathBuf>,
    /// Optional BGM track and level.
    pub bgm: Option<BgmParams>,
    /// Click events from the DSL timeline.
    pub click_events: Vec<ClickEvent>,
    /// Transition whooshes.
    pub transition_whooshes: Vec<WhooshEvent>,
    /// Optional voiceover audio file.
    pub voiceover_slot: Option<PathBuf>,
    /// Click-level preset.
    pub click_level: ClickSfxLevel,
    /// Voiceover gain before amix.
    pub voiceover_gain: f32,
}

impl Default for AudioMixConfig {
    fn default() -> Self {
        Self {
            main_audio: None,
            bgm: None,
            click_events: Vec::new(),
            transition_whooshes: Vec::new(),
            voiceover_slot: None,
            click_level: ClickSfxLevel::Subtle,
            voiceover_gain: 1.0,
        }
    }
}

/// Output of [`emit_audio_mix`].
#[derive(Debug, Clone, PartialEq)]
pub struct AudioMixOutput {
    /// Audio portion of the `filter_complex` expression.
    pub filter_complex_tail: String,
    /// Extra `-i` inputs for the FFmpeg CLI.
    pub extra_inputs: Vec<ExtraInput>,
}

/// Emit the final audio mix graph.
pub fn emit_audio_mix(
    cfg: &AudioMixConfig,
    sound_root: &Path,
) -> Result<AudioMixOutput, EffectsError> {
    let mut chain = String::new();
    let mut extra: Vec<ExtraInput> = Vec::new();
    // Main audio occupies `[0:a]` unless missing.
    let mut next_input_idx: usize = 1;

    // Main captured audio.
    let main_label = if cfg.main_audio.is_some() {
        "[main]".to_string()
    } else {
        "[silent]".to_string()
    };
    if let Some(_main) = &cfg.main_audio {
        // Rename so downstream filters use a stable label.
        chain.push_str("[0:a]anull[main]");
    } else {
        chain.push_str("anullsrc=channel_layout=stereo:sample_rate=48000[silent]");
    }

    // BGM.
    let mut bgm_pre_duck_label: Option<String> = None;
    if let Some(bgm) = &cfg.bgm {
        let (frag, input) = emit_bgm_chain(bgm, sound_root, next_input_idx);
        next_input_idx += 1;
        extra.push(input);
        chain.push(';');
        chain.push_str(&frag);
        bgm_pre_duck_label = Some("[bgm_scaled]".to_string());
    }

    // Voiceover slot + pre-scale.
    let mut vo_label: Option<String> = None;
    if let Some(vo_path) = &cfg.voiceover_slot {
        let vo_idx = next_input_idx;
        next_input_idx += 1;
        extra.push(ExtraInput {
            path: vo_path.clone(),
            kind: InputKind::AudioFile,
            stream_loop: false,
        });
        chain.push(';');
        chain.push_str(&format!(
            "[{idx}:a]volume={g:.3}[vo]",
            idx = vo_idx,
            g = cfg.voiceover_gain,
        ));
        vo_label = Some("[vo]".to_string());
    }

    // Duck BGM under voiceover.
    let bgm_final_label = match (bgm_pre_duck_label.as_ref(), vo_label.as_ref()) {
        (Some(bgm), Some(vo)) => {
            chain.push(';');
            chain.push_str(&emit_ducking(&DEFAULT_DUCK, bgm, vo, "[bgm_ducked]"));
            Some("[bgm_ducked]".to_string())
        }
        (Some(_), None) => bgm_pre_duck_label.clone(),
        _ => None,
    };

    // Click SFX and transition whooshes.
    let mut all_events: Vec<ClickEvent> = cfg.click_events.clone();
    for w in &cfg.transition_whooshes {
        all_events.push(ClickEvent {
            t_ms: w.t_ms,
            sfx_file: w.sfx_file.clone(),
        });
    }
    let sfx_emit = emit_click_sfx(
        &all_events,
        cfg.click_level,
        sound_root,
        next_input_idx,
    );
    next_input_idx += sfx_emit.extra_inputs.len();
    extra.extend(sfx_emit.extra_inputs);
    let sfx_label = sfx_emit.out_label.clone();
    if !sfx_emit.filter_fragment.is_empty() {
        chain.push(';');
        chain.push_str(&sfx_emit.filter_fragment);
    }

    // Final amix.
    let mut amix_inputs: Vec<String> = vec![main_label.clone()];
    if let Some(bgm) = &bgm_final_label {
        amix_inputs.push(bgm.clone());
    }
    if let Some(sfx) = &sfx_label {
        amix_inputs.push(sfx.clone());
    }
    if let Some(vo) = &vo_label {
        amix_inputs.push(vo.clone());
    }
    let joined: String = amix_inputs.join("");
    chain.push(';');
    chain.push_str(&format!(
        "{inputs}amix=inputs={n}:duration=longest:normalize=0[mixed]",
        inputs = joined,
        n = amix_inputs.len(),
    ));

    // Final safety limiter.
    chain.push(';');
    chain.push_str("[mixed]alimiter=limit=0.95[aout]");

    // Suppress the unused warning in the silent branch.
    let _ = next_input_idx;

    Ok(AudioMixOutput {
        filter_complex_tail: chain,
        extra_inputs: extra,
    })
}
