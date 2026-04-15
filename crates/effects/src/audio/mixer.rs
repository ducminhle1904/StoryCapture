//! Top-level audio mixer: wires main audio + BGM + ducking + SFX + voiceover
//! slot through `amix` + `alimiter` (Research §6 Code Example 7).
//!
//! Shape of the emitted graph (all parts optional except the final amix +
//! alimiter):
//!
//! ```text
//!   [0:a]anull[main];                    // main captured audio
//!   [N:a]volume=0.5[bgm_scaled];         // BGM pre-duck
//!   [bgm_scaled][vo]sidechaincompress=...[bgm_ducked];  // D-22 duck
//!   [K:a]volume=0.3,adelay=1000|1000[sfx_0]; ...
//!   [sfx_0][sfx_1]...amix=inputs=N:duration=longest:normalize=0[sfx_mix];
//!   [main][bgm_ducked][sfx_mix][vo]amix=inputs=4:duration=longest:normalize=0[mixed];
//!   [mixed]alimiter=limit=0.95[aout]
//! ```
//!
//! Callers receive:
//!   - `filter_complex_tail` — the audio portion to append to the full filter_complex.
//!   - `extra_inputs`        — every extra `-i` file to prepend (in order).
//!
//! Pitfall #9 compliance:
//!   1. Each BGM / SFX / voiceover input is pre-scaled with `volume=` before amix.
//!   2. Final amix uses `normalize=0`.
//!   3. Final stage is `alimiter=limit=0.95` so inter-peak clipping cannot ship.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::bgm::{emit_bgm_chain, BgmParams};
use super::click_sfx::{emit_click_sfx, ClickEvent, ClickSfxLevel, WhooshEvent};
use super::ducking::{emit_ducking, DEFAULT_DUCK};
use crate::error::EffectsError;

/// Kind of FFmpeg input (affects which `-i` flags the renderer emits).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum InputKind {
    AudioFile,
    VideoFile,
}

/// An additional `-i` input needed by the audio graph.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ExtraInput {
    pub path: PathBuf,
    pub kind: InputKind,
    /// When true, Plan 11 (render pipeline) must prepend `-stream_loop -1`
    /// before the `-i` flag so this input loops for the full output duration.
    pub stream_loop: bool,
}

impl ExtraInput {
    /// Convenience: `ExtraInput` for a bundled audio file (no loop).
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
    /// Path to the Phase-1 captured audio track (container index `[0:a]`).
    /// `None` → substitute `anullsrc`.
    pub main_audio: Option<PathBuf>,
    /// Optional BGM track + level.
    pub bgm: Option<BgmParams>,
    /// Click events derived from the DSL step timeline.
    pub click_events: Vec<ClickEvent>,
    /// Transition whooshes (scene boundaries, Plan 10).
    pub transition_whooshes: Vec<WhooshEvent>,
    /// Voiceover audio file. `None` in Phase 2 (Plan 02-08); Phase 3 TTS fills.
    /// When present the sidechaincompress duck is activated.
    pub voiceover_slot: Option<PathBuf>,
    /// User-selectable click-level preset (D-22).
    pub click_level: ClickSfxLevel,
    /// Pre-amix voiceover gain (applied before amix); 1.0 passes through.
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
    /// The full audio portion of the `filter_complex` expression.
    /// Caller appends (with a leading `;`) after the video chain.
    pub filter_complex_tail: String,
    /// Extra `-i` inputs to prepend to the ffmpeg CLI (in order).
    pub extra_inputs: Vec<ExtraInput>,
}

/// Emit the final audio mix graph.
///
/// Input index allocation (assumes video input is `[0:v]`):
///   - `[0:a]` is the captured main audio (if `main_audio` is Some).
///   - The next indices are allocated in this order:
///     `bgm → voiceover → click SFX → transition whooshes`.
pub fn emit_audio_mix(
    cfg: &AudioMixConfig,
    sound_root: &Path,
) -> Result<AudioMixOutput, EffectsError> {
    let mut chain = String::new();
    let mut extra: Vec<ExtraInput> = Vec::new();
    // Main audio occupies `[0:a]` unless missing.
    let mut next_input_idx: usize = 1;

    // ---------- 1. Main captured audio ----------
    let main_label = if cfg.main_audio.is_some() {
        "[main]".to_string()
    } else {
        "[silent]".to_string()
    };
    if let Some(_main) = &cfg.main_audio {
        // Null-filter rename so everything downstream references a stable label.
        chain.push_str("[0:a]anull[main]");
    } else {
        chain.push_str("anullsrc=channel_layout=stereo:sample_rate=48000[silent]");
    }

    // ---------- 2. BGM ----------
    let mut bgm_pre_duck_label: Option<String> = None;
    if let Some(bgm) = &cfg.bgm {
        let (frag, input) = emit_bgm_chain(bgm, sound_root, next_input_idx);
        next_input_idx += 1;
        extra.push(input);
        chain.push(';');
        chain.push_str(&frag);
        bgm_pre_duck_label = Some("[bgm_scaled]".to_string());
    }

    // ---------- 3. Voiceover slot + pre-scale ----------
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

    // ---------- 4. Duck BGM under voiceover (D-22) ----------
    let bgm_final_label = match (bgm_pre_duck_label.as_ref(), vo_label.as_ref()) {
        (Some(bgm), Some(vo)) => {
            chain.push(';');
            chain.push_str(&emit_ducking(&DEFAULT_DUCK, bgm, vo, "[bgm_ducked]"));
            Some("[bgm_ducked]".to_string())
        }
        (Some(_), None) => bgm_pre_duck_label.clone(),
        _ => None,
    };

    // ---------- 5. Click SFX + transition whooshes ----------
    // Transition whooshes share the same splicing machinery (adelay+amix);
    // convert them into ClickEvent form so we can reuse the emitter.
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

    // ---------- 6. Final amix ----------
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

    // ---------- 7. Final safety limiter ----------
    chain.push(';');
    chain.push_str("[mixed]alimiter=limit=0.95[aout]");

    // Suppress unused warning in the silent branch (next_input_idx tracked for future use).
    let _ = next_input_idx;

    Ok(AudioMixOutput {
        filter_complex_tail: chain,
        extra_inputs: extra,
    })
}
