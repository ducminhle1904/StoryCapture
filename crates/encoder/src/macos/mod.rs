//! macOS-only fast path for the encoder: AVAssetWriter wrapping
//! VideoToolbox, ingesting `CVPixelBuffer` handles directly. Replaces the
//! FFmpeg subprocess for `FrameData::NativeMacOS` frames and eliminates
//! the per-frame CPU copy that `CVPixelBufferHandle::to_owned_bgra` would
//! otherwise incur.

pub mod vt_writer;

pub use vt_writer::{VtWriter, VtWriterHandle};
