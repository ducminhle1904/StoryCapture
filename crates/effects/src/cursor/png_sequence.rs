//! Render trajectory + ripples to a PNG sequence on disk consumed by FFmpeg's
//! `overlay` filter (via `image2` input with `-framerate <fps> -i frame_%05d.png`).
//!
//! DoS note: 30 min × 60 fps = 108,000 frames. Caller must clean up the
//! output directory after encode and should cap trajectory length before
//! invoking this function.

use std::path::{Path, PathBuf};

use rayon::prelude::*;

use crate::ast::video::RippleEvent;
use crate::error::EffectsError;

use super::compositor::compose_frame;
use super::ripple::{ripple_alpha, ripple_radius};
use super::skins::SkinBitmap;
use super::trajectory::CursorSample;

/// Result metadata from a successful render.
#[derive(Debug, Clone)]
pub struct PngSequenceResult {
    pub dir: PathBuf,
    pub frame_count: u32,
    pub fps: u32,
    pub width: u32,
    pub height: u32,
}

/// Render `trajectory` + `ripples` into `out_dir` as `frame_00000.png`,
/// `frame_00001.png`, … (zero-padded to 5 digits).
///
/// Frames are rendered in parallel via rayon. The caller must clean up the
/// output directory when the render job completes (T-02-16).
pub fn render_png_sequence(
    trajectory: &[CursorSample],
    ripples: &[RippleEvent],
    skin: &SkinBitmap,
    out_dir: &Path,
    canvas_w: u32,
    canvas_h: u32,
    fps: u32,
) -> Result<PngSequenceResult, EffectsError> {
    std::fs::create_dir_all(out_dir)?;
    let frame_count = trajectory.len() as u32;

    trajectory
        .par_iter()
        .enumerate()
        .try_for_each(|(i, sample)| -> Result<(), EffectsError> {
            let t_ms = sample.t_ms;
            let ripple_state: Vec<(RippleEvent, f32, f32)> = ripples
                .iter()
                .filter_map(|r| {
                    let a = ripple_alpha(r, t_ms);
                    if a <= 0.0 {
                        return None;
                    }
                    Some((*r, a, ripple_radius(r, t_ms)))
                })
                .collect();
            let img = compose_frame(canvas_w, canvas_h, sample, skin, &ripple_state);
            let path = out_dir.join(format!("frame_{:05}.png", i));
            img.save(&path)
                .map_err(|e| EffectsError::Io(std::io::Error::new(std::io::ErrorKind::Other, e)))
        })?;

    Ok(PngSequenceResult {
        dir: out_dir.to_path_buf(),
        frame_count,
        fps,
        width: canvas_w,
        height: canvas_h,
    })
}
