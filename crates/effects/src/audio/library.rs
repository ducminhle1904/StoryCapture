//! Bundled sound-library manifest loader.
//!
//! Reads `assets/sound-library/manifest.json` — the index of every bundled
//! SFX + BGM file. Shape is mirrored by `storage::repos::sound_library_repo`
//! (Plan 03 `sync_from_manifest`). The on-disk format is intentionally simple
//! JSON so a human curator can diff it after replacing sounds.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::EffectsError;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SoundCategory {
    Sfx,
    Bgm,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SoundEntry {
    /// Logical id, e.g. `"click"` or `"chill-1"`.
    pub id: String,
    pub category: SoundCategory,
    /// Filename relative to `{category}/` — e.g. `"click.wav"` lives at
    /// `assets/sound-library/sfx/click.wav`.
    pub file: String,
    /// Actual audio duration in milliseconds (measured, not guessed).
    pub duration_ms: u32,
    /// SPDX-style short licence code: `"CC0"`, `"CC-BY-4.0"`.
    pub license: String,
    /// URL of the source asset page (Pixabay / Freesound / Mixkit / ...).
    pub source_url: String,
    /// Author handle as listed on the source site (may be empty for CC0).
    pub author: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SoundManifest {
    /// Manifest schema version; bump on breaking layout changes.
    pub version: u32,
    pub entries: Vec<SoundEntry>,
}

impl SoundManifest {
    /// Returns the absolute (sound-root relative) filesystem path for an entry.
    pub fn file_path(&self, entry: &SoundEntry, sound_root: &Path) -> PathBuf {
        let dir = match entry.category {
            SoundCategory::Sfx => "sfx",
            SoundCategory::Bgm => "bgm",
        };
        sound_root.join(dir).join(&entry.file)
    }
}

/// Load `manifest.json` from the given `sound_root` directory.
pub fn load_manifest(sound_root: &Path) -> Result<SoundManifest, EffectsError> {
    let path = sound_root.join("manifest.json");
    let bytes = fs::read(&path)?;
    let manifest: SoundManifest = serde_json::from_slice(&bytes)?;
    Ok(manifest)
}
