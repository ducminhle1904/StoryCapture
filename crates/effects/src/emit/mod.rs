//! Dual emitters: FFmpeg `filter_complex` (final export) and PreviewRenderPlan
//! (WebGPU preview). Both consume the same `Graph` AST — single source of
//! truth (D-01).

pub mod ffmpeg;
pub mod preview;

pub use ffmpeg::{emit_filter_complex, FfmpegEmit};
pub use preview::{emit_preview_plan, PreviewEmit, PreviewRenderPlan, ZoomMatrixFrame};
