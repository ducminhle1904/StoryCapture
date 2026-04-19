//! Bundled cursor skins (D-09).
//!
//! Five variants ship as PNG assets under `assets/cursor-skins/`. Users can
//! choose `size_scale` and `color_tint` but cannot upload custom skins in
//! Phase 2 (D-09).

use std::path::{Path, PathBuf};

use image::{ImageBuffer, Rgba as ImageRgba, RgbaImage};

use crate::ast::types::Rgba;
use crate::ast::video::CursorSkin;
use crate::error::EffectsError;

/// A loaded cursor skin bitmap (RGBA8).
#[derive(Debug, Clone)]
pub struct SkinBitmap {
    pub width: u32,
    pub height: u32,
    pub pixels: RgbaImage,
}

impl SkinBitmap {
    pub fn new(img: RgbaImage) -> Self {
        Self {
            width: img.width(),
            height: img.height(),
            pixels: img,
        }
    }
}

fn skin_filename(kind: CursorSkin) -> &'static str {
    match kind {
        CursorSkin::MacDefault => "mac-default.png",
        CursorSkin::WinDefault => "win-default.png",
        CursorSkin::Dark => "dark.png",
        CursorSkin::Light => "light.png",
        CursorSkin::BigArrow => "big-arrow.png",
    }
}

/// Resolve the absolute path to a bundled cursor-skin PNG.
///
/// Resolution: `CARGO_MANIFEST_DIR` (= `crates/effects`) → up two → `assets/cursor-skins/<name>.png`.
pub fn skin_path(kind: CursorSkin) -> PathBuf {
    let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    p.pop(); // crates/effects -> crates
    p.pop(); // crates -> repo root
    p.push("assets");
    p.push("cursor-skins");
    p.push(skin_filename(kind));
    p
}

/// Load a bundled cursor skin into an RGBA bitmap.
pub fn load_skin(kind: CursorSkin) -> Result<SkinBitmap, EffectsError> {
    let path = skin_path(kind);
    load_skin_from_path(&path)
}

/// Load an arbitrary PNG as a cursor skin. Used by tests with custom fixtures
/// and by the public [`load_skin`].
pub fn load_skin_from_path(path: &Path) -> Result<SkinBitmap, EffectsError> {
    let img = image::open(path)
        .map_err(|e| EffectsError::Io(std::io::Error::new(std::io::ErrorKind::InvalidData, e)))?;
    Ok(SkinBitmap::new(img.to_rgba8()))
}

/// Multiply RGB channels by the tint (alpha channel preserved). A white tint
/// `Rgba{255,255,255,255}` returns the bitmap unchanged.
pub fn apply_tint(skin: &SkinBitmap, tint: Rgba) -> SkinBitmap {
    let (w, h) = (skin.width, skin.height);
    let tr = tint.r as f32 / 255.0;
    let tg = tint.g as f32 / 255.0;
    let tb = tint.b as f32 / 255.0;
    let mut out: RgbaImage = ImageBuffer::new(w, h);
    for (x, y, px) in skin.pixels.enumerate_pixels() {
        let [r, g, b, a] = px.0;
        let nr = (r as f32 * tr).round().min(255.0) as u8;
        let ng = (g as f32 * tg).round().min(255.0) as u8;
        let nb = (b as f32 * tb).round().min(255.0) as u8;
        out.put_pixel(x, y, ImageRgba([nr, ng, nb, a]));
    }
    SkinBitmap::new(out)
}

/// Resize a skin by `scale` via triangle filter (matches Tailwind-era
/// general-purpose downscale; good default for cursor art).
pub fn resize(skin: &SkinBitmap, scale: f32) -> SkinBitmap {
    let new_w = ((skin.width as f32) * scale).round().max(1.0) as u32;
    let new_h = ((skin.height as f32) * scale).round().max(1.0) as u32;
    let resized = image::imageops::resize(
        &skin.pixels,
        new_w,
        new_h,
        image::imageops::FilterType::Triangle,
    );
    SkinBitmap::new(resized)
}
