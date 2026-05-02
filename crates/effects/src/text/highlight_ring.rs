//! Highlight PNG rendering for export overlays.
//!
//! Ring highlights emit small transparent PNGs around the target. Spotlight
//! highlights emit a full-frame dim layer with a soft cutout plus ring.

use std::path::Path;

use image::{ImageBuffer, Rgba as ImageRgba};

use crate::ast::types::{Rgba, Vec2};
use crate::ast::video::{HighlightBounds, HighlightOverlaySpec, HighlightShape};
use crate::error::Result;

#[derive(Debug, Clone, Copy)]
pub struct RingSpec {
    pub bbox_w: u32,
    pub bbox_h: u32,
    pub stroke_px: u32,
    pub color: Rgba,
    pub rounded_radius_px: u32,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct HighlightRenderResult {
    pub width: u32,
    pub height: u32,
    pub overlay_pos: Vec2,
}

fn to_image_rgba(c: Rgba) -> ImageRgba<u8> {
    ImageRgba([c.r, c.g, c.b, c.a])
}

/// Render a highlight ring to `out` as a transparent PNG with the
/// perimeter stroked. Returns `(width, height)` of the emitted bitmap.
///
/// The PNG is inflated by `stroke_px` on each side so the stroke lands
/// outside the element's actual bbox (halo effect), never clipping the
/// UI beneath.
pub fn render_highlight_ring_png(spec: &RingSpec, out: &Path) -> Result<(u32, u32)> {
    let pad = spec.stroke_px.max(1);
    let total_w = spec.bbox_w + 2 * pad;
    let total_h = spec.bbox_h + 2 * pad;
    let mut img: ImageBuffer<ImageRgba<u8>, Vec<u8>> =
        ImageBuffer::from_pixel(total_w, total_h, ImageRgba([0, 0, 0, 0]));
    let colour = to_image_rgba(spec.color);

    let x0 = pad;
    let y0 = pad;
    let x1 = x0 + spec.bbox_w;
    let y1 = y0 + spec.bbox_h;
    let r = spec.rounded_radius_px.min(spec.bbox_w.min(spec.bbox_h) / 2);
    let stroke = spec.stroke_px.max(1);

    for py in y0.saturating_sub(stroke)..(y1 + stroke).min(total_h) {
        for px in x0.saturating_sub(stroke)..(x1 + stroke).min(total_w) {
            if on_rounded_border(px, py, x0, y0, x1, y1, r, stroke) {
                img.put_pixel(px, py, colour);
            }
        }
    }

    img.save(out)
        .map_err(|e| crate::error::EffectsError::ImageDecode(e.to_string()))?;
    Ok((total_w, total_h))
}

pub fn render_highlight_overlay_png(
    spec: &HighlightOverlaySpec,
    output_w: u32,
    output_h: u32,
    out: &Path,
) -> Result<HighlightRenderResult> {
    match spec.shape {
        HighlightShape::Ring => render_ring_overlay_png(spec, output_w, output_h, out),
        HighlightShape::Spotlight => render_spotlight_overlay_png(spec, output_w, output_h, out),
    }
}

fn render_ring_overlay_png(
    spec: &HighlightOverlaySpec,
    output_w: u32,
    output_h: u32,
    out: &Path,
) -> Result<HighlightRenderResult> {
    let target = target_bounds(spec, output_w, output_h);
    let pad = spec.padding_px.max(0.0);
    let glow = spec.glow_px.max(0.0);
    let inflate = pad + glow + spec.stroke_px.max(1.0);
    let x = (target.x - inflate).floor().max(0.0);
    let y = (target.y - inflate).floor().max(0.0);
    let right = (target.x + target.w + inflate).ceil().min(output_w as f32);
    let bottom = (target.y + target.h + inflate).ceil().min(output_h as f32);
    let w = (right - x).max(1.0).round() as u32;
    let h = (bottom - y).max(1.0).round() as u32;
    let local = HighlightBounds {
        x: target.x - x + pad,
        y: target.y - y + pad,
        w: (target.w - pad * 2.0).max(1.0),
        h: (target.h - pad * 2.0).max(1.0),
    };
    let mut img: ImageBuffer<ImageRgba<u8>, Vec<u8>> =
        ImageBuffer::from_pixel(w, h, ImageRgba([0, 0, 0, 0]));
    paint_ring(&mut img, local, spec);
    img.save(out)
        .map_err(|e| crate::error::EffectsError::ImageDecode(e.to_string()))?;
    Ok(HighlightRenderResult {
        width: w,
        height: h,
        overlay_pos: Vec2::new(x, y),
    })
}

fn render_spotlight_overlay_png(
    spec: &HighlightOverlaySpec,
    output_w: u32,
    output_h: u32,
    out: &Path,
) -> Result<HighlightRenderResult> {
    let target = target_bounds(spec, output_w, output_h);
    let dim_alpha = (138.0 * spec.opacity.clamp(0.0, 1.0)).round() as u8;
    let mut img: ImageBuffer<ImageRgba<u8>, Vec<u8>> =
        ImageBuffer::from_pixel(output_w, output_h, ImageRgba([0, 0, 0, dim_alpha]));
    let feather = spec.glow_px.max(12.0);
    let radius = spec.radius_px.max(1.0);
    for py in 0..output_h {
        for px in 0..output_w {
            let sd = rounded_rect_signed_distance(px as f32 + 0.5, py as f32 + 0.5, target, radius);
            if sd <= 0.0 {
                img.put_pixel(px, py, ImageRgba([0, 0, 0, 0]));
            } else if sd < feather {
                let alpha = ((sd / feather) * dim_alpha as f32).round() as u8;
                img.put_pixel(px, py, ImageRgba([0, 0, 0, alpha]));
            }
        }
    }
    paint_ring(&mut img, target, spec);
    img.save(out)
        .map_err(|e| crate::error::EffectsError::ImageDecode(e.to_string()))?;
    Ok(HighlightRenderResult {
        width: output_w,
        height: output_h,
        overlay_pos: Vec2::ZERO,
    })
}

fn target_bounds(spec: &HighlightOverlaySpec, output_w: u32, output_h: u32) -> HighlightBounds {
    let raw = spec.bounds.unwrap_or_else(|| {
        let r = spec.max_radius_px.max(1.0);
        HighlightBounds {
            x: spec.center.x - r,
            y: spec.center.y - r,
            w: r * 2.0,
            h: r * 2.0,
        }
    });
    let pad = spec.padding_px.max(0.0);
    let x = (raw.x - pad).max(0.0);
    let y = (raw.y - pad).max(0.0);
    let right = (raw.x + raw.w + pad).min(output_w as f32);
    let bottom = (raw.y + raw.h + pad).min(output_h as f32);
    HighlightBounds {
        x,
        y,
        w: (right - x).max(1.0),
        h: (bottom - y).max(1.0),
    }
}

fn paint_ring(
    img: &mut ImageBuffer<ImageRgba<u8>, Vec<u8>>,
    target: HighlightBounds,
    spec: &HighlightOverlaySpec,
) {
    let color = spec.color;
    let opacity = spec.opacity.clamp(0.0, 1.0);
    let stroke = spec.stroke_px.max(1.0);
    let glow = spec.glow_px.max(0.0);
    let radius = spec.radius_px.max(1.0).min(target.w.min(target.h) / 2.0);
    for py in 0..img.height() {
        for px in 0..img.width() {
            let sd = rounded_rect_signed_distance(px as f32 + 0.5, py as f32 + 0.5, target, radius);
            let stroke_alpha: f32 = if sd.abs() <= stroke / 2.0 { 1.0 } else { 0.0 };
            let glow_alpha = if glow > 0.0 && sd > stroke / 2.0 && sd <= glow {
                (1.0 - (sd - stroke / 2.0) / glow) * 0.28
            } else {
                0.0
            };
            let alpha = ((stroke_alpha.max(glow_alpha) * opacity * color.a as f32)
                .round()
                .clamp(0.0, 255.0)) as u8;
            if alpha > 0 {
                blend_pixel(img, px, py, ImageRgba([color.r, color.g, color.b, alpha]));
            }
        }
    }
}

fn rounded_rect_signed_distance(px: f32, py: f32, b: HighlightBounds, r: f32) -> f32 {
    let cx = b.x + b.w / 2.0;
    let cy = b.y + b.h / 2.0;
    let qx = (px - cx).abs() - (b.w / 2.0 - r).max(0.0);
    let qy = (py - cy).abs() - (b.h / 2.0 - r).max(0.0);
    let outside_x = qx.max(0.0);
    let outside_y = qy.max(0.0);
    let outside = (outside_x * outside_x + outside_y * outside_y).sqrt();
    let inside = qx.max(qy).min(0.0);
    outside + inside - r
}

fn blend_pixel(
    img: &mut ImageBuffer<ImageRgba<u8>, Vec<u8>>,
    px: u32,
    py: u32,
    src: ImageRgba<u8>,
) {
    let dst = *img.get_pixel(px, py);
    let sa = src[3] as f32 / 255.0;
    let da = dst[3] as f32 / 255.0;
    let out_a = sa + da * (1.0 - sa);
    if out_a <= 0.0 {
        return;
    }
    let blend = |s: u8, d: u8| -> u8 {
        (((s as f32 * sa + d as f32 * da * (1.0 - sa)) / out_a)
            .round()
            .clamp(0.0, 255.0)) as u8
    };
    img.put_pixel(
        px,
        py,
        ImageRgba([
            blend(src[0], dst[0]),
            blend(src[1], dst[1]),
            blend(src[2], dst[2]),
            (out_a * 255.0).round() as u8,
        ]),
    );
}

fn on_rounded_border(
    px: u32,
    py: u32,
    x0: u32,
    y0: u32,
    x1: u32,
    y1: u32,
    r: u32,
    stroke: u32,
) -> bool {
    // Signed distance from the centre-line path of the rounded rect.
    let (px, py) = (px as f64 + 0.5, py as f64 + 0.5);
    let (x0, y0, x1, y1) = (x0 as f64, y0 as f64, x1 as f64, y1 as f64);
    let r = r as f64;
    let s = stroke as f64;

    // Project onto rounded-rect surface: clamp point to inner core, then
    // distance to that is the radial offset.
    let cx = px.clamp(x0 + r, x1 - r);
    let cy = py.clamp(y0 + r, y1 - r);
    // Distance from (px,py) to (cx,cy) adjusted for the corner radius:
    // if we are in a corner region, distance is from corner centre; in
    // the axis regions, it's the perpendicular distance.
    let ax = (cx - px).abs();
    let ay = (cy - py).abs();
    let dist = if ax > 0.0 && ay > 0.0 {
        // Corner — use distance from corner centre, subtract corner radius.
        (ax * ax + ay * ay).sqrt() - r
    } else if ax > 0.0 {
        ax - 0.0 // pure horizontal distance to core, then subtract 0 since axis regions are flat
    } else if ay > 0.0 {
        ay - 0.0
    } else {
        // Inside the core — negative signed distance = -min(dist-to-edge).
        let d_left = px - x0;
        let d_right = x1 - px;
        let d_top = py - y0;
        let d_bot = y1 - py;
        -d_left.min(d_right).min(d_top).min(d_bot)
    };
    dist.abs() <= s
}

/// Produce the FFmpeg alpha expression that pulses between 0.0 and 1.0
/// with period `period_s`, centred on `t_start_s`.
pub fn pulse_alpha_expr(t_start_s: f64, period_s: f64) -> String {
    format!(
        "0.5+0.5*sin(2*PI*(t-{t_start:.3})/{period:.3})",
        t_start = t_start_s,
        period = period_s
    )
}

pub fn emit_ring_overlay(
    _ring_png: &Path,
    bbox_xy: Vec2,
    t_start_ms: u64,
    t_end_ms: u64,
    period_s: f64,
    in_label: &str,
    input_idx: usize,
    out_label: &str,
) -> String {
    let alpha = pulse_alpha_expr(t_start_ms as f64 / 1000.0, period_s);
    format!(
        "{in_label}[{idx}:v]overlay=x={x}:y={y}:alpha='{alpha}':enable='between(t,{s:.3},{e:.3})'{out}",
        in_label = in_label,
        idx = input_idx,
        x = bbox_xy.x as i32,
        y = bbox_xy.y as i32,
        alpha = alpha,
        s = t_start_ms as f64 / 1000.0,
        e = t_end_ms as f64 / 1000.0,
        out = out_label,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn ring_dimensions() {
        let t = tempdir().unwrap();
        let p = t.path().join("ring.png");
        let (w, h) = render_highlight_ring_png(
            &RingSpec {
                bbox_w: 200,
                bbox_h: 100,
                stroke_px: 4,
                color: Rgba::new(0, 200, 255, 255),
                rounded_radius_px: 8,
            },
            &p,
        )
        .unwrap();
        assert_eq!(w, 208);
        assert_eq!(h, 108);
        assert!(p.exists());
    }

    #[test]
    fn pulse_expr_uses_sin_two_pi() {
        assert_eq!(
            pulse_alpha_expr(5.0, 1.0),
            "0.5+0.5*sin(2*PI*(t-5.000)/1.000)"
        );
    }
}
