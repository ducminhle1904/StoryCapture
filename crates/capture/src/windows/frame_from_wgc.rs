//! Windows.Graphics.Capture `Frame` → our `crate::Frame` (Plan 05-03).
//!
//! The `windows-capture` 2.0.0 Frame lends its D3D11 staging-texture buffer
//! behind `.buffer()`, which copies the GPU texture into CPU-visible memory
//! and exposes a `FrameBuffer<'a>` with `as_nopadding_buffer` / `row_pitch`.
//! We take the nopadding buffer (stride = width*4) so the encoder's ingest
//! path treats BGRA identically to xcap's owned-bytes path.
//!
//! Zero-copy would require shipping an `ID3D11Texture2D` handle through the
//! pipeline (via `FrameData::NativeWindows`). The downstream FFmpeg sidecar
//! accepts CPU BGRA today; we start with the owned-bytes path and can swap
//! in zero-copy later as a performance optimization. The backend-failure
//! semantics are independent.

#![cfg(target_os = "windows")]

use crate::error::CaptureError;
use crate::frame::{self, ClockSource, Frame, FrameData, PixelFormat, Pts};
use std::time::Instant;
use windows_capture::frame::Frame as WgcFrame;
use windows_capture::settings::ColorFormat;

/// Physical-pixel rect for WGC post-capture CPU crop. Plan 06-02.
///
/// All four fields are in physical pixels (DPI-scaled). The crop happens
/// in `on_frame_arrived` against the BGRA buffer returned by
/// `as_nopadding_buffer`, so `stride` is the row pitch of the SOURCE
/// buffer (NOT necessarily `width*4`) and MUST come from the caller.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PhysicalRectU32 {
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
}

/// Stride-aware CPU crop of a BGRA buffer. Copies exactly `rect.h` rows,
/// each `rect.w * 4` bytes wide, starting at `(rect.x, rect.y)`.
///
/// `src_stride` is the source buffer's row pitch in bytes — `width_px*4`
/// for a nopadding buffer, or the D3D11 texture's `RowPitch` for a raw
/// staging buffer.
///
/// Returns `None` if the crop rect overflows the source buffer bounds;
/// the caller SHOULD treat this as a drop (increment drop counter,
/// continue). A malformed rect must never panic.
pub fn cpu_crop_bgra(
    src: &[u8],
    src_width_px: u32,
    src_height_px: u32,
    src_stride: usize,
    rect: PhysicalRectU32,
) -> Option<Vec<u8>> {
    if rect.w == 0 || rect.h == 0 {
        return None;
    }
    let end_x = rect.x.checked_add(rect.w)?;
    let end_y = rect.y.checked_add(rect.h)?;
    if end_x > src_width_px || end_y > src_height_px {
        return None;
    }
    let row_bytes = (rect.w as usize) * 4;
    let mut out = Vec::with_capacity(row_bytes * rect.h as usize);
    for row in rect.y..end_y {
        let row_start = (row as usize) * src_stride + (rect.x as usize) * 4;
        let row_end = row_start + row_bytes;
        if row_end > src.len() {
            return None;
        }
        out.extend_from_slice(&src[row_start..row_end]);
    }
    Some(out)
}

#[cfg(test)]
mod crop_tests {
    use super::*;

    fn synth_frame(w: u32, h: u32, stride: usize) -> Vec<u8> {
        // Tag each pixel with its (x,y) so we can verify crop alignment.
        let mut buf = vec![0u8; stride * h as usize];
        for y in 0..h {
            for x in 0..w {
                let base = (y as usize) * stride + (x as usize) * 4;
                buf[base] = (x & 0xff) as u8; // B
                buf[base + 1] = (y & 0xff) as u8; // G
                buf[base + 2] = ((x >> 8) & 0xff) as u8; // R
                buf[base + 3] = 0xff; // A
            }
        }
        buf
    }

    #[test]
    fn crop_1x1_returns_exactly_4_bytes_matching_source() {
        let src = synth_frame(10, 10, 40);
        let rect = PhysicalRectU32 { x: 3, y: 5, w: 1, h: 1 };
        let out = cpu_crop_bgra(&src, 10, 10, 40, rect).expect("crop ok");
        assert_eq!(out.len(), 4);
        assert_eq!(out[0], 3);
        assert_eq!(out[1], 5);
    }

    #[test]
    fn crop_at_origin_full_width_matches_source_row() {
        let src = synth_frame(8, 4, 32);
        let rect = PhysicalRectU32 { x: 0, y: 0, w: 8, h: 4 };
        let out = cpu_crop_bgra(&src, 8, 4, 32, rect).expect("crop ok");
        assert_eq!(out.len(), 32 * 4);
        assert_eq!(out, src);
    }

    #[test]
    fn crop_with_padded_stride_skips_padding() {
        // 1920×1080 @ stride = 1920*4 + 64 padding bytes per row
        let src_stride = 1920 * 4 + 64;
        let src = synth_frame(1920, 1080, src_stride);
        let rect = PhysicalRectU32 { x: 100, y: 100, w: 640, h: 480 };
        let out = cpu_crop_bgra(&src, 1920, 1080, src_stride, rect).expect("crop ok");
        assert_eq!(out.len(), 640 * 480 * 4);
        // Spot-check: pixel (0,0) of output should be source (100,100).
        assert_eq!(out[0], 100); // B = src x
        assert_eq!(out[1], 100); // G = src y
        // Last-row-last-pixel: out should be src (100+639, 100+479) = (739, 579).
        let last = out.len() - 4;
        assert_eq!(out[last], (739 & 0xff) as u8);
        assert_eq!(out[last + 1], (579 & 0xff) as u8);
        assert_eq!(out[last + 2], ((739 >> 8) & 0xff) as u8);
    }

    #[test]
    fn crop_overflow_returns_none() {
        let src = synth_frame(10, 10, 40);
        let rect = PhysicalRectU32 { x: 5, y: 5, w: 10, h: 10 };
        assert!(cpu_crop_bgra(&src, 10, 10, 40, rect).is_none());
    }

    #[test]
    fn crop_zero_size_returns_none() {
        let src = synth_frame(10, 10, 40);
        let rect = PhysicalRectU32 { x: 0, y: 0, w: 0, h: 10 };
        assert!(cpu_crop_bgra(&src, 10, 10, 40, rect).is_none());
    }
}

/// Convert a live `windows_capture::frame::Frame` into our `Frame` by
/// copying the BGRA buffer out of the D3D11 staging texture.
///
/// `start_epoch` is the wall-clock instant the capture session started;
/// we use `elapsed()` as the PTS because `windows-capture`'s
/// `frame.timestamp()` returns a `TimeSpan` in the QPC domain — Phase 1's
/// clock-source plumbing would need an extra conversion to map QPC ticks
/// to i128 ns. For Plan 05-03 we use `ClockSource::Synthetic` (host-derived)
/// which is what the xcap fallback already reports; a follow-up can swap
/// to true-QPC once the encoder agrees.
pub fn to_frame(frame: &mut WgcFrame, start_epoch: Instant) -> Result<Frame, CaptureError> {
    let width_px = frame.width();
    let height_px = frame.height();
    let color_format = frame.color_format();

    let buffer = frame
        .buffer()
        .map_err(|e| CaptureError::Native(format!("WGC Frame::buffer: {e}")))?;

    // WGC returns BGRA8 when we set ColorFormat::Bgra8 in Settings. If the
    // user somehow ended up with Rgba8 we swap channels to match our Frame
    // convention (encoder expects BGRA).
    let stride = (width_px as usize) * 4;
    let mut bgra = vec![0u8; stride * height_px as usize];
    let bgra_base = bgra.as_ptr();
    let copied = buffer.as_nopadding_buffer(&mut bgra);
    let same_buffer = std::ptr::eq(bgra_base, copied.as_ptr());
    let copied_len = copied.len();
    let bgra_vec: Vec<u8> = if same_buffer {
        bgra.truncate(copied_len);
        bgra
    } else {
        copied.to_vec()
    };

    // Rgba8 → Bgra8 swap if needed (MSFT default is Rgba8; we request Bgra8
    // in Settings::new, but defend against drift).
    let final_bgra = match color_format {
        ColorFormat::Bgra8 => bgra_vec,
        ColorFormat::Rgba8 => {
            let mut v = bgra_vec;
            for px in v.chunks_exact_mut(4) {
                px.swap(0, 2);
            }
            v
        }
        ColorFormat::Rgba16F => {
            return Err(CaptureError::Backend(
                "Rgba16F from WGC not yet supported".into(),
            ));
        }
    };

    let sequence = frame::next_sequence();
    let pts = Pts {
        ns: start_epoch.elapsed().as_nanos() as i128,
        source: ClockSource::Synthetic,
    };
    Ok(Frame {
        pts,
        width_px,
        height_px,
        format: PixelFormat::Bgra,
        data: FrameData::Owned(final_bgra, stride),
        sequence,
    })
}
