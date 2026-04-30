//! `encoder` — FFmpeg sidecar lifecycle + hardware-encoder feature detection.
//!
//! Pure crate. The Tauri host injects a `SidecarCommand` (resolved via
//! `tauri-plugin-shell` / externalBin) so this crate has zero dependency
//! on `tauri` itself. See `apps/desktop/src-tauri/src/commands/encode.rs`
//! for the host-side bridge.
//!
//! Output format is MP4. Hardware encoders (VideoToolbox / NVENC / QSV / AMF)
//! are selected at startup via `probe_encoders`; `libx264` is the
//! quality-first software path and `libopenh264` is the LGPL fallback.

mod config;
mod error;
pub mod export;
pub mod fanout;
pub mod filters;
#[cfg(target_os = "macos")]
pub mod macos;
mod pipeline;
pub mod pool;
pub mod probe;
pub mod progress;
pub mod quality;
pub mod queue;
mod sidecar;
mod staging;

pub use config::{AudioFormat, AudioInput, EncodeConfig};
pub use error::{EncoderError, Result};
pub use filters::{
    build_vf, FilterSpec, FitMode, OutputResolution, PadColor, QualityPreset, ScaleAlgo,
};
pub use pipeline::{
    bgra_bytes_of_frame, BackpressureCallback, EncodePipeline, EncodeResult, SHUTDOWN_TIMEOUT,
};
pub use pool::{PoolConfig, SidecarHandle, SidecarPermit, SidecarPool};
pub use probe::{probe_encoders, EncoderProbe, HardwareEncoder};
pub use progress::{
    parse_line, EncodeProgress, ProgressFrag, ProgressParser, RenderProgress, RenderProgressParser,
};
pub use quality::{pixel_based_kbps, resolve as resolve_quality_args};
pub use queue::{
    open_project_conn, spawn_render_queue, JobExecutor, JobOutcome, NoopJobExecutor, QueueMsg,
    RenderQueueActor, RenderQueueConfig, RenderQueueHandle, SharedExecutor,
};
pub use sidecar::{FfmpegSidecar, LocalFfmpegCommand, SidecarChild, SidecarCommand};

pub use fanout::{
    bitrate_for, build_encode_args, build_intermediate_args, default_h264_encoder, fanout_encode,
    render_intermediate, resolution_height, resolution_width, FanoutPlan, IntermediateOutput,
    OutputFormat, OutputSpec, Quality, Resolution,
};
