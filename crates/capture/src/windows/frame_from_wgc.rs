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
use crate::frame::{ClockSource, Frame, FrameData, PixelFormat, Pts};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;
use windows_capture::frame::Frame as WgcFrame;
use windows_capture::settings::ColorFormat;

/// Monotonic sequence counter, shared across WGC backend instances in the
/// same process. Matches the macOS `frame_from_sample` pattern so the UI's
/// HUD never sees a sequence regression across back-to-back sessions.
static SEQUENCE: AtomicU64 = AtomicU64::new(0);

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
    // Copy without padding to match stride = width*4.
    let copied = buffer.as_nopadding_buffer(&mut bgra);
    // `as_nopadding_buffer` may return a reference into our buffer or into
    // the raw buffer (when no padding). Normalize to an owned Vec.
    let bgra_vec: Vec<u8> = copied.to_vec();

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

    let sequence = SEQUENCE.fetch_add(1, Ordering::AcqRel);
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
