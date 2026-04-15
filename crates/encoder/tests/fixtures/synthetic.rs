// Synthetic BGRA frame generator for encoder integration tests.
//
// Produces a deterministic moving-rectangle pattern so the output MP4
// is visually verifiable (handy when debugging A/V drift or frame-pump
// regressions). All frames use `FrameData::Owned` so `bgra_bytes_of_frame`
// works without platform-gated code.
//
// NOTE: included via `include!` into the `pipeline.rs` test binary; must
// NOT use `//!` module docs or `#![...]` inner attributes.

#[allow(dead_code)] // not every consumer uses every helper
const _FIXTURE_GUARD: () = ();

use capture::{ClockSource, Frame, FrameData, PixelFormat, Pts};

/// Generate `seconds * fps` BGRA frames, each `width * height * 4` bytes.
/// PTS is synthetic (monotonic, nanosecond step = 1e9 / fps).
pub fn generate_synthetic_frames(width: u32, height: u32, fps: u32, seconds: u32) -> Vec<Frame> {
    let total = (fps * seconds) as usize;
    let stride = (width * 4) as usize;
    let ns_per_frame = 1_000_000_000i128 / fps as i128;

    (0..total)
        .map(|i| {
            let mut buf = vec![0u8; stride * height as usize];
            // Draw a simple 64x64 moving rectangle so successive frames
            // differ; FFmpeg's inter-frame prediction will produce a
            // non-trivial output.
            let x = (i as u32 * 2) % width;
            let y = (i as u32) % height;
            for dy in 0..64.min(height.saturating_sub(y)) {
                for dx in 0..64.min(width.saturating_sub(x)) {
                    let px = (y + dy) as usize * stride + (x + dx) as usize * 4;
                    buf[px] = 0xFF; // B
                    buf[px + 1] = (i & 0xFF) as u8; // G
                    buf[px + 2] = 0x40; // R
                    buf[px + 3] = 0xFF; // A
                }
            }
            Frame {
                pts: Pts {
                    ns: i as i128 * ns_per_frame,
                    source: ClockSource::Synthetic,
                },
                width_px: width,
                height_px: height,
                format: PixelFormat::Bgra,
                data: FrameData::Owned(buf, stride),
                sequence: i as u64,
            }
        })
        .collect()
}
