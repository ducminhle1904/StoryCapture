//! One-shot generator for the 10 bundled 1920x1080 gradient-preset PNGs.
//!
//! Usage: `cargo run -p effects --example gen_gradient_presets`
//!
//! Writes deterministic PNGs to `<repo>/assets/gradient-presets/*.png`. The
//! generator is pure (no system randomness); re-running produces byte-identical
//! PNGs.

use std::path::PathBuf;

use image::{ImageBuffer, Rgba, RgbaImage};

const W: u32 = 1920;
const H: u32 = 1080;

#[derive(Clone, Copy)]
enum Dir {
    Vertical,
    Diagonal,
}

fn lerp_u8(a: u8, b: u8, t: f32) -> u8 {
    let a = a as f32;
    let b = b as f32;
    (a + (b - a) * t).round().clamp(0.0, 255.0) as u8
}

fn gen_gradient(path: &std::path::Path, a: [u8; 4], b: [u8; 4], dir: Dir) {
    let mut img: RgbaImage = ImageBuffer::new(W, H);
    for y in 0..H {
        for x in 0..W {
            let t = match dir {
                Dir::Vertical => y as f32 / (H - 1) as f32,
                Dir::Diagonal => {
                    let num = x as f32 + y as f32;
                    let den = (W - 1) as f32 + (H - 1) as f32;
                    num / den
                }
            };
            let px = [
                lerp_u8(a[0], b[0], t),
                lerp_u8(a[1], b[1], t),
                lerp_u8(a[2], b[2], t),
                lerp_u8(a[3], b[3], t),
            ];
            img.put_pixel(x, y, Rgba(px));
        }
    }
    img.save(path).expect("save gradient png");
}

fn gen_solid(path: &std::path::Path, c: [u8; 4]) {
    let img: RgbaImage = ImageBuffer::from_pixel(W, H, Rgba(c));
    img.save(path).expect("save solid png");
}

// Deterministic Lehmer / LCG PRNG — no std::time / thread_rng usage so the
// paper-grain texture is byte-identical across runs.
fn lcg_next(state: &mut u32) -> u32 {
    *state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
    *state
}

fn gen_grain(path: &std::path::Path, base: [u8; 4], intensity: f32) {
    let mut img: RgbaImage = ImageBuffer::new(W, H);
    let mut rng: u32 = 0xC0FFEE_u32;
    for y in 0..H {
        for x in 0..W {
            let r = (lcg_next(&mut rng) as f32 / u32::MAX as f32) * 2.0 - 1.0;
            let delta = (r * 255.0 * intensity) as i32;
            let px = [
                (base[0] as i32 + delta).clamp(0, 255) as u8,
                (base[1] as i32 + delta).clamp(0, 255) as u8,
                (base[2] as i32 + delta).clamp(0, 255) as u8,
                base[3],
            ];
            img.put_pixel(x, y, Rgba(px));
        }
    }
    img.save(path).expect("save grain png");
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut out = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    out.pop(); // crates/effects -> crates
    out.pop(); // crates -> repo root
    out.push("assets");
    out.push("gradient-presets");
    std::fs::create_dir_all(&out)?;

    gen_gradient(
        &out.join("runway-dark.png"),
        [12, 12, 20, 255],
        [40, 16, 48, 255],
        Dir::Diagonal,
    );
    gen_gradient(
        &out.join("runway-light.png"),
        [240, 235, 230, 255],
        [255, 245, 235, 255],
        Dir::Vertical,
    );
    gen_gradient(
        &out.join("linear-slate.png"),
        [24, 28, 36, 255],
        [40, 48, 60, 255],
        Dir::Vertical,
    );
    gen_gradient(
        &out.join("elevenlabs-violet.png"),
        [22, 14, 44, 255],
        [80, 32, 120, 255],
        Dir::Diagonal,
    );
    gen_gradient(
        &out.join("warm-sunset.png"),
        [240, 120, 40, 255],
        [180, 40, 100, 255],
        Dir::Diagonal,
    );
    gen_gradient(
        &out.join("cool-ocean.png"),
        [20, 60, 120, 255],
        [40, 120, 180, 255],
        Dir::Vertical,
    );
    gen_gradient(
        &out.join("forest-emerald.png"),
        [16, 48, 32, 255],
        [40, 100, 60, 255],
        Dir::Vertical,
    );
    gen_solid(&out.join("solid-black.png"), [0, 0, 0, 255]);
    gen_solid(&out.join("solid-white.png"), [255, 255, 255, 255]);
    gen_grain(&out.join("paper-grain.png"), [240, 235, 225, 255], 0.05);

    println!("Wrote 10 gradient presets to {}", out.display());
    Ok(())
}
