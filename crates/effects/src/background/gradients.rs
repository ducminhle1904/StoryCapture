//! Gradient preset registry + PNG asset loader.
//!
//! The 10 curated presets ship as 1920x1080 PNGs committed at
//! `<repo>/assets/gradient-presets/<id>.png`. Regenerate with
//! `cargo run -p effects --example gen_gradient_presets`.
//!
//! Preset IDs are stable; they survive into `.scpreset` files as the
//! `BackgroundKind::Gradient.preset_id` string. Unknown IDs surface as
//! `EffectsError::UnknownGradient` — they never become filesystem paths
//! (T-02-21 mitigation).

use std::path::{Path, PathBuf};

use image::RgbaImage;

use crate::error::EffectsError;

/// Static descriptor for one gradient preset.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GradientPreset {
    pub id: &'static str,
    pub display_name: &'static str,
    /// Path relative to the repository root, e.g. `"assets/gradient-presets/runway-dark.png"`.
    pub asset_rel_path: &'static str,
    pub tags: &'static [&'static str],
}

/// Canonical curated list. Order is stable; new presets append.
pub const GRADIENT_PRESETS: &[GradientPreset] = &[
    GradientPreset {
        id: "runway-dark",
        display_name: "Runway Dark",
        asset_rel_path: "assets/gradient-presets/runway-dark.png",
        tags: &["dark", "cinematic", "primary"],
    },
    GradientPreset {
        id: "runway-light",
        display_name: "Runway Light",
        asset_rel_path: "assets/gradient-presets/runway-light.png",
        tags: &["light", "cinematic"],
    },
    GradientPreset {
        id: "linear-slate",
        display_name: "Linear Slate",
        asset_rel_path: "assets/gradient-presets/linear-slate.png",
        tags: &["dark", "minimal", "editor"],
    },
    GradientPreset {
        id: "elevenlabs-violet",
        display_name: "ElevenLabs Violet",
        asset_rel_path: "assets/gradient-presets/elevenlabs-violet.png",
        tags: &["violet", "timeline"],
    },
    GradientPreset {
        id: "warm-sunset",
        display_name: "Warm Sunset",
        asset_rel_path: "assets/gradient-presets/warm-sunset.png",
        tags: &["warm", "demo"],
    },
    GradientPreset {
        id: "cool-ocean",
        display_name: "Cool Ocean",
        asset_rel_path: "assets/gradient-presets/cool-ocean.png",
        tags: &["cool", "tech"],
    },
    GradientPreset {
        id: "forest-emerald",
        display_name: "Forest Emerald",
        asset_rel_path: "assets/gradient-presets/forest-emerald.png",
        tags: &["green", "eco"],
    },
    GradientPreset {
        id: "solid-black",
        display_name: "Solid Black",
        asset_rel_path: "assets/gradient-presets/solid-black.png",
        tags: &["solid", "minimal"],
    },
    GradientPreset {
        id: "solid-white",
        display_name: "Solid White",
        asset_rel_path: "assets/gradient-presets/solid-white.png",
        tags: &["solid", "print"],
    },
    GradientPreset {
        id: "paper-grain",
        display_name: "Paper Grain",
        asset_rel_path: "assets/gradient-presets/paper-grain.png",
        tags: &["textured", "documentary"],
    },
];

/// Look up a preset by id.
pub fn lookup(id: &str) -> Option<&'static GradientPreset> {
    GRADIENT_PRESETS.iter().find(|p| p.id == id)
}

/// Resolve the absolute filesystem path of `preset.asset_rel_path` relative to
/// the repository root. The repo root is located by walking up from
/// `CARGO_MANIFEST_DIR` (crates/effects) two levels.
pub fn resolve_asset_path(preset: &GradientPreset) -> PathBuf {
    let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    p.pop(); // crates/effects -> crates
    p.pop(); // crates -> repo root
    p.push(preset.asset_rel_path);
    p
}

/// Load the preset PNG from disk as an RgbaImage.
pub fn load_gradient_png(preset: &GradientPreset) -> Result<RgbaImage, EffectsError> {
    let path = resolve_asset_path(preset);
    load_png_at(&path)
}

/// Internal: load any PNG path as RgbaImage.
pub fn load_png_at(path: &Path) -> Result<RgbaImage, EffectsError> {
    let img = image::open(path)?;
    Ok(img.to_rgba8())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gradient_presets_count() {
        assert_eq!(GRADIENT_PRESETS.len(), 10);
    }

    #[test]
    fn gradient_preset_ids_stable() {
        let expected = [
            "runway-dark",
            "runway-light",
            "linear-slate",
            "elevenlabs-violet",
            "warm-sunset",
            "cool-ocean",
            "forest-emerald",
            "solid-black",
            "solid-white",
            "paper-grain",
        ];
        let actual: Vec<&str> = GRADIENT_PRESETS.iter().map(|p| p.id).collect();
        assert_eq!(actual, expected);
    }

    #[test]
    fn lookup_known_and_unknown() {
        assert!(lookup("runway-dark").is_some());
        assert!(lookup("does-not-exist").is_none());
    }

    #[test]
    fn load_gradient_png_each() {
        for preset in GRADIENT_PRESETS {
            let img = load_gradient_png(preset)
                .unwrap_or_else(|e| panic!("failed to load {}: {e}", preset.id));
            assert!(
                img.width() >= 1920 && img.height() >= 1080,
                "{} must be >= 1920x1080, got {}x{}",
                preset.id,
                img.width(),
                img.height()
            );
        }
    }

    #[test]
    fn manifest_json_parses() {
        let mut p = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        p.pop();
        p.pop();
        p.push("assets/gradient-presets/manifest.json");
        let raw = std::fs::read_to_string(&p).expect("manifest.json must exist");
        let v: serde_json::Value = serde_json::from_str(&raw).expect("manifest must parse");
        let presets = v
            .get("presets")
            .and_then(|p| p.as_array())
            .expect("manifest.presets array");
        assert_eq!(presets.len(), 10);
        let ids: Vec<String> = presets
            .iter()
            .filter_map(|p| p.get("id").and_then(|s| s.as_str()).map(String::from))
            .collect();
        for preset in GRADIENT_PRESETS {
            assert!(
                ids.iter().any(|i| i == preset.id),
                "missing {} in manifest",
                preset.id
            );
        }
    }
}
