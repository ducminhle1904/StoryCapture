//! Export orchestration (Plan 02-11).
//!
//! EXPORT-01 (render final polished video via the effect pipeline on the raw
//! recording) / EXPORT-02 (MP4 / WebM / GIF formats) / EXPORT-03 (720p /
//! 1080p / 4K resolutions + 24/30/60 fps + low/med/high quality) /
//! EXPORT-04 (batch export multiple formats sharing one batch_id).
//!
//! This module layers an end-user-facing format/resolution/quality catalogue
//! on top of the Plan 02-10 `fanout` primitives. The `orchestrator`
//! sub-module composes `render_intermediate` + `fanout_encode` into a single
//! `export_run(ExportRequest, &RenderQueueHandle, &db, ...)` entrypoint.
//!
//! The PSNR regression harness (POST-08) lives in [`psnr`].

pub mod batch;
pub mod error;
pub mod format;
pub mod orchestrator;
pub mod psnr;
pub mod quality;
pub mod reference_graph;
pub mod resolution;

pub use batch::{build_batch, validate, BatchExportRequest, OutputSpec};
pub use error::ExportError;
pub use format::{codec_for, ContainerExt, OutputFormat};
pub use orchestrator::{export_run, ExportRequest, ExportResult};
pub use psnr::{compute_psnr, parse_psnr_stats, PsnrResult};
pub use quality::{bitrate_for, crf_for, Quality};
pub use resolution::{dimensions_for, res_label, Resolution, VALID_FPS};
