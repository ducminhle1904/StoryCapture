//! BGM level + loop helpers.
//!
//! Keeps the filter-graph shape trivial (`volume=` per input); the `loop`
//! behaviour is set on the input side of FFmpeg (`-stream_loop -1`) via
//! [`ExtraInput::stream_loop`]. The render pipeline is responsible for
//! emitting that CLI flag.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::mixer::{ExtraInput, InputKind};

/// BGM track + pre-duck level.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BgmParams {
    /// Filename relative to `{sound_root}/bgm/` (e.g. `"lofi-loop.ogg"`).
    pub file: String,
    /// Linear pre-duck gain 0.0..=1.0. The sidechaincompress ducker later
    /// pulls this down by `DEFAULT_DUCK.duck_db` when voiceover is present.
    pub pre_duck_volume: f32,
    /// When true the renderer pads the input with `-stream_loop -1` so the
    /// BGM repeats for the full video duration (the renderer clamps with `-t`).
    pub loop_enabled: bool,
}

/// Emit the BGM volume filter segment.
///
/// Returns a fragment like `[{idx}:a]volume=0.450[bgm_scaled]` and the
/// corresponding `ExtraInput` describing the audio file to append to the
/// ffmpeg `-i` list.
pub fn emit_bgm_chain(
    p: &BgmParams,
    sound_root: &Path,
    input_index: usize,
) -> (String, ExtraInput) {
    let path: PathBuf = sound_root.join("bgm").join(&p.file);
    let extra = ExtraInput {
        path,
        kind: InputKind::AudioFile,
        stream_loop: p.loop_enabled,
    };
    let filter = format!(
        "[{idx}:a]volume={vol:.3}[bgm_scaled]",
        idx = input_index,
        vol = p.pre_duck_volume,
    );
    (filter, extra)
}
