//! Sound library catalog entry.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SoundCategory {
    Sfx,
    Bgm,
}

impl SoundCategory {
    pub fn as_str(&self) -> &'static str {
        match self {
            SoundCategory::Sfx => "sfx",
            SoundCategory::Bgm => "bgm",
        }
    }
    pub fn parse(s: &str) -> Result<Self, String> {
        match s {
            "sfx" => Ok(SoundCategory::Sfx),
            "bgm" => Ok(SoundCategory::Bgm),
            other => Err(format!("unknown sound category: {other}")),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SoundLibraryEntry {
    pub id: Uuid,
    pub category: SoundCategory,
    pub name: String,
    pub file_path: PathBuf,
    pub duration_ms: u64,
    pub waveform_peaks: Option<Vec<u8>>,
    pub license: String,
    pub source_url: Option<String>,
    pub author: Option<String>,
    pub bundled: bool,
}
