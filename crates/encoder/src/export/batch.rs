//! Batch export builder.
//!
//! `build_batch` stamps a single `batch_id` on every `OutputSpec` in the
//! batch so the render queue can smart-batch-reuse the FFV1 intermediate
//! across all outputs.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::error::ExportError;
use super::format::OutputFormat;
use super::quality::Quality;
use super::resolution::{res_label, validate_dimensions, Resolution, VALID_FPS};
use crate::fanout::ExportEncodeOptions;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BatchOutputRequest {
    pub format: OutputFormat,
    pub resolution: Resolution,
    pub fps: u32,
    pub quality: Quality,
    pub encoder_options: Option<ExportEncodeOptions>,
}

/// User-facing request. One entry per output; the same batch_id is stamped
/// across every emitted OutputSpec.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BatchExportRequest {
    pub outputs: Vec<BatchOutputRequest>,
    pub out_folder: PathBuf,
    pub base_name: String,
}

/// Fully-resolved output specification. Distinct from
/// [`crate::fanout::OutputSpec`] — the latter is the low-level encoder-
/// argv contract; this is the user-facing render-queue row.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OutputSpec {
    pub id: Uuid,
    pub batch_id: Uuid,
    pub format: OutputFormat,
    pub resolution: Resolution,
    pub output_width: u32,
    pub output_height: u32,
    pub fps: u32,
    pub quality: Quality,
    pub encoder_options: Option<ExportEncodeOptions>,
    pub output_path: PathBuf,
}

/// Validate a single (format, resolution, fps) combination. Called during
/// batch-building and from the Tauri `export_validate_config` command.
pub fn validate(fmt: OutputFormat, res: Resolution, fps: u32) -> Result<(), ExportError> {
    if !VALID_FPS.contains(&fps) {
        return Err(ExportError::InvalidFps(fps));
    }
    // No 4K GIF — unreasonable payload, no consumer.
    if matches!(fmt, OutputFormat::Gif) && matches!(res, Resolution::R4k) {
        return Err(ExportError::UnsupportedCombination);
    }
    if let Resolution::Custom { width, height } = res {
        if !validate_dimensions(width, height) {
            return Err(ExportError::UnsupportedCombination);
        }
    }
    // GIF above 30 fps is brittle across tools; cap.
    if matches!(fmt, OutputFormat::Gif) && fps > 30 {
        return Err(ExportError::UnsupportedCombination);
    }
    Ok(())
}

/// Build a batch of [`OutputSpec`]s from a user request. Every returned
/// spec shares one freshly-minted `batch_id` (Uuid::now_v7 for
/// time-orderedness in the render_jobs table).
pub fn build_batch(req: &BatchExportRequest) -> Result<Vec<OutputSpec>, ExportError> {
    if req.outputs.is_empty() {
        return Err(ExportError::EmptyBatch);
    }
    let batch_id = Uuid::now_v7();
    req.outputs
        .iter()
        .map(|output| {
            validate(output.format, output.resolution, output.fps)?;
            let (output_width, output_height) =
                super::resolution::dimensions_for(output.resolution);
            let filename = format!(
                "{}.{}.{}.{}",
                req.base_name,
                res_label(output.resolution),
                output.fps,
                output.format.extension()
            );
            Ok(OutputSpec {
                id: Uuid::new_v4(),
                batch_id,
                format: output.format,
                resolution: output.resolution,
                output_width,
                output_height,
                fps: output.fps,
                quality: output.quality,
                encoder_options: output.encoder_options.clone(),
                output_path: req.out_folder.join(filename),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_batch_assigns_single_batch_id() {
        let req = BatchExportRequest {
            outputs: vec![
                BatchOutputRequest {
                    format: OutputFormat::Mp4,
                    resolution: Resolution::R1080p,
                    fps: 60,
                    quality: Quality::Med,
                    encoder_options: None,
                },
                BatchOutputRequest {
                    format: OutputFormat::WebM,
                    resolution: Resolution::R1080p,
                    fps: 30,
                    quality: Quality::High,
                    encoder_options: None,
                },
                BatchOutputRequest {
                    format: OutputFormat::Gif,
                    resolution: Resolution::R720p,
                    fps: 24,
                    quality: Quality::Low,
                    encoder_options: None,
                },
            ],
            out_folder: PathBuf::from("/tmp/out"),
            base_name: "clip".into(),
        };
        let specs = build_batch(&req).unwrap();
        assert_eq!(specs.len(), 3);
        let batch = specs[0].batch_id;
        assert!(specs.iter().all(|s| s.batch_id == batch));
        // All output ids distinct.
        let mut ids: Vec<_> = specs.iter().map(|s| s.id).collect();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), 3);
        // File naming has resolution label + fps + extension.
        let p0 = specs[0].output_path.to_string_lossy().to_string();
        assert!(p0.ends_with("clip.1080p.60.mp4"), "got: {p0}");
    }

    #[test]
    fn validate_rejects_invalid_fps() {
        let e = validate(OutputFormat::Mp4, Resolution::R1080p, 15).unwrap_err();
        matches!(e, ExportError::InvalidFps(15));
    }

    #[test]
    fn validate_rejects_4k_gif() {
        let e = validate(OutputFormat::Gif, Resolution::R4k, 30).unwrap_err();
        matches!(e, ExportError::UnsupportedCombination);
    }

    #[test]
    fn validate_rejects_gif_above_30fps() {
        let e = validate(OutputFormat::Gif, Resolution::R720p, 60).unwrap_err();
        matches!(e, ExportError::UnsupportedCombination);
    }

    #[test]
    fn validate_accepts_all_valid_combos() {
        for &fmt in OutputFormat::all() {
            for &res in Resolution::all() {
                for &fps in VALID_FPS {
                    let ok = validate(fmt, res, fps).is_ok();
                    let is_forbidden = matches!(
                        (fmt, res, fps),
                        (OutputFormat::Gif, Resolution::R4k, _) | (OutputFormat::Gif, _, 60)
                    );
                    assert_eq!(ok, !is_forbidden, "fmt={fmt:?} res={res:?} fps={fps}");
                }
            }
        }
    }

    #[test]
    fn empty_batch_rejected() {
        let req = BatchExportRequest {
            outputs: vec![],
            out_folder: PathBuf::from("/tmp"),
            base_name: "x".into(),
        };
        assert!(matches!(build_batch(&req), Err(ExportError::EmptyBatch)));
    }
}
