// Audio IPC (Phase 6 plan 01).
//
// Thin Tauri-side wrapper around `capture::audio::list_inputs()`.
// Intentionally MINIMAL: this command must NOT eagerly resolve
// `default_input_device()` at any stage outside `list_inputs`, because
// macOS CoreAudio touches the mic hardware on that call — which triggers
// the Microphone TCC prompt before the user has opted in (cpal#901 /
// RESEARCH Pitfall 3).
//
// Device enumeration is triggered by the React AudioDevicePicker
// component when the picker opens, not at app launch.

use crate::error::AppError;
use capture::audio::{list_inputs, AudioInputInfo};
use serde::{Deserialize, Serialize};

/// Serializable DTO for the audio-device picker. Mirrors
/// `capture::audio::AudioInputInfo` but lives in the host crate so
/// specta can derive TS bindings without reaching into `capture`.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct AudioInputInfoDto {
    pub id: String,
    pub name: String,
    pub is_default: bool,
    pub channels: u16,
    pub sample_rate_hz: u32,
}

impl From<AudioInputInfo> for AudioInputInfoDto {
    fn from(i: AudioInputInfo) -> Self {
        AudioInputInfoDto {
            id: i.id,
            name: i.name,
            is_default: i.is_default,
            channels: i.channels,
            sample_rate_hz: i.sample_rate_hz,
        }
    }
}

/// Enumerate audio input devices. Lazy: does NOT run at app launch,
/// fires only when the AudioDevicePicker opens (first-open only; the
/// React query caches the result for the session).
#[tauri::command]
#[specta::specta]
#[tracing::instrument(level = "info", skip_all, fields(cmd = "list_audio_inputs"), err(Debug))]
pub async fn list_audio_inputs() -> Result<Vec<AudioInputInfoDto>, AppError> {
    // Run on a blocking thread — cpal's enumeration dispatches through
    // CoreAudio / WASAPI FFI which can block on slow drivers.
    tokio::task::spawn_blocking(|| list_inputs())
        .await
        .map_err(|e| AppError::Capture(format!("audio enumeration join: {e}")))?
        .map(|v| v.into_iter().map(AudioInputInfoDto::from).collect())
        .map_err(|e| AppError::Capture(e.to_string()))
}
