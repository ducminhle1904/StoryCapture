//! Effect preset model — mirrors the `effect_presets` table.
//!
//! `ast_json` is stored as an opaque string so the storage crate stays
//! decoupled from `crates/effects`. Call-sites deserialize into
//! `effects::Graph` at their own boundary.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Which tier holds this preset. 'project' → project.sqlite;
/// 'global' → app.sqlite. Mirrors the CHECK constraint on `effect_presets.scope`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PresetTier {
    Project,
    Global,
}

impl PresetTier {
    pub fn as_str(&self) -> &'static str {
        match self {
            PresetTier::Project => "project",
            PresetTier::Global => "global",
        }
    }
    pub fn parse(s: &str) -> Result<Self, String> {
        match s {
            "project" => Ok(PresetTier::Project),
            "global" => Ok(PresetTier::Global),
            other => Err(format!("unknown preset tier: {other}")),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct EffectPreset {
    pub id: Uuid,
    pub scope: PresetTier,
    pub name: String,
    pub description: String,
    pub ast_json: String,
    pub version: u32,
    pub bundled: bool,
    pub created_at: i64,
    pub author: Option<String>,
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewEffectPreset {
    /// If supplied, used as the row id (useful for bundled presets whose id
    /// is baked into the .scpreset file so INSERT OR IGNORE is idempotent).
    /// Otherwise a new UUID v7 is generated.
    pub id: Option<Uuid>,
    pub scope: PresetTier,
    pub name: String,
    pub description: String,
    pub ast_json: String,
    pub version: u32,
    pub bundled: bool,
    pub author: Option<String>,
    pub tags: Vec<String>,
}
