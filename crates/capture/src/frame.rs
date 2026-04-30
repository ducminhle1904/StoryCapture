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

/// Crop rectangle applied to an already-captured frame.
///
/// This is intentionally frame-relative, not screen-relative. `x/y/w/h` may be
/// physical pixels already, or logical window coordinates when `basis_w/h`
/// describe the full logical window size that the rect was measured against.
/// The latter lets the capture backend scale browser viewport crops against
/// the actual native frame size (for example macOS Retina SCK frames).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct FrameCropRect {
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
    #[serde(default)]
    pub basis_w: Option<u32>,
    #[serde(default)]
    pub basis_h: Option<u32>,
    /// Advisory logical-to-native scale from the source that produced this
    /// crop, for example browser `devicePixelRatio`. Capture backends may use
    /// it to request a Retina/DPI-sized window canvas before applying the
    /// crop.
    #[serde(default)]
    pub scale_hint: Option<f64>,
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

/// Stride-aware CPU crop of a BGRA frame.
///
/// Returns `Ok(None)` for invalid crop rectangles or unsupported frame
/// formats. Native macOS frames are copied into BGRA first; this path is only
/// used for explicit frame-subrect capture modes where correctness is more
/// important than preserving the zero-copy fast path.
pub fn crop_bgra_frame(frame: Frame, rect: FrameCropRect) -> Result<Option<Frame>, String> {
    if rect.w == 0 || rect.h == 0 || frame.format != PixelFormat::Bgra {
        return Ok(None);
    }
    let rect = match resolve_crop_rect(rect, frame.width_px, frame.height_px) {
        Some(rect) => rect,
        None => return Ok(None),
    };
    let end_x = match rect.x.checked_add(rect.w) {
        Some(v) => v,
        None => return Ok(None),
    };
    let end_y = match rect.y.checked_add(rect.h) {
        Some(v) => v,
        None => return Ok(None),
    };
    if end_x > frame.width_px || end_y > frame.height_px {
        return Ok(None);
    }

    let (bytes, stride): (std::borrow::Cow<'_, [u8]>, usize) = match &frame.data {
        FrameData::Owned(v, stride) => (std::borrow::Cow::Borrowed(v.as_slice()), *stride),
        #[cfg(target_os = "windows")]
        FrameData::Pooled(b, stride) => (std::borrow::Cow::Borrowed(&b[..]), *stride),
        #[cfg(target_os = "macos")]
        FrameData::NativeMacOS(handle) => {
            let (bytes, stride) = handle
                .to_owned_bgra()
                .map_err(|rc| format!("CVPixelBufferLockBaseAddress failed (CVReturn {rc})"))?;
            (std::borrow::Cow::Owned(bytes), stride)
        }
        #[cfg(target_os = "windows")]
        FrameData::NativeWindows(_) => return Ok(None),
    };

    let row_bytes = (rect.w as usize) * 4;
    let mut out = Vec::with_capacity(row_bytes * rect.h as usize);
    for row in rect.y..end_y {
        let row_start = (row as usize) * stride + (rect.x as usize) * 4;
        let row_end = row_start + row_bytes;
        if row_end > bytes.len() {
            return Ok(None);
        }
        out.extend_from_slice(&bytes[row_start..row_end]);
    }

    Ok(Some(Frame {
        pts: frame.pts,
        width_px: rect.w,
        height_px: rect.h,
        format: frame.format,
        data: FrameData::Owned(out, row_bytes),
        sequence: frame.sequence,
    }))
}

fn resolve_crop_rect(rect: FrameCropRect, frame_w: u32, frame_h: u32) -> Option<FrameCropRect> {
    if rect.w == 0 || rect.h == 0 || frame_w == 0 || frame_h == 0 {
        return None;
    }

    let (x, y, mut w, mut h) = match (rect.basis_w, rect.basis_h) {
        (Some(basis_w), Some(basis_h)) if basis_w > 0 && basis_h > 0 => (
            scale_axis(rect.x, basis_w, frame_w),
            scale_axis(rect.y, basis_h, frame_h),
            scale_axis(rect.w, basis_w, frame_w).max(1),
            scale_axis(rect.h, basis_h, frame_h).max(1),
        ),
        _ => (rect.x, rect.y, rect.w, rect.h),
    };

    if x >= frame_w || y >= frame_h {
        return None;
    }
    if x.saturating_add(w) > frame_w {
        w = frame_w - x;
    }
    if y.saturating_add(h) > frame_h {
        h = frame_h - y;
    }
    if w == 0 || h == 0 {
        return None;
    }

    Some(FrameCropRect {
        x,
        y,
        w,
        h,
        basis_w: None,
        basis_h: None,
        scale_hint: None,
    })
}

fn scale_axis(value: u32, basis: u32, actual: u32) -> u32 {
    let numerator = (value as u128) * (actual as u128) + (basis as u128 / 2);
    (numerator / basis as u128).min(u32::MAX as u128) as u32
}

#[cfg(test)]
mod crop_tests {
    use super::*;

    #[test]
    fn crop_bgra_frame_uses_stride_and_preserves_metadata() {
        let width = 5u32;
        let height = 4u32;
        let stride = 24usize;
        let mut bytes = vec![0u8; stride * height as usize];
        for y in 0..height {
            for x in 0..width {
                let base = y as usize * stride + x as usize * 4;
                bytes[base] = x as u8;
                bytes[base + 1] = y as u8;
                bytes[base + 2] = 0xaa;
                bytes[base + 3] = 0xff;
            }
        }
        let frame = Frame {
            pts: Pts::synthetic(123),
            width_px: width,
            height_px: height,
            format: PixelFormat::Bgra,
            data: FrameData::Owned(bytes, stride),
            sequence: 7,
        };

        let cropped = crop_bgra_frame(
            frame,
            FrameCropRect {
                x: 1,
                y: 1,
                w: 3,
                h: 2,
                basis_w: None,
                basis_h: None,
                scale_hint: None,
            },
        )
        .expect("crop attempt ok")
        .expect("crop in bounds");

        assert_eq!(cropped.width_px, 3);
        assert_eq!(cropped.height_px, 2);
        assert_eq!(cropped.pts.ns, 123);
        assert_eq!(cropped.sequence, 7);
        let FrameData::Owned(out, out_stride) = cropped.data else {
            panic!("expected owned crop");
        };
        assert_eq!(out_stride, 12);
        assert_eq!(out.len(), 24);
        assert_eq!(&out[0..4], &[1, 1, 0xaa, 0xff]);
        assert_eq!(&out[8..12], &[3, 1, 0xaa, 0xff]);
        assert_eq!(&out[12..16], &[1, 2, 0xaa, 0xff]);
    }

    #[test]
    fn crop_bgra_frame_scales_logical_rect_to_physical_frame() {
        let width = 10u32;
        let height = 8u32;
        let stride = width as usize * 4;
        let mut bytes = vec![0u8; stride * height as usize];
        for y in 0..height {
            for x in 0..width {
                let base = y as usize * stride + x as usize * 4;
                bytes[base] = x as u8;
                bytes[base + 1] = y as u8;
                bytes[base + 2] = 0xaa;
                bytes[base + 3] = 0xff;
            }
        }
        let frame = Frame {
            pts: Pts::synthetic(456),
            width_px: width,
            height_px: height,
            format: PixelFormat::Bgra,
            data: FrameData::Owned(bytes, stride),
            sequence: 9,
        };

        let cropped = crop_bgra_frame(
            frame,
            FrameCropRect {
                x: 0,
                y: 1,
                w: 5,
                h: 3,
                basis_w: Some(5),
                basis_h: Some(4),
                scale_hint: None,
            },
        )
        .expect("crop attempt ok")
        .expect("scaled crop in bounds");

        assert_eq!(cropped.width_px, 10);
        assert_eq!(cropped.height_px, 6);
        let FrameData::Owned(out, out_stride) = cropped.data else {
            panic!("expected owned crop");
        };
        assert_eq!(out_stride, 40);
        assert_eq!(&out[0..4], &[0, 2, 0xaa, 0xff]);
        assert_eq!(&out[36..40], &[9, 2, 0xaa, 0xff]);
    }
}
