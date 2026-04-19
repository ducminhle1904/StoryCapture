//! Callout-box PNG rendering + FFmpeg overlay emission.
//!
//! A callout is a rounded rectangle filled with `bg`, optionally
//! outlined with `border`, with `text` drawn at approximate centre, and
//! an optional arrow triangle pointing at the annotated element.
//!
//! We do NOT embed a TTF glyph rasteriser here — full text shaping
//! would pull in `ab_glyph` + `imageproc`. Instead, we approximate text
//! bounds from character count and font size (`advance ≈ 0.55 * size_pt
//! pixels, height ≈ 1.2 * size_pt`). FFmpeg's `drawtext` is still the
//! source of truth for the actual pixels the viewer sees — the PNG
//! just establishes a correctly-sized box. Plan 12 (preview UI) can
//! refine with a real glyph rasteriser when budgeting allows.

use std::path::Path;

use image::{ImageBuffer, Rgba as ImageRgba};

use crate::ast::types::{Rgba, Vec2};
use crate::ast::video::FontChoice;
use crate::error::Result;

/// Optional arrow direction on a callout box.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArrowDir {
    Up,
    Down,
    Left,
    Right,
}

/// Static description of a callout — text, typography, fill, border,
/// corner radius and optional arrow.
#[derive(Debug, Clone)]
pub struct CalloutSpec {
    pub text: String,
    pub size_pt: f32,
    pub font: FontChoice,
    pub fg: Rgba,
    pub bg: Rgba,
    pub border: Option<Rgba>,
    pub padding_px: u32,
    pub radius_px: u32,
    pub arrow: Option<ArrowDir>,
}

/// Heuristic text extent (width, height) in pixels for a string of
/// `len` characters at `size_pt` points. Good enough for PNG sizing
/// when the actual pixels come from FFmpeg drawtext.
fn approx_text_extent(text: &str, size_pt: f32) -> (u32, u32) {
    let cols = text.chars().count() as f32;
    let w = (cols * size_pt * 0.55).ceil() as u32;
    let h = (size_pt * 1.2).ceil() as u32;
    (w.max(1), h.max(1))
}

const ARROW_STRIP: u32 = 16;

fn to_image_rgba(c: Rgba) -> ImageRgba<u8> {
    ImageRgba([c.r, c.g, c.b, c.a])
}

/// Render a callout to `out` as a PNG. Returns `(width, height)` of the
/// emitted bitmap.
pub fn render_callout_png(spec: &CalloutSpec, out: &Path) -> Result<(u32, u32)> {
    let (tw, th) = approx_text_extent(&spec.text, spec.size_pt);
    let pad = spec.padding_px;
    let rect_w = tw + 2 * pad;
    let rect_h = th + 2 * pad;

    // Reserve an extra strip for the arrow triangle.
    let (total_w, total_h, rect_y0, arrow_y0, _arrow_y1) = match spec.arrow {
        Some(ArrowDir::Down) => (
            rect_w,
            rect_h + ARROW_STRIP,
            0,
            rect_h,
            rect_h + ARROW_STRIP,
        ),
        Some(ArrowDir::Up) => (rect_w, rect_h + ARROW_STRIP, ARROW_STRIP, 0, ARROW_STRIP),
        Some(ArrowDir::Left) | Some(ArrowDir::Right) => (rect_w + ARROW_STRIP, rect_h, 0, 0, 0),
        None => (rect_w, rect_h, 0, 0, 0),
    };

    let mut img: ImageBuffer<ImageRgba<u8>, Vec<u8>> =
        ImageBuffer::from_pixel(total_w, total_h, ImageRgba([0, 0, 0, 0]));
    let fill = to_image_rgba(spec.bg);
    let border = spec.border.map(to_image_rgba);

    let r = spec.radius_px.min(rect_w.min(rect_h) / 2);
    let x0 = if matches!(spec.arrow, Some(ArrowDir::Left)) {
        ARROW_STRIP
    } else {
        0
    };
    let y0 = rect_y0;
    let x1 = x0 + rect_w;
    let y1 = y0 + rect_h;

    // Fill rounded rectangle via per-pixel test.
    for py in y0..y1 {
        for px in x0..x1 {
            if inside_rounded_rect(px, py, x0, y0, x1, y1, r) {
                img.put_pixel(px, py, fill);
            }
        }
    }
    // Border: 1px perimeter via hollow test.
    if let Some(b) = border {
        for py in y0..y1 {
            for px in x0..x1 {
                if on_rounded_border(px, py, x0, y0, x1, y1, r) {
                    img.put_pixel(px, py, b);
                }
            }
        }
    }

    // Arrow triangle — a simple isoceles strip.
    if let Some(dir) = spec.arrow {
        draw_arrow(&mut img, dir, rect_w, rect_h, rect_y0, arrow_y0, fill);
    }

    img.save(out)
        .map_err(|e| crate::error::EffectsError::ImageDecode(e.to_string()))?;
    Ok((total_w, total_h))
}

fn inside_rounded_rect(px: u32, py: u32, x0: u32, y0: u32, x1: u32, y1: u32, r: u32) -> bool {
    if r == 0 {
        return true;
    }
    let (px, py) = (px as i64, py as i64);
    let (x0, y0, x1, y1, r) = (x0 as i64, y0 as i64, x1 as i64, y1 as i64, r as i64);
    // Check corner regions.
    let within_core_h = px >= x0 + r && px < x1 - r;
    let within_core_v = py >= y0 + r && py < y1 - r;
    if within_core_h || within_core_v {
        return true;
    }
    // Determine nearest corner centre.
    let cx = if px < x0 + r { x0 + r } else { x1 - r - 1 };
    let cy = if py < y0 + r { y0 + r } else { y1 - r - 1 };
    let dx = px - cx;
    let dy = py - cy;
    dx * dx + dy * dy <= r * r
}

fn on_rounded_border(px: u32, py: u32, x0: u32, y0: u32, x1: u32, y1: u32, r: u32) -> bool {
    if !inside_rounded_rect(px, py, x0, y0, x1, y1, r) {
        return false;
    }
    // A pixel is on the border if any 4-neighbour is OUTSIDE the shape.
    let n: i64 = 1;
    let test = |dx: i64, dy: i64| -> bool {
        let x = px as i64 + dx;
        let y = py as i64 + dy;
        if x < x0 as i64 || x >= x1 as i64 || y < y0 as i64 || y >= y1 as i64 {
            return true;
        }
        !inside_rounded_rect(x as u32, y as u32, x0, y0, x1, y1, r)
    };
    test(n, 0) || test(-n, 0) || test(0, n) || test(0, -n)
}

fn draw_arrow(
    img: &mut ImageBuffer<ImageRgba<u8>, Vec<u8>>,
    dir: ArrowDir,
    rect_w: u32,
    rect_h: u32,
    rect_y0: u32,
    arrow_y0: u32,
    fill: ImageRgba<u8>,
) {
    let strip = ARROW_STRIP;
    match dir {
        ArrowDir::Down => {
            // Triangle below the rect, apex pointing down.
            let cx = rect_w / 2;
            for row in 0..strip {
                let half = strip - row; // widest at top, narrow at apex
                let y = arrow_y0 + row;
                let x_lo = cx.saturating_sub(half);
                let x_hi = (cx + half).min(rect_w);
                for px in x_lo..x_hi {
                    img.put_pixel(px, y, fill);
                }
            }
        }
        ArrowDir::Up => {
            let cx = rect_w / 2;
            for row in 0..strip {
                let half = row + 1;
                let y = arrow_y0 + (strip - 1 - row);
                let x_lo = cx.saturating_sub(half);
                let x_hi = (cx + half).min(rect_w);
                for px in x_lo..x_hi {
                    img.put_pixel(px, y, fill);
                }
            }
        }
        ArrowDir::Left | ArrowDir::Right => {
            // Horizontal arrow strip; keep it simple — single triangle.
            let cy = rect_y0 + rect_h / 2;
            for col in 0..strip {
                let half = if matches!(dir, ArrowDir::Left) {
                    col + 1
                } else {
                    strip - col
                };
                let x = match dir {
                    ArrowDir::Left => col,
                    _ => rect_w + col,
                };
                let y_lo = cy.saturating_sub(half);
                let y_hi = cy + half;
                for py in y_lo..y_hi {
                    img.put_pixel(x, py, fill);
                }
            }
        }
    }
}

/// Emit the FFmpeg overlay stage for a callout PNG.
pub fn emit_callout_overlay(
    _callout_png: &Path,
    pos: Vec2,
    t_start_ms: u64,
    t_end_ms: u64,
    in_label: &str,
    overlay_input_idx: usize,
    out_label: &str,
) -> String {
    format!(
        "{in_label}[{idx}:v]overlay=x={x}:y={y}:enable='between(t,{s:.3},{e:.3})'{out}",
        in_label = in_label,
        idx = overlay_input_idx,
        x = pos.x as i32,
        y = pos.y as i32,
        s = t_start_ms as f64 / 1000.0,
        e = t_end_ms as f64 / 1000.0,
        out = out_label,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn spec() -> CalloutSpec {
        CalloutSpec {
            text: "Click Save".into(),
            size_pt: 24.0,
            font: FontChoice::SystemDefault,
            fg: Rgba::new(240, 240, 240, 255),
            bg: Rgba::new(20, 20, 20, 230),
            border: None,
            padding_px: 16,
            radius_px: 12,
            arrow: None,
        }
    }

    #[test]
    fn rounded_rect_meets_minimum_size() {
        let t = tempdir().unwrap();
        let p = t.path().join("c.png");
        let (w, h) = render_callout_png(&spec(), &p).unwrap();
        let (tw, th) = approx_text_extent("Click Save", 24.0);
        assert!(w >= tw + 32, "w={} tw={}", w, tw);
        assert!(h >= th + 32, "h={} th={}", h, th);
        assert!(p.exists());
    }

    #[test]
    fn arrow_down_adds_strip() {
        let t = tempdir().unwrap();
        let p = t.path().join("c.png");
        let base = spec();
        let (_bw, base_h) = approx_text_extent(&base.text, base.size_pt);
        let mut with_arrow = base.clone();
        with_arrow.arrow = Some(ArrowDir::Down);
        let (_w, h) = render_callout_png(&with_arrow, &p).unwrap();
        // Total height grew by ARROW_STRIP.
        assert!(h >= base_h + 32 + ARROW_STRIP);
    }
}
