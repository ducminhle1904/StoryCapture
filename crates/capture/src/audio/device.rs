//! cpal input device enumeration (Phase 6 plan 01).
//!
//! **Laziness:** enumeration is triggered only when the user opens the
//! audio-device picker in the recorder. Calling `default_input_device()`
//! eagerly at app launch triggers the macOS Microphone TCC prompt
//! (cpal#901) — we resolve the default by name-matching AFTER iterating
//! so no unnecessary default-device resolution happens on cold launch.

use cpal::traits::{DeviceTrait, HostTrait};
use cpal::{Device, DeviceId};
use serde::{Deserialize, Serialize};

use super::error::AudioError;

/// Serializable DTO for the audio-device picker. `id` doubles as the
/// selection key and uses cpal's stable host/device identifier. `name`
/// remains the user-facing label in the picker.
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
    // Resolve the default-device ID only — do not query further
    // properties (those touch mic on macOS per cpal#901).
    let default_id = host
        .default_input_device()
        .and_then(|d| d.id().ok())
        .map(|id| id.to_string());

    let devices = host
        .input_devices()
        .map_err(|e| AudioError::Cpal(format!("input_devices: {e}")))?;

    let mut out = Vec::new();
    for dev in devices {
        let id = match dev.id() {
            Ok(id) => id.to_string(),
            Err(_) => continue,
        };
        let description = match dev.description() {
            Ok(desc) => desc,
            Err(_) => continue,
        };
        let name = description.name().to_string();
        // default_input_config may fail on e.g. disconnected or busy
        // devices; skip silently rather than failing the whole listing.
        let cfg = match dev.default_input_config() {
            Ok(c) => c,
            Err(_) => continue,
        };
        out.push(AudioInputInfo {
            id: id.clone(),
            is_default: default_id.as_deref() == Some(id.as_str()),
            name,
            channels: cfg.channels(),
            sample_rate_hz: cfg.sample_rate(),
        });
    }
    Ok(out)
}

pub(crate) fn resolve_input_device(
    host: &cpal::Host,
    device_id: Option<&str>,
) -> Result<Device, AudioError> {
    match device_id {
        None | Some("") | Some("default") => host
            .default_input_device()
            .ok_or(AudioError::NoDefaultInput),
        Some(id) => resolve_explicit_input_device(host, id),
    }
}

fn resolve_explicit_input_device(host: &cpal::Host, device_id: &str) -> Result<Device, AudioError> {
    if let Ok(parsed) = device_id.parse::<DeviceId>() {
        if let Some(device) = host.device_by_id(&parsed) {
            return Ok(device);
        }
    }

    // Backward-compatible fallback for pre-id sessions that persisted the
    // human-readable device name instead of cpal's stable DeviceId.
    for device in host
        .input_devices()
        .map_err(|e| AudioError::Cpal(e.to_string()))?
    {
        let name = match device.description() {
            Ok(description) => description.name().to_string(),
            Err(_) => continue,
        };
        if name == device_id {
            return Ok(device);
        }
    }

    Err(AudioError::DeviceNotFound(device_id.to_string()))
}
