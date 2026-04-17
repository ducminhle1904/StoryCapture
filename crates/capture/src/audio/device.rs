//! cpal input device enumeration (Phase 6 plan 01).
//!
//! **Laziness:** enumeration is triggered only when the user opens the
//! audio-device picker in the recorder. Calling `default_input_device()`
//! eagerly at app launch triggers the macOS Microphone TCC prompt
//! (cpal#901) — we resolve the default by name-matching AFTER iterating
//! so no unnecessary default-device resolution happens on cold launch.

use cpal::traits::{DeviceTrait, HostTrait};
use serde::{Deserialize, Serialize};

use super::error::AudioError;

/// Serializable DTO for the audio-device picker. `id` doubles as the
/// selection key — cpal device names are stable enough for session
/// lifetime (they change on physical re-plug, which forces re-listing
/// anyway).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioInputInfo {
    pub id: String,
    pub name: String,
    pub is_default: bool,
    pub channels: u16,
    pub sample_rate_hz: u32,
}

/// Enumerate input devices. Returns Ok(Vec) even when zero devices are
/// present; callers should interpret an empty Vec as "no mic available"
/// and surface a helpful UI message instead of an error.
pub fn list_inputs() -> Result<Vec<AudioInputInfo>, AudioError> {
    let host = cpal::default_host();
    // Resolve default-device NAME only — do not query further properties
    // (those touch mic on macOS per cpal#901).
    let default_name = host
        .default_input_device()
        .and_then(|d| d.name().ok());

    let devices = host
        .input_devices()
        .map_err(|e| AudioError::Cpal(format!("input_devices: {e}")))?;

    let mut out = Vec::new();
    for dev in devices {
        let name = match dev.name() {
            Ok(n) => n,
            Err(_) => continue,
        };
        // default_input_config may fail on e.g. disconnected or busy
        // devices; skip silently rather than failing the whole listing.
        let cfg = match dev.default_input_config() {
            Ok(c) => c,
            Err(_) => continue,
        };
        out.push(AudioInputInfo {
            id: name.clone(),
            is_default: default_name.as_deref() == Some(&name),
            name,
            channels: cfg.channels(),
            sample_rate_hz: cfg.sample_rate(),
        });
    }
    Ok(out)
}
