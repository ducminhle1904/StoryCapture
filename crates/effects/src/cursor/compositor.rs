//! Frame compositor: paint a transparent canvas with active ripples + the
//! cursor skin positioned at `sample.pos`.
//!
//! The output is an `RgbaImage` the caller saves as a PNG. Alpha-compositing
//! uses straight "over" blending.

use image::{ImageBuffer, Rgba as ImageRgba, RgbaImage};

use crate::ast::video::RippleEvent;

use super::skins::SkinBitmap;
use super::trajectory::CursorSample;

/// Composite one frame: transparent canvas → ripples (radial rings) → cursor
/// skin anchored at `sample.pos`.
///
/// `ripples_at_t` is a pre-filtered list of `(event, alpha, radius)` from
/// [`crate::cursor::ripple::ripple_alpha`] / [`crate::cursor::ripple::ripple_radius`].
pub fn compose_frame(
    canvas_w: u32,
    canvas_h: u32,
    sample: &CursorSample,
    skin: &SkinBitmap,
    ripples_at_t: &[(RippleEvent, f32, f32)],
) -> RgbaImage {
    // Fully transparent canvas.
    let mut canvas: RgbaImage =
        ImageBuffer::from_pixel(canvas_w, canvas_h, ImageRgba([0, 0, 0, 0]));

    // --- Ripples (drawn first so the cursor sits on top).
    for (event, alpha, radius) in ripples_at_t {
        if *alpha <= 0.0 || *radius <= 0.0 {
            continue;
        }
        draw_ripple(&mut canvas, event, *alpha, *radius);
    }

    // --- Cursor skin centred on sample.pos (hotspot = top-left corner for
    //     arrow-style cursors; see assets/cursor-skins/README.md).
    let sx = sample.pos.x.round() as i32;
    let sy = sample.pos.y.round() as i32;
    blit_over(&mut canvas, &skin.pixels, sx, sy);

    canvas
}

/// Draw a ripple as a 1-pixel ring at `radius` with given `alpha`. Kept
/// deliberately simple (bounding-box scan + distance test) — good enough for
/// a 60px radius on 1080p and portable across targets.
fn draw_ripple(canvas: &mut RgbaImage, event: &RippleEvent, alpha: f32, radius: f32) {
    let (cw, ch) = (canvas.width() as i32, canvas.height() as i32);
    let cx = event.center.x;
    let cy = event.center.y;
    let r = radius;
    let r_inner = (r - 1.5).max(0.0);
    let r_outer = r + 1.0;

    let x_min = ((cx - r_outer).floor() as i32).max(0);
    let y_min = ((cy - r_outer).floor() as i32).max(0);
    let x_max = ((cx + r_outer).ceil() as i32).min(cw - 1);
    let y_max = ((cy + r_outer).ceil() as i32).min(ch - 1);

    let base_r = event.color.r;
    let base_g = event.color.g;
    let base_b = event.color.b;
    let ring_alpha_u8 = (alpha.clamp(0.0, 1.0) * 255.0).round() as u8;
    if ring_alpha_u8 == 0 {
        return;
    }

    for y in y_min..=y_max {
        for x in x_min..=x_max {
            let dx = x as f32 - cx;
            let dy = y as f32 - cy;
            let d = (dx * dx + dy * dy).sqrt();
            if d >= r_inner && d <= r_outer {
                // Anti-aliased edge falloff.
                let edge = 1.0 - ((d - r).abs() / 1.5).clamp(0.0, 1.0);
                let ring_a = (ring_alpha_u8 as f32 * edge).round() as u8;
                over(
                    canvas.get_pixel_mut(x as u32, y as u32),
                    ImageRgba([base_r, base_g, base_b, ring_a]),
                );
            }
        }
    }
}

fn blit_over(canvas: &mut RgbaImage, src: &RgbaImage, dst_x: i32, dst_y: i32) {
    let (cw, ch) = (canvas.width() as i32, canvas.height() as i32);
    for sy in 0..src.height() as i32 {
        let ty = dst_y + sy;
        if ty < 0 || ty >= ch {
            continue;
        }
        for sx in 0..src.width() as i32 {
            let tx = dst_x + sx;
            if tx < 0 || tx >= cw {
                continue;
            }
            let sp = *src.get_pixel(sx as u32, sy as u32);
            if sp.0[3] == 0 {
                continue;
            }
            over(canvas.get_pixel_mut(tx as u32, ty as u32), sp);
        }
    }
}

#[inline]
fn over(dst: &mut ImageRgba<u8>, src: ImageRgba<u8>) {
    let sa = src.0[3] as f32 / 255.0;
    let da = dst.0[3] as f32 / 255.0;
    let out_a = sa + da * (1.0 - sa);
    if out_a <= 0.0 {
        *dst = ImageRgba([0, 0, 0, 0]);
        return;
    }
    let blend = |s: u8, d: u8| -> u8 {
        let sf = s as f32;
        let df = d as f32;
        ((sf * sa + df * da * (1.0 - sa)) / out_a)
            .round()
            .clamp(0.0, 255.0) as u8
    };
    *dst = ImageRgba([
        blend(src.0[0], dst.0[0]),
        blend(src.0[1], dst.0[1]),
        blend(src.0[2], dst.0[2]),
        (out_a * 255.0).round().clamp(0.0, 255.0) as u8,
    ]);
}
