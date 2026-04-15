//! Per-step click SFX + transition whoosh splicing.
//!
//! For each click / whoosh event at time `t_ms`, we load the SFX file as an
//! extra FFmpeg input, pre-scale its volume by the user's preset gain, delay
//! it to `t_ms` via `adelay=t|t` (one value per stereo channel, Research §6),
//! and merge all delayed segments with `amix=duration=longest:normalize=0`
//! (Pitfall #9: per-input pre-scaling + `normalize=0` prevents `avg` muffling
//! and inter-peak clipping).

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::mixer::{ExtraInput, InputKind};

/// User-selectable click-SFX preset (D-22).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ClickSfxLevel {
    /// No click SFX rendered at all.
    Off,
    /// Quiet click (gain 0.3).
    Subtle,
    /// Pronounced click (gain 0.7).
    Pronounced,
}

/// Linear gain for a preset. Values chosen by D-22:
/// `Off = 0.0`, `Subtle = 0.3`, `Pronounced = 0.7`.
pub fn click_gain(level: ClickSfxLevel) -> f32 {
    match level {
        ClickSfxLevel::Off => 0.0,
        ClickSfxLevel::Subtle => 0.3,
        ClickSfxLevel::Pronounced => 0.7,
    }
}

/// A single click event spliced at `t_ms` from the DSL step timeline.
#[derive(Debug, Clone, PartialEq)]
pub struct ClickEvent {
    /// Timestamp (ms) relative to the start of the output video.
    pub t_ms: u64,
    /// SFX filename relative to `{sound_root}/sfx/` (e.g. `"click.wav"`).
    pub sfx_file: String,
}

/// Transition whoosh event — spliced at scene boundaries (Plan 10).
/// Uses the same adelay+amix pipeline as clicks but with a different
/// default gain source (hard-coded 0.6 for now; tunable via future preset).
#[derive(Debug, Clone, PartialEq)]
pub struct WhooshEvent {
    pub t_ms: u64,
    pub sfx_file: String,
}

/// Result of splicing click (+ whoosh) events.
///
/// `filter_fragment` is a `;`-joined sequence of `adelay` segments plus a
/// terminal `amix[sfx_mix]` node. Empty when no events or level=Off.
///
/// `extra_inputs` lists the SFX audio files to append to the ffmpeg `-i` list,
/// starting at input index `input_index_start` supplied by the caller.
pub struct ClickSfxEmit {
    pub filter_fragment: String,
    pub extra_inputs: Vec<ExtraInput>,
    /// The label of the final `[sfx_mix]` output, or `None` when nothing was
    /// emitted.
    pub out_label: Option<String>,
}

/// Build per-event `adelay` segments and a terminal `amix` into `[sfx_mix]`.
///
/// - `events` are the click events (already ordered, but ordering doesn't
///   matter here — `adelay` pushes each to its own t_ms).
/// - `level` scales every SFX by `click_gain(level)`.
/// - `sound_root` is the bundled-library root (e.g. `assets/sound-library`).
/// - `input_index_start` is the first FFmpeg `-i` index assigned to SFX.
///
/// Per-SFX filter form (Research §6 + Pitfall #9):
/// ```text
/// [{idx}:a]volume={g},adelay={t}|{t}[sfx_{i}];
/// ...
/// [sfx_0][sfx_1]...amix=inputs=N:duration=longest:normalize=0[sfx_mix]
/// ```
pub fn emit_click_sfx(
    events: &[ClickEvent],
    level: ClickSfxLevel,
    sound_root: &Path,
    input_index_start: usize,
) -> ClickSfxEmit {
    if matches!(level, ClickSfxLevel::Off) || events.is_empty() {
        return ClickSfxEmit {
            filter_fragment: String::new(),
            extra_inputs: Vec::new(),
            out_label: None,
        };
    }

    let gain = click_gain(level);
    let mut extra_inputs: Vec<ExtraInput> = Vec::with_capacity(events.len());
    let mut segments: Vec<String> = Vec::with_capacity(events.len());
    let mut labels: Vec<String> = Vec::with_capacity(events.len());

    for (i, ev) in events.iter().enumerate() {
        let idx = input_index_start + i;
        let path: PathBuf = sound_root.join("sfx").join(&ev.sfx_file);
        extra_inputs.push(ExtraInput {
            path,
            kind: InputKind::AudioFile,
            stream_loop: false,
        });

        let seg_label = format!("[sfx_{}]", i);
        // `volume=` applied BEFORE adelay so the silence padded in front is
        // zero-filled (volume on padding has no effect but kept at the start
        // for chain ordering clarity).
        segments.push(format!(
            "[{idx}:a]volume={gain:.3},adelay={t}|{t}{seg}",
            idx = idx,
            gain = gain,
            t = ev.t_ms,
            seg = seg_label,
        ));
        labels.push(seg_label);
    }

    let merge_inputs: String = labels.join("");
    let merge = format!(
        "{inputs}amix=inputs={n}:duration=longest:normalize=0[sfx_mix]",
        inputs = merge_inputs,
        n = labels.len(),
    );

    let mut fragment = segments.join(";");
    fragment.push(';');
    fragment.push_str(&merge);

    ClickSfxEmit {
        filter_fragment: fragment,
        extra_inputs,
        out_label: Some("[sfx_mix]".to_string()),
    }
}
