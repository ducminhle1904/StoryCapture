//! Bundled-font resolution plus drawtext path mitigation.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use crate::error::{EffectsError, Result};

/// Memoized workspace fonts directory.
static WORKSPACE_FONTS_DIR: OnceLock<PathBuf> = OnceLock::new();

/// Bundled font variants shipped with StoryCapture.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum BundledFont {
    GeistSansRegular,
    GeistSansBold,
    JetBrainsMonoRegular,
    InterDisplay,
    SpaceGroteskDisplay,
}

/// The bundled font file names.
pub const BUNDLED_FONT_FILES: [&str; 5] = [
    "Geist-Regular.ttf",
    "Geist-Bold.ttf",
    "JetBrainsMono-Regular.ttf",
    "Inter-Display.ttf",
    "SpaceGrotesk-Display.ttf",
];

/// Return the file name for a bundled font.
pub fn font_filename_for(choice: BundledFont) -> &'static str {
    match choice {
        BundledFont::GeistSansRegular => BUNDLED_FONT_FILES[0],
        BundledFont::GeistSansBold => BUNDLED_FONT_FILES[1],
        BundledFont::JetBrainsMonoRegular => BUNDLED_FONT_FILES[2],
        BundledFont::InterDisplay => BUNDLED_FONT_FILES[3],
        BundledFont::SpaceGroteskDisplay => BUNDLED_FONT_FILES[4],
    }
}

impl BundledFont {
    /// Map `(family, weight)` to a bundled file.
    pub fn from_family_weight(family: &str, weight: u16) -> Self {
        let fam = family.to_ascii_lowercase();
        match (fam.as_str(), weight) {
            ("geist", w) if w >= 700 => BundledFont::GeistSansBold,
            ("geist", _) => BundledFont::GeistSansRegular,
            ("jetbrains mono", _) | ("jetbrainsmono", _) => BundledFont::JetBrainsMonoRegular,
            ("inter", _) | ("inter display", _) => BundledFont::InterDisplay,
            ("space grotesk", _) | ("spacegrotesk", _) => BundledFont::SpaceGroteskDisplay,
            _ => BundledFont::GeistSansRegular,
        }
    }

    /// File name shipped under `assets/fonts/`.
    pub fn file_name(self) -> &'static str {
        font_filename_for(self)
    }
}

/// Locate the repo's `assets/fonts/` directory.
fn workspace_fonts_dir() -> Result<PathBuf> {
    if let Some(cached) = WORKSPACE_FONTS_DIR.get() {
        return Ok(cached.clone());
    }

    // Prefer CARGO_MANIFEST_DIR, then CWD.
    let start: PathBuf = std::env::var_os("CARGO_MANIFEST_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));

    let mut cursor = start.as_path();
    let resolved = loop {
        let candidate = cursor.join("assets").join("fonts");
        if candidate.is_dir() {
            break candidate;
        }
        match cursor.parent() {
            Some(p) => cursor = p,
            None => {
                return Err(EffectsError::InvalidPath);
            }
        }
    };
    // `set` may race; the stored value is canonical either way.
    let stored = WORKSPACE_FONTS_DIR.get_or_init(|| resolved);
    Ok(stored.clone())
}

/// Resolve the on-disk path for a bundled font.
pub fn resolve_bundled_font_path(choice: BundledFont) -> Result<PathBuf> {
    resolve_bundled_font_path_by_name(choice.file_name())
}

/// Resolve a bundled font by filename.
pub fn resolve_bundled_font_path_by_name(name: &str) -> Result<PathBuf> {
    let dir = workspace_fonts_dir()?;
    let p = dir.join(name);
    if !p.exists() {
        return Err(EffectsError::UnsupportedImageFormat(format!(
            "missing bundled font: {}",
            name
        )));
    }
    Ok(p)
}

/// Copy the bundled TTFs into a UUID-named subdir with no spaces.
pub fn ensure_fonts_extracted(into: &Path) -> Result<PathBuf> {
    // UUID simple form is 32 hex chars.
    let sub = format!("storycapture_fonts_{}", uuid::Uuid::new_v4().simple());
    let target = into.join(sub);
    std::fs::create_dir_all(&target)?;
    for name in BUNDLED_FONT_FILES.iter() {
        let src = resolve_bundled_font_path_by_name(name)?;
        std::fs::copy(&src, target.join(name))?;
    }
    Ok(target)
}
