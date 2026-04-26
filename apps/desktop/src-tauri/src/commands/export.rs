// Export commands. Thin pass-through over
// `encoder::export::orchestrator::export_run` + catalogue helpers.

use std::path::PathBuf;

use encoder::export::batch::{build_batch, validate as validate_spec, BatchExportRequest};
use encoder::export::error::ExportError;
use encoder::export::format::OutputFormat;
use encoder::export::orchestrator::{export_run as export_run_inner, ExportRequest};
use encoder::export::quality::Quality;
use encoder::export::resolution::{Resolution, VALID_FPS};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::error::AppError;
use crate::state::AppState;

impl From<ExportError> for AppError {
    fn from(e: ExportError) -> Self {
        match e {
            ExportError::OutputFolderNotAllowed(_)
            | ExportError::OutputFolderMissing(_)
            | ExportError::InvalidFps(_)
            | ExportError::UnsupportedCombination
            | ExportError::EmptyBatch => AppError::InvalidArgument(e.to_string()),
            ExportError::Storage(m) => AppError::Storage(m),
            ExportError::Queue(m) => AppError::Encoder(m),
            ExportError::Io(m) => AppError::Io(m),
            ExportError::Serialization(m) => AppError::Serialization(m),
            other => AppError::Encoder(other.to_string()),
        }
    }
}

// ---------------------------------------------------------------------------
// DTOs — TS-bound via specta
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum ContainerDto {
    Mp4,
    Mov,
    #[serde(rename = "webm")]
    WebM,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum CodecDto {
    H264,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum RateControlDto {
    Auto,
    Cbr,
    Vbr,
    Crf,
    Cq,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum X264PresetDto {
    Ultrafast,
    Superfast,
    Veryfast,
    Faster,
    Fast,
    Medium,
    Slow,
    Slower,
    Veryslow,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum AudioCodecDto {
    Aac,
    Opus,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct AudioOptionsDto {
    #[serde(default)]
    pub codec: Option<AudioCodecDto>,
    #[serde(default)]
    pub bitrate_kbps: Option<u32>,
    #[serde(default)]
    pub channels: Option<u8>,
    #[serde(default)]
    pub sample_rate_hz: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct EncoderOptionsDto {
    #[serde(default)]
    pub container: Option<ContainerDto>,
    #[serde(default)]
    pub codec: Option<CodecDto>,
    #[serde(default)]
    pub rate_control: Option<RateControlDto>,
    #[serde(default)]
    pub hw_encoder: Option<crate::commands::encode::HardwareEncoderDto>,
    #[serde(default)]
    pub x264_preset: Option<X264PresetDto>,
    #[serde(default)]
    pub keyframe_interval_sec: Option<u32>,
    #[serde(default)]
    pub downscale_algo: Option<crate::commands::encode::ScaleAlgoDto>,
    #[serde(default)]
    pub audio: Option<AudioOptionsDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct ExportOutputDto {
    /// "mp4" | "webm" | "gif"
    pub format: String,
    /// "720p" | "1080p" | "4k"
    pub resolution: String,
    pub fps: u32,
    /// "low" | "med" | "high"
    pub quality: String,
    #[serde(default)]
    pub encoder_options: Option<EncoderOptionsDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct ExportRunArgs {
    pub story_id: String,
    /// Graph is accepted as a JSON string (TS side sends `JSON.stringify(graph)`);
    /// Rust parses with serde.
    pub graph_json: String,
    pub outputs: Vec<ExportOutputDto>,
    pub priority: i32,
    pub output_folder: String,
    pub base_name: String,
    pub preset_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct ExportResultDto {
    pub batch_id: String,
    pub job_ids: Vec<String>,
    pub graph_snapshot_path: String,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct ExportPresetsCatalogue {
    pub formats: Vec<String>,
    pub resolutions: Vec<String>,
    pub fps: Vec<u32>,
    pub qualities: Vec<String>,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn parse_format(s: &str) -> Result<OutputFormat, AppError> {
    match s.to_ascii_lowercase().as_str() {
        "mp4" => Ok(OutputFormat::Mp4),
        "webm" => Ok(OutputFormat::WebM),
        "gif" => Ok(OutputFormat::Gif),
        other => Err(AppError::InvalidArgument(format!(
            "unknown format: {other}"
        ))),
    }
}

fn parse_resolution(s: &str) -> Result<Resolution, AppError> {
    match s.to_ascii_lowercase().as_str() {
        "720p" => Ok(Resolution::R720p),
        "1080p" => Ok(Resolution::R1080p),
        "4k" => Ok(Resolution::R4k),
        other => Err(AppError::InvalidArgument(format!(
            "unknown resolution: {other}"
        ))),
    }
}

fn parse_quality(s: &str) -> Result<Quality, AppError> {
    match s.to_ascii_lowercase().as_str() {
        "low" => Ok(Quality::Low),
        "med" | "medium" => Ok(Quality::Med),
        "high" => Ok(Quality::High),
        other => Err(AppError::InvalidArgument(format!(
            "unknown quality: {other}"
        ))),
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
#[specta::specta]
#[tracing::instrument(level = "info", skip_all, fields(cmd = "export_run"), err(Debug))]
pub async fn export_run(
    state: State<'_, AppState>,
    args: ExportRunArgs,
) -> Result<ExportResultDto, AppError> {
    let queue = state
        .render_queue()
        .ok_or_else(|| AppError::Internal("render queue not initialised".into()))?;

    let graph: effects::Graph = serde_json::from_str(&args.graph_json)
        .map_err(|e| AppError::Serialization(format!("graph_json: {e}")))?;

    let outputs: Vec<(OutputFormat, Resolution, u32, Quality)> = args
        .outputs
        .iter()
        .map(|o| {
            Ok::<_, AppError>((
                parse_format(&o.format)?,
                parse_resolution(&o.resolution)?,
                o.fps,
                parse_quality(&o.quality)?,
            ))
        })
        .collect::<Result<_, _>>()?;

    let output_folder = PathBuf::from(&args.output_folder);
    let specs = build_batch(&BatchExportRequest {
        outputs,
        out_folder: output_folder.clone(),
        base_name: args.base_name,
    })
    .map_err(AppError::from)?;

    let preset_id = args
        .preset_id
        .as_deref()
        .map(uuid::Uuid::parse_str)
        .transpose()
        .map_err(|e| AppError::InvalidArgument(format!("preset_id: {e}")))?;

    let req = ExportRequest {
        story_id: args.story_id,
        graph,
        outputs: specs,
        priority: args.priority,
        output_folder,
        preset_id,
    };

    let result = export_run_inner(req, Some(&queue.handle), &queue.db)
        .await
        .map_err(AppError::from)?;

    Ok(ExportResultDto {
        batch_id: result.batch_id.to_string(),
        job_ids: result.job_ids.into_iter().map(|u| u.to_string()).collect(),
        graph_snapshot_path: result.graph_snapshot_path.display().to_string(),
    })
}

#[tauri::command]
#[specta::specta]
#[tracing::instrument(level = "info", skip_all, fields(cmd = "export_get_presets"))]
pub fn export_get_presets() -> ExportPresetsCatalogue {
    ExportPresetsCatalogue {
        formats: OutputFormat::all()
            .iter()
            .map(|f| f.extension().to_string())
            .collect(),
        resolutions: Resolution::all()
            .iter()
            .map(|r| encoder::export::resolution::res_label(*r).to_string())
            .collect(),
        fps: VALID_FPS.to_vec(),
        qualities: Quality::all()
            .iter()
            .map(|q| {
                match q {
                    Quality::Low => "low",
                    Quality::Med => "med",
                    Quality::High => "high",
                }
                .to_string()
            })
            .collect(),
    }
}

#[tauri::command]
#[specta::specta]
#[tracing::instrument(level = "info", skip_all, fields(cmd = "export_validate_config"), err(Debug))]
pub fn export_validate_config(cfg: ExportOutputDto) -> Result<(), AppError> {
    let fmt = parse_format(&cfg.format)?;
    let res = parse_resolution(&cfg.resolution)?;
    validate_spec(fmt, res, cfg.fps).map_err(AppError::from)?;

    if let Some(opts) = cfg.encoder_options.as_ref() {
        if let Some(k) = opts.keyframe_interval_sec {
            if !(1..=10).contains(&k) {
                return Err(AppError::InvalidArgument(format!(
                    "keyframe_interval_sec must be 1..=10, got {k}"
                )));
            }
        }
        if let Some(audio) = opts.audio.as_ref() {
            if let Some(br) = audio.bitrate_kbps {
                if !(64..=320).contains(&br) {
                    return Err(AppError::InvalidArgument(format!(
                        "audio.bitrate_kbps must be 64..=320, got {br}"
                    )));
                }
            }
            if let Some(ch) = audio.channels {
                if !matches!(ch, 1 | 2) {
                    return Err(AppError::InvalidArgument(format!(
                        "audio.channels must be 1 or 2, got {ch}"
                    )));
                }
            }
        }
        // encoder_options: validated; runtime consumption deferred.
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn encoder_options_absent_deserializes_as_none() {
        let v = json!({
            "format": "mp4",
            "resolution": "1080p",
            "fps": 30,
            "quality": "med"
        });
        let dto: ExportOutputDto = serde_json::from_value(v).unwrap();
        assert!(dto.encoder_options.is_none());
    }

    #[test]
    fn encoder_options_fully_populated_roundtrip() {
        let v = json!({
            "format": "mp4",
            "resolution": "1080p",
            "fps": 30,
            "quality": "high",
            "encoder_options": {
                "container": "mp4",
                "codec": "h264",
                "rate_control": "crf",
                "hw_encoder": "video-toolbox-h264",
                "x264_preset": "medium",
                "keyframe_interval_sec": 2,
                "downscale_algo": "lanczos",
                "audio": {
                    "codec": "aac",
                    "bitrate_kbps": 160,
                    "channels": 2,
                    "sample_rate_hz": 48000
                }
            }
        });
        let dto: ExportOutputDto = serde_json::from_value(v).unwrap();
        let opts = dto.encoder_options.expect("encoder_options present");
        assert!(matches!(opts.container, Some(ContainerDto::Mp4)));
        assert!(matches!(opts.codec, Some(CodecDto::H264)));
        assert!(matches!(opts.rate_control, Some(RateControlDto::Crf)));
        assert!(matches!(opts.x264_preset, Some(X264PresetDto::Medium)));
        assert_eq!(opts.keyframe_interval_sec, Some(2));
        let audio = opts.audio.expect("audio present");
        assert!(matches!(audio.codec, Some(AudioCodecDto::Aac)));
        assert_eq!(audio.bitrate_kbps, Some(160));
        assert_eq!(audio.channels, Some(2));
        assert_eq!(audio.sample_rate_hz, Some(48_000));
    }

    #[test]
    fn encoder_options_partial_leaves_other_fields_none() {
        let v = json!({
            "format": "mp4",
            "resolution": "1080p",
            "fps": 30,
            "quality": "med",
            "encoder_options": { "keyframe_interval_sec": 2 }
        });
        let dto: ExportOutputDto = serde_json::from_value(v).unwrap();
        let opts = dto.encoder_options.expect("encoder_options present");
        assert_eq!(opts.keyframe_interval_sec, Some(2));
        assert!(opts.container.is_none());
        assert!(opts.codec.is_none());
        assert!(opts.rate_control.is_none());
        assert!(opts.hw_encoder.is_none());
        assert!(opts.x264_preset.is_none());
        assert!(opts.downscale_algo.is_none());
        assert!(opts.audio.is_none());
    }

    #[test]
    fn presets_catalogue_shape() {
        let p = export_get_presets();
        assert_eq!(p.formats, vec!["mp4", "webm", "gif"]);
        assert_eq!(p.resolutions, vec!["720p", "1080p", "4k"]);
        assert_eq!(p.fps, vec![24, 30, 60]);
        assert_eq!(p.qualities, vec!["low", "med", "high"]);
    }

    #[test]
    fn validate_config_happy() {
        assert!(export_validate_config(ExportOutputDto {
            format: "mp4".into(),
            resolution: "1080p".into(),
            fps: 60,
            quality: "high".into(),
            encoder_options: None,
        })
        .is_ok());
    }

    #[test]
    fn validate_config_rejects_4k_gif() {
        let e = export_validate_config(ExportOutputDto {
            format: "gif".into(),
            resolution: "4k".into(),
            fps: 30,
            quality: "med".into(),
            encoder_options: None,
        })
        .unwrap_err();
        assert!(matches!(e, AppError::InvalidArgument(_)));
    }

    fn base_cfg() -> ExportOutputDto {
        ExportOutputDto {
            format: "mp4".into(),
            resolution: "1080p".into(),
            fps: 30,
            quality: "med".into(),
            encoder_options: None,
        }
    }

    #[test]
    fn validate_rejects_keyframe_out_of_range() {
        let mut cfg = base_cfg();
        cfg.encoder_options = Some(EncoderOptionsDto {
            container: None,
            codec: None,
            rate_control: None,
            hw_encoder: None,
            x264_preset: None,
            keyframe_interval_sec: Some(0),
            downscale_algo: None,
            audio: None,
        });
        let e = export_validate_config(cfg).unwrap_err();
        assert!(matches!(e, AppError::InvalidArgument(_)));
    }

    #[test]
    fn validate_rejects_audio_bitrate_too_low() {
        let mut cfg = base_cfg();
        cfg.encoder_options = Some(EncoderOptionsDto {
            container: None,
            codec: None,
            rate_control: None,
            hw_encoder: None,
            x264_preset: None,
            keyframe_interval_sec: None,
            downscale_algo: None,
            audio: Some(AudioOptionsDto {
                codec: None,
                bitrate_kbps: Some(32),
                channels: None,
                sample_rate_hz: None,
            }),
        });
        let e = export_validate_config(cfg).unwrap_err();
        assert!(matches!(e, AppError::InvalidArgument(_)));
    }

    #[test]
    fn validate_rejects_audio_channels_not_mono_or_stereo() {
        let mut cfg = base_cfg();
        cfg.encoder_options = Some(EncoderOptionsDto {
            container: None,
            codec: None,
            rate_control: None,
            hw_encoder: None,
            x264_preset: None,
            keyframe_interval_sec: None,
            downscale_algo: None,
            audio: Some(AudioOptionsDto {
                codec: None,
                bitrate_kbps: None,
                channels: Some(3),
                sample_rate_hz: None,
            }),
        });
        let e = export_validate_config(cfg).unwrap_err();
        assert!(matches!(e, AppError::InvalidArgument(_)));
    }

    #[test]
    fn validate_accepts_valid_encoder_options() {
        let mut cfg = base_cfg();
        cfg.encoder_options = Some(EncoderOptionsDto {
            container: Some(ContainerDto::Mp4),
            codec: Some(CodecDto::H264),
            rate_control: Some(RateControlDto::Crf),
            hw_encoder: None,
            x264_preset: Some(X264PresetDto::Medium),
            keyframe_interval_sec: Some(2),
            downscale_algo: None,
            audio: Some(AudioOptionsDto {
                codec: Some(AudioCodecDto::Aac),
                bitrate_kbps: Some(160),
                channels: Some(2),
                sample_rate_hz: Some(48_000),
            }),
        });
        assert!(export_validate_config(cfg).is_ok());
    }

    #[test]
    fn validate_accepts_none_encoder_options_backcompat() {
        assert!(export_validate_config(base_cfg()).is_ok());
    }
}
