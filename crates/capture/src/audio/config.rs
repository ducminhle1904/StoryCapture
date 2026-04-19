//! Audio input negotiation for capture startup.

use cpal::traits::DeviceTrait;
use cpal::{Device, SampleFormat, StreamConfig};

use super::device::resolve_input_device;
use super::error::AudioError;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AudioStreamInfo {
    pub sample_rate: u32,
    pub channels: u16,
    /// The FIFO format written to FFmpeg.
    pub format: SampleFormat,
}

#[derive(Clone)]
pub struct NegotiatedAudioInput {
    device_id: String,
    device_name: String,
    input_config: StreamConfig,
    input_sample_format: SampleFormat,
    stream_info: AudioStreamInfo,
    source: NegotiatedAudioSource,
}

#[derive(Clone)]
pub(crate) enum NegotiatedAudioSource {
    Device(Device),
    #[cfg(feature = "audio-mock")]
    Mock,
}

impl NegotiatedAudioInput {
    pub fn device_id(&self) -> &str {
        &self.device_id
    }

    pub fn device_name(&self) -> &str {
        &self.device_name
    }

    pub fn input_config(&self) -> &StreamConfig {
        &self.input_config
    }

    pub fn input_sample_format(&self) -> SampleFormat {
        self.input_sample_format
    }

    pub fn info(&self) -> AudioStreamInfo {
        self.stream_info
    }

    pub(crate) fn into_parts(
        self,
    ) -> (
        NegotiatedAudioSource,
        StreamConfig,
        SampleFormat,
        AudioStreamInfo,
    ) {
        (
            self.source,
            self.input_config,
            self.input_sample_format,
            self.stream_info,
        )
    }
}

/// Resolve the device and config that capture will actually use.
///
/// `None`, `""`, and `"default"` all map to the system default input.
/// "No audio" remains a host-side decision and should bypass this API.
pub fn negotiate_input(device_id: Option<&str>) -> Result<NegotiatedAudioInput, AudioError> {
    #[cfg(feature = "audio-mock")]
    {
        if device_id == Some("__mock__") || std::env::var_os("STORYCAPTURE_AUDIO_MOCK").is_some() {
            return Ok(mock::negotiated_input());
        }
    }

    let host = cpal::default_host();
    let device = resolve_input_device(&host, device_id)?;
    let device_id = device
        .id()
        .map_err(|e| AudioError::Cpal(format!("device.id: {e}")))?
        .to_string();
    let device_name = device
        .description()
        .map_err(|e| AudioError::Cpal(format!("device.description: {e}")))?
        .name()
        .to_string();
    let default_cfg = device
        .default_input_config()
        .map_err(|e| AudioError::Cpal(format!("default_input_config: {e}")))?;
    let input_sample_format = default_cfg.sample_format();

    match input_sample_format {
        SampleFormat::F32 | SampleFormat::I16 => {}
        other => return Err(AudioError::UnsupportedFormat(format!("{other:?}"))),
    }

    let input_config: StreamConfig = default_cfg.into();
    let stream_info = AudioStreamInfo {
        sample_rate: input_config.sample_rate,
        channels: input_config.channels,
        format: SampleFormat::F32,
    };

    Ok(NegotiatedAudioInput {
        device_id,
        device_name,
        input_config,
        input_sample_format,
        stream_info,
        source: NegotiatedAudioSource::Device(device),
    })
}

#[cfg(feature = "audio-mock")]
mod mock {
    use super::*;

    pub(super) fn negotiated_input() -> NegotiatedAudioInput {
        let input_config = StreamConfig {
            channels: 1,
            sample_rate: 48_000,
            buffer_size: cpal::BufferSize::Default,
        };
        let stream_info = AudioStreamInfo {
            sample_rate: input_config.sample_rate,
            channels: input_config.channels,
            format: SampleFormat::F32,
        };

        NegotiatedAudioInput {
            device_id: "__mock__".into(),
            device_name: "Mock audio input".into(),
            input_config,
            input_sample_format: SampleFormat::F32,
            stream_info,
            source: NegotiatedAudioSource::Mock,
        }
    }
}
