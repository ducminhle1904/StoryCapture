//! CMSampleBuffer → Frame conversion (Plan 05-01, Task 1).
//!
//! Zero-copy: the CVPixelBuffer reference is retained via our
//! `CVPixelBufferHandle` RAII wrapper; the Frame carries it inside
//! `FrameData::NativeMacOS`. PTS is the CoreMedia presentation timestamp
//! converted to host-time nanoseconds (value * 1e9 / timescale). Sequence
//! numbers are a crate-local `AtomicU64` counter.

#![cfg(target_os = "macos")]

use crate::frame::{self, ClockSource, Frame, FrameData, PixelFormat, Pts};
use crate::macos::raii::CVPixelBufferHandle;
use screencapturekit::cm::CMSampleBuffer;

/// Convert one SCK-delivered sample buffer into a `Frame`. Returns `None`
/// if the sample has no backing pixel buffer (e.g. audio samples, which
/// our handler should never forward but the check is cheap).
pub fn to_frame(sample: &CMSampleBuffer) -> Option<Frame> {
    let pixel_buffer = sample.image_buffer()?;
    // Width/height are reported in native pixels by CoreVideo.
    let width_px = u32::try_from(pixel_buffer.width()).ok()?;
    let height_px = u32::try_from(pixel_buffer.height()).ok()?;
    if width_px == 0 || height_px == 0 {
        return None;
    }

    let pts_cm = sample.presentation_timestamp();
    // Manually compute nanoseconds. CMTime has no `to_nanos()` in 1.5.4;
    // the math is `value * 1e9 / timescale`, carrying through i128 to
    // avoid overflow on long captures.
    let pts_ns: i128 = if pts_cm.timescale == 0 {
        0
    } else {
        (pts_cm.value as i128) * 1_000_000_000i128 / (pts_cm.timescale as i128)
    };
    // One-time diagnostic: confirm SCK CMTime shape so downstream encoders
    // can trust pts_ns. Fires once per process via Relaxed CAS.
    {
        use std::sync::atomic::{AtomicBool, Ordering};
        static LOGGED: AtomicBool = AtomicBool::new(false);
        if !LOGGED.swap(true, Ordering::Relaxed) {
            tracing::info!(
                target: "storycapture::capture",
                cm_value = pts_cm.value,
                cm_timescale = pts_cm.timescale,
                pts_ns = pts_ns as i64,
                "SCK first frame CMTime"
            );
        }
    }

    // Retain the CVPixelBuffer via CFRetain; RAII releases when Frame drops.
    let handle = unsafe { CVPixelBufferHandle::retain(pixel_buffer.as_ptr() as *mut _) }?;

    Some(Frame {
        pts: Pts {
            ns: pts_ns,
            source: ClockSource::HostTime,
        },
        width_px,
        height_px,
        format: PixelFormat::Bgra,
        data: FrameData::NativeMacOS(handle),
        sequence: frame::next_sequence(),
    })
}

#[cfg(test)]
mod tests {
    use crate::frame;

    #[test]
    fn sequence_counter_is_monotonic() {
        frame::reset_sequence_for_test();
        let a = frame::next_sequence();
        let b = frame::next_sequence();
        assert_eq!(b, a + 1);
    }
}
