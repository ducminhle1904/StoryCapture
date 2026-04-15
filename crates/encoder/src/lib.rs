//! `encoder` — FFmpeg sidecar lifecycle + hardware-encoder feature detection
//! (Phase 1 / Plan 01-08 / ENC-02, ENC-03).
//!
//! Pure crate. The Tauri host injects a `SidecarCommand` (resolved via
//! `tauri-plugin-shell` / externalBin) so this crate has zero dependency
//! on `tauri` itself. See `apps/desktop/src-tauri/src/commands/encode.rs`
//! for the host-side bridge.
//!
//! Phase 1 output format is MP4 / H.264 baseline only (D-25). Hardware
//! encoders (VideoToolbox / NVENC / QSV / AMF) are selected at startup
//! via `probe_encoders`; `libopenh264` is the LGPL software fallback
//! (D-24). x264/x265 are explicitly excluded to preserve the LGPL build
//! discipline (D-22 / Plan 01-02).

mod config;
mod error;
mod pipeline;
mod probe;
mod progress;
mod sidecar;

pub use config::EncodeConfig;
pub use error::{EncoderError, Result};
pub use pipeline::{bgra_bytes_of_frame, EncodePipeline, EncodeResult, SHUTDOWN_TIMEOUT};
pub use probe::{probe_encoders, EncoderProbe, HardwareEncoder};
pub use progress::{EncodeProgress, ProgressParser};
pub use sidecar::{FfmpegSidecar, LocalFfmpegCommand, SidecarChild, SidecarCommand};
