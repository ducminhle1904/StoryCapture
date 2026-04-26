//! `Frame` — captured screen frame plus backend-supplied timing metadata.
//!
//! `pts` records whatever timestamp the active backend emits, tagged with
//! its clock source. The capture crate preserves that metadata as-is, but
//! recorder sessions do not treat it as an end-to-end encode contract:
//! some backends emit synthetic clocks and the current FFmpeg rawvideo
//! recorder path runs CFR timing downstream.
//!
//! `FrameData` holds either a native surface handle (zero-copy on the
//! primary backends — RAII wrappers below CFRelease / Release on Drop) or
//! an owned `Vec<u8>` (xcap fallback path; not zero-copy).

use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU64, Ordering};

/// Process-wide monotonic frame sequence. Shared across every backend
/// (SCK, WGC, xcap) so the HUD never sees a sequence regression when the
/// orchestrator falls back mid-session.
static SEQUENCE: AtomicU64 = AtomicU64::new(0);

pub fn next_sequence() -> u64 {
    SEQUENCE.fetch_add(1, Ordering::AcqRel)
}

#[cfg(test)]
pub fn reset_sequence_for_test() {
    SEQUENCE.store(0, Ordering::Release);
}

/// Pixel format of the captured frame.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PixelFormat {
    /// 8-bit BGRA (default for SCK + WGC + xcap).
    Bgra,
    /// Planar 4:2:0 YUV (NV12) — used by the encoder hot path on hardware
    /// encoders that prefer chroma-subsampled input.
    Nv12,
}

impl PixelFormat {
    /// Bytes per pixel (BGRA), or worst-case bytes per pixel for planar
    /// formats (NV12 averages 1.5 bpp; we use 2 to over-budget the queue).
    pub fn bytes_per_pixel(self) -> usize {
        match self {
            PixelFormat::Bgra => 4,
            PixelFormat::Nv12 => 2,
        }
    }
}

/// Origin of a presentation timestamp.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ClockSource {
    /// macOS host time (mach_absolute_time scaled to nanoseconds via
    /// mach_timebase_info). CMTime samples are converted to this base.
    HostTime,
    /// Windows QueryPerformanceCounter scaled to nanoseconds via
    /// QueryPerformanceFrequency.
    Qpc,
    /// Synthetic or host-derived clock. Used in tests and in paths that
    /// cannot preserve a native capture timestamp end-to-end.
    Synthetic,
}

/// Backend-supplied presentation timestamp, in nanoseconds, tagged with
/// its source clock so downstream code can detect clock-base mismatches
/// or synthetic timing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Pts {
    pub ns: i128,
    pub source: ClockSource,
}

impl Pts {
    pub fn synthetic(ns: i128) -> Self {
        Pts {
            ns,
            source: ClockSource::Synthetic,
        }
    }
}

/// Either a native surface handle (zero-copy) or owned pixel bytes
/// (fallback). Drop impls on the native handles release the underlying
/// platform refcount (CFRelease for IOSurface/CVPixelBuffer, COM Release
/// for ID3D11Texture2D). When the host moves these out of the capture
/// pipeline they MUST keep them alive until the encoder is done.
pub enum FrameData {
    /// macOS native surface (CVPixelBuffer + retained CFRetain). Zero-copy.
    #[cfg(target_os = "macos")]
    NativeMacOS(crate::macos::raii::CVPixelBufferHandle),
    /// Windows native surface (ID3D11Texture2D, COM-retained). Zero-copy.
    #[cfg(target_os = "windows")]
    NativeWindows(crate::windows::raii::D3DTextureHandle),
    /// Owned BGRA/NV12 bytes + row stride. Used by xcap fallback.
    Owned(Vec<u8>, usize /* stride bytes */),
    /// Pooled BGRA bytes + row stride. Used by the Windows.Graphics.Capture
    /// path to avoid per-frame heap allocations: on `Drop`, the
    /// underlying `Vec<u8>` returns to a small pool owned by
    /// `WgcBackend` (backlog item #2 step A2). Behaves identically to
    /// `Owned` for read access.
    #[cfg(target_os = "windows")]
    Pooled(
        crate::windows::pool::PooledBuf,
        usize, /* stride bytes */
    ),
}

impl std::fmt::Debug for FrameData {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            #[cfg(target_os = "macos")]
            FrameData::NativeMacOS(_) => write!(f, "FrameData::NativeMacOS(<opaque>)"),
            #[cfg(target_os = "windows")]
            FrameData::NativeWindows(_) => write!(f, "FrameData::NativeWindows(<opaque>)"),
            FrameData::Owned(v, stride) => {
                write!(f, "FrameData::Owned({} bytes, stride={})", v.len(), stride)
            }
            #[cfg(target_os = "windows")]
            FrameData::Pooled(b, stride) => {
                write!(f, "FrameData::Pooled({} bytes, stride={})", b.len(), stride)
            }
        }
    }
}

/// A single captured frame.
#[derive(Debug)]
pub struct Frame {
    /// Backend-supplied timestamp metadata for this frame.
    pub pts: Pts,
    /// Physical-pixel width (retina / per-monitor DPI corrected).
    pub width_px: u32,
    /// Physical-pixel height.
    pub height_px: u32,
    /// Pixel format of `data`.
    pub format: PixelFormat,
    /// Frame payload — native surface or owned bytes.
    pub data: FrameData,
    /// Monotonic frame counter assigned by the backend.
    pub sequence: u64,
}

impl Frame {
    /// Conservative byte-cost used by the byte-bounded queue.
    /// For `Owned` frames this is the actual buffer size. For native
    /// surfaces we estimate from `height * stride` since the OS may share
    /// pages with the GPU and the in-process Rust accounting doesn't see
    /// the IOSurface backing memory directly — we still count it because
    /// dropping the handle frees the IOSurface on the OS side.
    pub fn byte_size(&self) -> usize {
        match &self.data {
            FrameData::Owned(v, _stride) => v.len(),
            #[cfg(target_os = "windows")]
            FrameData::Pooled(b, _stride) => b.len(),
            #[cfg(target_os = "macos")]
            FrameData::NativeMacOS(_) => {
                self.width_px as usize * self.height_px as usize * self.format.bytes_per_pixel()
            }
            #[cfg(target_os = "windows")]
            FrameData::NativeWindows(_) => {
                self.width_px as usize * self.height_px as usize * self.format.bytes_per_pixel()
            }
        }
    }
}
