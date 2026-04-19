//! One-shot generator for the 5 bundled cursor skin PNGs.
//!
//! Usage: `cargo run -p effects --example generate_cursor_skins`
//!
//! Writes to `<repo-root>/assets/cursor-skins/*.png` with deterministic
//! procedurally-drawn arrows so the distribution is self-contained.
//! Regenerate when skin art changes — the PNGs themselves are committed.

use std::path::PathBuf;

use image::{ImageBuffer, Rgba, RgbaImage};

const SIZE: u32 = 64;

fn arrow_mask() -> Vec<(u32, u32)> {
    // Classic macOS/Windows pointer shape: a right-leaning arrow whose tip is
    // at (0, 0). We render it onto a 64×64 canvas; the cursor's "hotspot" is
    // the top-left corner (consumers anchor skins at sample.pos directly).
    //
    // Generate by filling a polygon defined by integer vertices.
    let vertices: [(i32, i32); 7] = [
        (2, 2),
        (2, 44),
        (14, 34),
        (20, 50),
        (28, 46),
        (22, 30),
        (36, 28),
    ];
    let mut out = Vec::new();
    for y in 0..SIZE as i32 {
        for x in 0..SIZE as i32 {
            if point_in_polygon(x, y, &vertices) {
                out.push((x as u32, y as u32));
            }
        }
    }
    out
}

fn point_in_polygon(x: i32, y: i32, poly: &[(i32, i32)]) -> bool {
    let n = poly.len();
    let mut inside = false;
    let mut j = n - 1;
    for i in 0..n {
        let (xi, yi) = (poly[i].0 as f32, poly[i].1 as f32);
        let (xj, yj) = (poly[j].0 as f32, poly[j].1 as f32);
        let (fx, fy) = (x as f32 + 0.5, y as f32 + 0.5);
        if (yi > fy) != (yj > fy) && fx < (xj - xi) * (fy - yi) / (yj - yi + 1e-9) + xi {
            inside = !inside;
        }
        j = i;
    }
    inside
}

fn render(fill: [u8; 4], outline: [u8; 4], scale: f32) -> RgbaImage {
    let mask = arrow_mask();
    let mut img: RgbaImage = ImageBuffer::from_pixel(SIZE, SIZE, Rgba([0, 0, 0, 0]));

    // Fill
    for (x, y) in &mask {
        img.put_pixel(*x, *y, Rgba(fill));
    }

    // Outline: any transparent pixel adjacent to a filled one becomes outline.
    let mut outline_pixels = Vec::new();
    for y in 0..SIZE as i32 {
        for x in 0..SIZE as i32 {
            if img.get_pixel(x as u32, y as u32).0[3] != 0 {
                continue;
            }
            let mut touches = false;
            'adj: for dy in -1..=1i32 {
                for dx in -1..=1i32 {
                    let nx = x + dx;
                    let ny = y + dy;
                    if nx < 0 || ny < 0 || nx >= SIZE as i32 || ny >= SIZE as i32 {
                        continue;
                    }
                    if img.get_pixel(nx as u32, ny as u32).0[3] != 0 {
                        touches = true;
                        break 'adj;
                    }
                }
            }
            if touches {
                outline_pixels.push((x as u32, y as u32));
            }
        }
    }
    for (x, y) in outline_pixels {
        img.put_pixel(x, y, Rgba(outline));
    }

    if (scale - 1.0).abs() < 1e-3 {
        return img;
    }
    let nw = ((SIZE as f32) * scale).round() as u32;
    let nh = ((SIZE as f32) * scale).round() as u32;
    image::imageops::resize(&img, nw, nh, image::imageops::FilterType::Triangle)
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut out_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    out_dir.pop(); // crates/effects -> crates
    out_dir.pop(); // crates -> repo root
    out_dir.push("assets");
    out_dir.push("cursor-skins");
    std::fs::create_dir_all(&out_dir)?;

    // mac-default: black fill, white outline (classic macOS pointer).
    render([0, 0, 0, 255], [255, 255, 255, 255], 1.0).save(out_dir.join("mac-default.png"))?;

    // win-default: same silhouette, slightly lighter fill to read as "thinner"
    // on light backgrounds.
    render([20, 20, 20, 255], [240, 240, 240, 255], 1.0).save(out_dir.join("win-default.png"))?;

    // dark: pure black fill on a mid-grey outline (for dark backgrounds).
    render([0, 0, 0, 255], [160, 160, 160, 255], 1.0).save(out_dir.join("dark.png"))?;

    // light: white fill on black outline (inverted, for light backgrounds).
    render([255, 255, 255, 255], [20, 20, 20, 255], 1.0).save(out_dir.join("light.png"))?;

    // big-arrow: 2× scaled arrow for presentation mode.
    render([0, 0, 0, 255], [255, 255, 255, 255], 2.0).save(out_dir.join("big-arrow.png"))?;

    println!("Wrote 5 cursor skins to {}", out_dir.display());
    Ok(())
}
