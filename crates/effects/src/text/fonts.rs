//! Bundled-font resolution (5 SIL-OFL TTFs) + Pitfall #8 mitigation.
//!
//! The Pitfall #8 in question is the FFmpeg `drawtext` filter's refusal
//! to accept paths containing spaces OR literal Windows-style backslashes.
//! `drawtext`'s arg grammar treats `\` as an escape introducer and uses
//! unquoted space-delimited tokens for some builds. The only portable
//! workaround is to:
//!
//!   1. Copy the bundled TTF into a directory whose absolute path is
//!      guaranteed to contain no spaces (a UUID-named subdir of the
//!      OS temp dir).
//!   2. Emit the final path with **forward slashes only**, even on
//!      Windows — FFmpeg accepts `C:/Users/...` on every platform.
//!
//! The 5 bundled fonts live at `<repo>/assets/fonts/*.ttf` and are
//! licenced under the SIL OFL (see `assets/fonts/LICENSES.md`).

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use crate::error::{EffectsError, Result};

/// Memoised workspace fonts directory. The walk in [`workspace_fonts_dir`]
/// is idempotent (takes no parameters, hits the filesystem repeatedly),
/// so caching the result for the process lifetime is safe and saves a
/// directory walk on every font resolution call. [`ensure_fonts_extracted`]
/// is intentionally NOT memoised — it writes a new UUID-named subdir
/// under a caller-supplied parent on every invocation.
static WORKSPACE_FONTS_DIR: OnceLock<PathBuf> = OnceLock::new();

/// The 5 bundled font variants shipped with StoryCapture.
///
/// This is a text-module-internal helper — the AST's canonical
/// [`crate::ast::video::FontChoice`] keeps a `Bundled { family, weight }`
/// shape so user presets can reference arbitrary family/weight pairs
/// that later ship as additional bundles. The text emitter maps
/// `FontChoice::Bundled { family, weight }` down to a `BundledFont`
/// via [`BundledFont::from_family_weight`], or falls back to
/// `GeistSansRegular` when the pair doesn't match a shipped file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum BundledFont {
    GeistSansRegular,
    GeistSansBold,
    JetBrainsMonoRegular,
    InterDisplay,
    SpaceGroteskDisplay,
}

/// The 5 file names shipped under `assets/fonts/`. Order matches
/// `BundledFont`'s declaration order.
pub const BUNDLED_FONT_FILES: [&str; 5] = [
    "Geist-Regular.ttf",
    "Geist-Bold.ttf",
    "JetBrainsMono-Regular.ttf",
    "Inter-Display.ttf",
    "SpaceGrotesk-Display.ttf",
];

/// Return the bundled file name for a `BundledFont`.
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
    /// Map the AST's `(family, weight)` pair to a bundled file. Returns
    /// `GeistSansRegular` for any unknown pair so downstream emission
    /// never fails on an unbundled choice — missing fonts surface
    /// through [`resolve_bundled_font_path`] instead.
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

/// Locate the repo's `assets/fonts/` directory. Walks up from
/// `CARGO_MANIFEST_DIR` (or CWD) until it finds an `assets/fonts`
/// child. In the typical layout that's the workspace root.
fn workspace_fonts_dir() -> Result<PathBuf> {
    if let Some(cached) = WORKSPACE_FONTS_DIR.get() {
        return Ok(cached.clone());
    }

    // Prefer CARGO_MANIFEST_DIR (stable during `cargo test`). Fall back
    // to CWD.
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
    // `set` may race with another thread resolving first; either way the
    // stored value is canonical for the process, so propagate it.
    let stored = WORKSPACE_FONTS_DIR.get_or_init(|| resolved);
    Ok(stored.clone())
}

/// Resolve the on-disk path for a bundled font. Returns
/// `EffectsError::UnsupportedImageFormat` if the TTF is missing — the
/// caller usually responds by running `./scripts/download-fonts.sh`.
pub fn resolve_bundled_font_path(choice: BundledFont) -> Result<PathBuf> {
    resolve_bundled_font_path_by_name(choice.file_name())
}

/// Same as [`resolve_bundled_font_path`] but by filename, used by the
/// extraction routine which iterates over `BUNDLED_FONT_FILES`.
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

/// Copy all 5 bundled TTFs into a UUID-named subdir of `into` that is
/// guaranteed to contain no spaces (Pitfall #8).
///
/// Returns the absolute path to the new subdir. Callers pass the subdir
/// to [`super::drawtext::emit_drawtext`] which joins `<dir>/<filename>`
/// and runs it through [`super::drawtext::path_to_ffmpeg_arg`].
pub fn ensure_fonts_extracted(into: &Path) -> Result<PathBuf> {
    // UUID simple form is 32 hex chars — no spaces, no special chars.
    let sub = format!("storycapture_fonts_{}", uuid::Uuid::new_v4().simple());
    let target = into.join(sub);
    std::fs::create_dir_all(&target)?;
    for name in BUNDLED_FONT_FILES.iter() {
        let src = resolve_bundled_font_path_by_name(name)?;
        std::fs::copy(&src, target.join(name))?;
    }
    Ok(target)
}
