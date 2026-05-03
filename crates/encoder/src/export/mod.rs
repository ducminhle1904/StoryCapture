//! Export orchestration.
//!
//! Layers an end-user-facing format/resolution/quality catalogue on top of
//! the `fanout` primitives. The `orchestrator` sub-module composes
//! `render_intermediate` + `fanout_encode` into a single
//! `export_run(ExportRequest, &RenderQueueHandle, &db, ...)` entrypoint.
//!
//! The PSNR regression harness lives in [`psnr`].

pub mod batch;
pub mod error;
pub mod format;
pub mod orchestrator;
pub mod psnr;
pub mod quality;
pub mod reference_graph;
pub mod resolution;

pub use batch::{build_batch, validate, BatchExportRequest, BatchOutputRequest, OutputSpec};
pub use error::ExportError;
pub use format::{codec_for, ContainerExt, OutputFormat};
pub use orchestrator::{export_run, ExportRequest, ExportResult};
pub use psnr::{compute_psnr, parse_psnr_stats, PsnrResult};
pub use quality::{bitrate_for, crf_for, Quality};
pub use resolution::{dimensions_for, res_label, Resolution, VALID_FPS};
